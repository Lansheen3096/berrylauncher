import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DownloadSource } from '../shared/types'
import { ensureDir } from './paths'
import { request, writeFileAtomic } from './net'
import { log } from './logger'

export interface FileTask {
  url: string
  dest: string
  sha1?: string
  size?: number
  label?: string
}

export interface DownloadProgress {
  received: number
  total: number
  filesDone: number
  filesTotal: number
}

export class AbortError extends Error {
  constructor() {
    super('已取消')
    this.name = 'AbortError'
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError()
}

export function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return -1
  }
}

export function isFileIntact(task: Pick<FileTask, 'dest' | 'size'>): boolean {
  if (task.size === undefined) return false
  return fileSize(task.dest) === task.size
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Files at or above this size use parallel ranged downloads. */
const MULTI_THREAD_MIN = 4 * 1024 * 1024
const MAX_SEGMENTS = 4
const SEGMENT_TARGET = 16 * 1024 * 1024
const PART_SUFFIX = '.berry-part'

interface SegmentState {
  start: number
  end: number
  part: string
}

interface ResumeMeta {
  version: 1
  size: number
  sha1?: string
  segments: SegmentState[]
}

class RangeUnsupportedError extends Error {
  constructor() {
    super('服务器不支持 Range 请求')
    this.name = 'RangeUnsupportedError'
  }
}

export class Downloader {
  private received = 0
  private total = 0
  private filesDone = 0
  private filesTotal = 0
  private lastEmit = 0
  private resumedCredited = new Set<string>()

  constructor(
    private readonly opts: {
      concurrency: number
      source: DownloadSource
      signal?: AbortSignal
      onProgress?: (p: DownloadProgress) => void
      /** Parallel connections for one large file, capped at 4. */
      threads?: number
    },
  ) {}

  get progress(): DownloadProgress {
    return {
      received: this.total > 0 ? Math.min(this.received, this.total) : this.received,
      total: this.total,
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
    }
  }

  private emit(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 150) return
    this.lastEmit = now
    this.opts.onProgress?.(this.progress)
  }

  /** Downloads every missing file, skipping files whose size already matches. */
  async run(tasks: FileTask[]): Promise<void> {
    const pending: FileTask[] = []
    this.filesTotal = tasks.length
    for (const task of tasks) {
      throwIfAborted(this.opts.signal)
      if (task.size !== undefined) {
        this.total += task.size
        if (isFileIntact(task)) {
          this.received += task.size
          this.filesDone++
          continue
        }
      }
      pending.push(task)
    }
    this.emit(true)

    let cursor = 0
    const workerCount = Math.max(1, Math.min(this.opts.concurrency, pending.length || 1))
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= pending.length) return
        const task = pending[index]
        throwIfAborted(this.opts.signal)
        await this.downloadOne(task)
        this.filesDone++
        this.emit()
      }
    })
    await Promise.all(workers)
    this.emit(true)
  }

  private async downloadOne(task: FileTask): Promise<void> {
    ensureDir(path.dirname(task.dest))
    if (task.size !== undefined && task.size >= MULTI_THREAD_MIN) {
      for (let attempt = 0; attempt < 3; attempt++) {
        throwIfAborted(this.opts.signal)
        try {
          await this.downloadMulti(task)
          return
        } catch (err) {
          if (this.opts.signal?.aborted || err instanceof AbortError) throw new AbortError()
          if (err instanceof RangeUnsupportedError) {
            log.warn('range unsupported, falling back to single stream', task.url)
            this.cleanupParts(task)
            await this.downloadSingle(task)
            return
          }
          log.warn('segmented download interrupted, parts kept for resume', task.url, err)
          if (attempt < 2) await sleep(700 * (attempt + 1))
        }
      }
      throw new Error(`分段下载失败: ${task.url}`)
    }
    await this.downloadSingle(task)
  }

  private partPath(dest: string): string {
    return `${dest}${PART_SUFFIX}`
  }

  private metaPath(dest: string): string {
    return `${dest}${PART_SUFFIX}.json`
  }

  private cleanupParts(task: FileTask): void {
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath(task.dest), 'utf8')) as ResumeMeta
      for (const segment of meta.segments) {
        try {
          fs.rmSync(segment.part, { force: true })
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(this.metaPath(task.dest), { force: true })
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(this.partPath(task.dest), { force: true })
    } catch {
      /* ignore */
    }
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      try {
        fs.rmSync(`${this.partPath(task.dest)}-${i}`, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Parallel ranged download with persistent per-segment parts.
   * The part size on disk is the source of truth, so a crash/restart resumes
   * from the last flushed byte instead of trusting a counter.
   */
  private async downloadMulti(task: FileTask): Promise<void> {
    const size = task.size
    if (!size) throw new Error('缺少文件大小')
    const base = this.partPath(task.dest)
    const metaFile = this.metaPath(task.dest)
    const existing = this.readMeta(task)
    let meta: ResumeMeta
    if (existing) {
      meta = existing
    } else {
      const threadCount = Math.max(1, Math.min(MAX_SEGMENTS, this.opts.threads ?? 4))
      const segmentCount = Math.max(1, Math.min(threadCount, Math.ceil(size / SEGMENT_TARGET)))
      const chunkSize = Math.ceil(size / segmentCount)
      const segments: SegmentState[] = []
      for (let i = 0; i < segmentCount; i++) {
        const start = i * chunkSize
        const end = Math.min(size - 1, start + chunkSize - 1)
        if (start > end) break
        segments.push({ start, end, part: `${base}-${i}` })
      }
      // A stale .part from the old single-stream downloader is not reusable.
      this.cleanupParts(task)
      meta = { version: 1, size, sha1: task.sha1, segments }
      writeFileAtomic(metaFile, JSON.stringify(meta, null, 2))
    }

    if (!this.resumedCredited.has(task.dest)) {
      const resumed = meta.segments.reduce((sum, segment) => sum + Math.max(0, fileSize(segment.part)), 0)
      this.received += Math.min(resumed, size)
      this.resumedCredited.add(task.dest)
    }

    let saveTimer: NodeJS.Timeout | null = null
    const saveMeta = () => {
      try {
        writeFileAtomic(metaFile, JSON.stringify(meta, null, 2))
      } catch {
        /* ignore */
      }
    }
    const scheduleSave = () => {
      if (saveTimer) return
      saveTimer = setTimeout(() => {
        saveTimer = null
        saveMeta()
      }, 1000)
    }

    try {
      await Promise.all(
        meta.segments.map(async (segment) => {
          const length = segment.end - segment.start + 1
          let done = Math.max(0, Math.min(fileSize(segment.part), length))
          if (fileSize(segment.part) > length) {
            fs.rmSync(segment.part, { force: true })
            done = 0
          }
          while (done < length) {
            throwIfAborted(this.opts.signal)
            const from = segment.start + done
            const res = await request(task.url, {
              signal: this.opts.signal,
              source: this.opts.source,
              timeoutMs: 300000,
              headers: { Range: `bytes=${from}-${segment.end}` },
            })
            if (res.status === 200) {
              await res.body?.cancel().catch(() => undefined)
              throw new RangeUnsupportedError()
            }
            if (res.status !== 206) throw new Error(`分段下载失败：HTTP ${res.status}`)
            const contentRange = res.headers.get('content-range')
            if (contentRange && !contentRange.startsWith(`bytes ${from}-`)) {
              await res.body?.cancel().catch(() => undefined)
              throw new Error(`Content-Range 不匹配: ${contentRange}`)
            }
            if (!res.body) throw new Error('分段响应为空')
            const stream = fs.createWriteStream(segment.part, { flags: done > 0 ? 'a' : 'w' })
            const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
            source.on('data', (chunk: Buffer) => {
              this.received += chunk.length
              done += chunk.length
              this.emit()
              scheduleSave()
            })
            try {
              await pipeline(source, stream, { signal: this.opts.signal })
            } finally {
              stream.destroy()
            }
            if (fileSize(segment.part) > length) throw new Error('分段文件超出预期大小')
          }
        }),
      )
      if (saveTimer) clearTimeout(saveTimer)
      await this.mergeSegments(task, meta)
    } catch (err) {
      if (saveTimer) clearTimeout(saveTimer)
      saveMeta()
      throw err
    }
  }

  private readMeta(task: FileTask): ResumeMeta | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaPath(task.dest), 'utf8')) as ResumeMeta
      if (raw.version !== 1 || raw.size !== task.size || raw.sha1 !== task.sha1) return null
      if (!Array.isArray(raw.segments) || raw.segments.length === 0) return null
      for (const segment of raw.segments) {
        if (!segment.part || segment.start < 0 || segment.end < segment.start) return null
      }
      return raw
    } catch {
      return null
    }
  }

  private async mergeSegments(task: FileTask, meta: ResumeMeta): Promise<void> {
    const merged = this.partPath(task.dest)
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(merged, { flags: 'w' })
      out.on('finish', resolve)
      out.on('error', reject)
      let index = 0
      const next = (): void => {
        if (index >= meta.segments.length) {
          out.end()
          return
        }
        const segment = meta.segments[index++]
        const input = fs.createReadStream(segment.part)
        input.on('error', reject)
        input.on('end', next)
        input.pipe(out, { end: false })
      }
      next()
    })
    this.finalize(task, merged)
    for (const segment of meta.segments) fs.rmSync(segment.part, { force: true })
    fs.rmSync(this.metaPath(task.dest), { force: true })
  }

  private async downloadSingle(task: FileTask): Promise<void> {
    const tmp = this.partPath(task.dest)
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfAborted(this.opts.signal)
      try {
        let offset = Math.max(0, fileSize(tmp))
        if (task.size !== undefined && offset > task.size) {
          fs.rmSync(tmp, { force: true })
          offset = 0
        }
        if (task.size !== undefined && offset === task.size) {
          this.finalize(task, tmp)
          return
        }
        const headers: Record<string, string> = {}
        if (offset > 0) headers.Range = `bytes=${offset}-`
        const res = await request(task.url, {
          signal: this.opts.signal,
          source: this.opts.source,
          timeoutMs: 300000,
          headers,
        })
        if (!res.body) throw new Error(`响应为空: ${task.url}`)
        const append = res.status === 206 && offset > 0
        if (offset > 0 && !append) offset = 0
        const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
        source.on('data', (chunk: Buffer) => {
          this.received += chunk.length
          if (task.size === undefined) this.total = Math.max(this.total, this.received)
          this.emit()
        })
        await pipeline(source, fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' }), {
          signal: this.opts.signal,
        })
        this.finalize(task, tmp)
        return
      } catch (err) {
        lastError = err
        if (this.opts.signal?.aborted) throw new AbortError()
        if (attempt < 2) await sleep(500 * (attempt + 1))
      }
    }
    log.error('download failed', task.url, lastError)
    throw lastError instanceof Error ? lastError : new Error(`下载失败: ${task.url}`)
  }

  private finalize(task: FileTask, tmp: string): void {
    if (task.size !== undefined && fileSize(tmp) !== task.size) {
      throw new Error(`文件大小不符: ${path.basename(task.dest)}`)
    }
    if (task.sha1) {
      const digest = sha1Sync(tmp)
      if (digest !== task.sha1) {
        this.cleanupParts(task)
        throw new Error(`SHA1 校验失败（期望 ${task.sha1}，实际 ${digest}）: ${path.basename(task.dest)}`)
      }
    }
    try {
      fs.rmSync(task.dest, { force: true })
    } catch {
      /* ignore */
    }
    fs.renameSync(tmp, task.dest)
  }
}

function sha1Sync(file: string): string {
  const hash = crypto.createHash('sha1')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const fd = fs.openSync(file, 'r')
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

export async function downloadFile(
  url: string,
  dest: string,
  source: DownloadSource,
  signal?: AbortSignal,
): Promise<void> {
  const downloader = new Downloader({ concurrency: 1, source, signal })
  await downloader.run([{ url, dest }])
}
