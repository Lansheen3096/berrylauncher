import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DownloadSource } from '../shared/types'
import { ensureDir } from './paths'
import { request } from './net'
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

export class Downloader {
  private received = 0
  private total = 0
  private filesDone = 0
  private filesTotal = 0
  private lastEmit = 0

  constructor(
    private readonly opts: {
      concurrency: number
      source: DownloadSource
      signal?: AbortSignal
      onProgress?: (p: DownloadProgress) => void
    },
  ) {}

  get progress(): DownloadProgress {
    return {
      received: this.received,
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
        this.received += task.size ?? 0
        this.filesDone++
        this.emit()
      }
    })
    await Promise.all(workers)
    this.emit(true)
  }

  private async downloadOne(task: FileTask): Promise<void> {
    ensureDir(path.dirname(task.dest))
    const tmp = `${task.dest}.part`
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfAborted(this.opts.signal)
      try {
        const res = await request(task.url, {
          signal: this.opts.signal,
          source: this.opts.source,
          timeoutMs: 60000,
        })
        if (!res.body) throw new Error(`响应为空: ${task.url}`)
        const hash = crypto.createHash('sha1')
        const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
        source.on('data', (chunk: Buffer) => {
          hash.update(chunk)
          // Files without a declared size still animate progress.
          if (task.size === undefined) {
            this.received += chunk.length
            this.total = Math.max(this.total, this.received)
            this.emit()
          }
        })
        await pipeline(source, fs.createWriteStream(tmp))
        const digest = hash.digest('hex')
        if (task.sha1 && digest !== task.sha1) {
          throw new Error(`SHA1 校验失败（期望 ${task.sha1}，实际 ${digest}）: ${path.basename(task.dest)}`)
        }
        if (task.size !== undefined && fileSize(tmp) !== task.size) {
          throw new Error(`文件大小不符: ${path.basename(task.dest)}`)
        }
        fs.renameSync(tmp, task.dest)
        return
      } catch (err) {
        lastError = err
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
        } catch {
          /* ignore */
        }
        if (this.opts.signal?.aborted) throw new AbortError()
        if (attempt < 2) await sleep(500 * (attempt + 1))
      }
    }
    log.error('download failed', task.url, lastError)
    throw lastError instanceof Error ? lastError : new Error(`下载失败: ${task.url}`)
  }
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
