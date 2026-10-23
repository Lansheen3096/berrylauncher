import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { ResourceExportResult, ResourceUsage, SlimResult } from '../shared/types'
import type { SettingsStore } from './settings'
import type { Reporter } from './tasks'
import { dataDir, ensureDir } from './paths'
import { sha1File } from './download'
import { readJsonFile, writeFileAtomic } from './net'
import { log } from './logger'

type ResourceKind = 'mods' | 'resourcepacks' | 'shaderpacks'

export interface ResourceTarget {
  instanceId: string
  baseDir: string
  dirs: { kind: ResourceKind; path: string }[]
}

export interface ResourceRecord {
  baseSha1: string
  sha1: string
  linked: boolean
  updatedAt: number
}

interface Manifest {
  version: 1
  files: Record<string, ResourceRecord>
}

interface StoreIndex {
  version: 1
  entries: Record<string, { size: number; createdAt: number }>
}

interface ScanCache {
  version: 1
  files: Record<string, { size: number; mtime: number; sha1: string }>
}

const SMALL_FILE = 64 * 1024
const STOREABLE = /\.(jar|zip)(\.disabled)?$/i

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export class ResourceStore {
  private index: StoreIndex = { version: 1, entries: {} }
  private cache: ScanCache = { version: 1, files: {} }
  private loaded = false

  constructor(private readonly settings: SettingsStore) {}

  private root(): string {
    return path.join(dataDir(), 'resources')
  }

  private indexPath(): string {
    return path.join(this.root(), 'index.json')
  }

  private cachePath(): string {
    return path.join(dataDir(), 'cache', 'resource-scan.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    ensureDir(this.root())
    const index = readJsonFile<StoreIndex>(this.indexPath())
    if (index?.version === 1) this.index = index
    const cache = readJsonFile<ScanCache>(this.cachePath())
    if (cache?.version === 1) this.cache = cache
    // Rebuild index entries if files were added outside the launcher.
    try {
      for (const file of fs.readdirSync(this.root())) {
        if (!/^[0-9a-f]{40}$/i.test(file)) continue
        if (!this.index.entries[file]) {
          const stat = fs.statSync(path.join(this.root(), file))
          this.index.entries[file] = { size: stat.size, createdAt: stat.birthtimeMs || Date.now() }
        }
      }
    } catch {
      /* ignore */
    }
  }

  private saveIndex(): void {
    ensureDir(path.dirname(this.indexPath()))
    writeFileAtomic(this.indexPath(), JSON.stringify(this.index, null, 2))
  }

  private saveCache(): void {
    ensureDir(path.dirname(this.cachePath()))
    writeFileAtomic(this.cachePath(), JSON.stringify(this.cache, null, 2))
  }

  storePath(hash: string): string {
    return path.join(this.root(), hash.toLowerCase())
  }

  /** Hardlinks only work on the same volume; check before doing extra I/O. */
  canHardlink(target: string): boolean {
    try {
      ensureDir(this.root())
      const a = fs.statSync(target)
      const b = fs.statSync(this.root())
      return a.dev === b.dev
    } catch {
      return false
    }
  }

  removeLink(file: string): void {
    this.remove(file)
  }

  has(hash: string, size?: number): boolean {
    this.load()
    const file = this.storePath(hash)
    try {
      const stat = fs.statSync(file)
      return stat.size > 0 && (size === undefined || stat.size === size)
    } catch {
      return false
    }
  }

  private async hashCached(file: string): Promise<string> {
    const stat = fs.statSync(file)
    const cached = this.cache.files[file]
    if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) return cached.sha1
    const sha1 = await sha1File(file)
    this.cache.files[file] = { size: stat.size, mtime: stat.mtimeMs, sha1 }
    return sha1
  }

  private chmodWritable(file: string): void {
    try {
      fs.chmodSync(file, 0o644)
    } catch {
      /* ignore */
    }
  }

  private chmodReadOnly(file: string): void {
    try {
      fs.chmodSync(file, 0o444)
    } catch {
      /* ignore */
    }
  }

  private remove(file: string): void {
    this.chmodWritable(file)
    try {
      fs.unlinkSync(file)
    } catch (err) {
      log.warn('failed to remove resource', file, err)
    }
  }

  /** Move/copy a verified file into the store (read-only). */
  async importToStore(src: string, expectedSha1?: string): Promise<string> {
    this.load()
    const sha1 = expectedSha1 ?? (await sha1File(src))
    if (expectedSha1) {
      const actual = await sha1File(src)
      if (actual !== expectedSha1) throw new Error(`资源校验失败：期望 ${expectedSha1}，实际 ${actual}`)
    }
    const store = this.storePath(sha1)
    const stat = fs.statSync(src)
    if (fs.existsSync(store) && fs.statSync(store).size === stat.size) {
      return sha1
    }
    ensureDir(this.root())
    const tmp = `${store}.tmp-${process.pid}-${Date.now()}`
    try {
      fs.copyFileSync(src, tmp)
      this.chmodReadOnly(tmp)
      fs.renameSync(tmp, store)
    } catch (err) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw err
    }
    this.index.entries[sha1] = { size: stat.size, createdAt: Date.now() }
    this.saveIndex()
    return sha1
  }

  /** Link a stored file into an instance; falls back to a read-only copy. */
  linkInto(hash: string, dest: string): 'link' | 'copy' {
    this.load()
    const store = this.storePath(hash)
    if (!fs.existsSync(store)) throw new Error('资源实体不存在')
    ensureDir(path.dirname(dest))
    if (fs.existsSync(dest)) this.remove(dest)
    try {
      fs.linkSync(store, dest)
      return 'link'
    } catch (err) {
      log.warn('hardlink failed, copying instead', dest, err)
      fs.copyFileSync(store, dest)
      this.chmodReadOnly(dest)
      return 'copy'
    }
  }

  /** Replace an existing instance file with a link to (or copy of) the store. */
  async adopt(file: string, target: ResourceTarget, kind: ResourceKind): Promise<{ linked: boolean; saved: boolean }> {
    const stat = fs.statSync(file)
    if (stat.nlink > 1) return { linked: true, saved: false }
    const sha1 = await this.hashCached(file)
    if (fs.existsSync(this.storePath(sha1)) && fs.statSync(this.storePath(sha1)).size !== stat.size) {
      this.remove(this.storePath(sha1))
    }
    const existed = fs.existsSync(this.storePath(sha1))
    if (!existed) await this.importToStore(file, sha1)
    if (fs.existsSync(file)) this.remove(file)
    const mode = this.linkInto(sha1, file)
    this.record(target, kind, path.basename(file), sha1, mode === 'link')
    return { linked: mode === 'link', saved: existed }
  }

  private manifestPath(instanceId: string): string {
    return path.join(dataDir(), 'manifests', `${safeName(instanceId)}.json`)
  }

  private readManifest(instanceId: string): Manifest {
    return readJsonFile<Manifest>(this.manifestPath(instanceId)) ?? { version: 1, files: {} }
  }

  record(target: ResourceTarget, kind: ResourceKind, filename: string, sha1: string, linked: boolean): void {
    const manifest = this.readManifest(target.instanceId)
    manifest.files[`${kind}/${filename}`] = {
      baseSha1: sha1,
      sha1,
      linked,
      updatedAt: Date.now(),
    }
    ensureDir(path.dirname(this.manifestPath(target.instanceId)))
    writeFileAtomic(this.manifestPath(target.instanceId), JSON.stringify(manifest, null, 2))
  }

  async slim(targets: ResourceTarget[], reporter?: Reporter): Promise<SlimResult> {
    this.load()
    const result: SlimResult = { scanned: 0, linked: 0, moved: 0, savedBytes: 0, skipped: 0, errors: [] }
    const seenDirs = new Set<string>()
    const files: { file: string; target: ResourceTarget; kind: ResourceKind }[] = []
    for (const target of targets) {
      for (const dir of target.dirs) {
        if (seenDirs.has(dir.path)) continue
        seenDirs.add(dir.path)
        if (!fs.existsSync(dir.path)) continue
        if (!this.canHardlink(dir.path)) {
          result.errors.push(`跨卷无法去重：${dir.path}`)
          continue
        }
        let names: string[] = []
        try {
          names = fs.readdirSync(dir.path)
        } catch {
          continue
        }
        for (const name of names) {
          const full = path.join(dir.path, name)
          try {
            const stat = fs.statSync(full)
            if (!stat.isFile() || stat.size < SMALL_FILE || !STOREABLE.test(name)) continue
            files.push({ file: full, target, kind: dir.kind })
          } catch {
            /* ignore */
          }
        }
      }
    }

    const total = files.length
    let done = 0
    for (const item of files) {
      reporter?.throwIfCancelled()
      done++
      reporter?.set({
        detail: `整理资源 ${done}/${total}`,
        progress: total > 0 ? done / total : null,
      })
      try {
        const stat = fs.statSync(item.file)
        if (stat.nlink > 1) {
          result.skipped++
          continue
        }
        result.scanned++
        const sha1 = await this.hashCached(item.file)
        const store = this.storePath(sha1)
        if (!fs.existsSync(store)) {
          // Store and link back; move keeps disk usage neutral.
          const tmp = `${store}.tmp-${process.pid}`
          ensureDir(this.root())
          try {
            fs.renameSync(item.file, tmp)
          } catch {
            fs.copyFileSync(item.file, tmp)
            this.remove(item.file)
          }
          this.chmodReadOnly(tmp)
          fs.renameSync(tmp, store)
          this.index.entries[sha1] = { size: stat.size, createdAt: Date.now() }
          const mode = this.linkInto(sha1, item.file)
          this.record(item.target, item.kind, path.basename(item.file), sha1, mode === 'link')
          result.moved++
          if (mode === 'copy') result.errors.push(`跨卷无法硬链接：${item.file}`)
        } else {
          this.remove(item.file)
          const mode = this.linkInto(sha1, item.file)
          this.record(item.target, item.kind, path.basename(item.file), sha1, mode === 'link')
          if (mode === 'link') {
            result.linked++
            result.savedBytes += stat.size
          } else {
            result.errors.push(`跨卷无法硬链接：${item.file}`)
          }
        }
      } catch (err) {
        result.errors.push(`${item.file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.saveIndex()
    this.saveCache()
    return result
  }

  usage(): ResourceUsage {
    this.load()
    let storeBytes = 0
    let linkedFiles = 0
    let savedBytes = 0
    let storeFiles = 0
    for (const [hash, entry] of Object.entries(this.index.entries)) {
      const store = this.storePath(hash)
      try {
        const stat = fs.statSync(store)
        storeFiles++
        storeBytes += stat.size
        const links = Math.max(0, (stat.nlink ?? 1) - 1)
        linkedFiles += links
        savedBytes += links * (entry.size || stat.size)
      } catch {
        delete this.index.entries[hash]
      }
    }
    return { storeBytes, storeFiles, linkedFiles, savedBytes, copyFallback: 0 }
  }

  gc(): { freedBytes: number; removed: number } {
    this.load()
    let freedBytes = 0
    let removed = 0
    for (const [hash, entry] of Object.entries(this.index.entries)) {
      const store = this.storePath(hash)
      try {
        const stat = fs.statSync(store)
        if ((stat.nlink ?? 1) <= 1) {
          this.remove(store)
          delete this.index.entries[hash]
          freedBytes += entry.size || stat.size
          removed++
        }
      } catch {
        delete this.index.entries[hash]
      }
    }
    if (removed > 0) this.saveIndex()
    return { freedBytes, removed }
  }

  async exportResources(target: ResourceTarget): Promise<ResourceExportResult> {
    this.load()
    const manifest = this.readManifest(target.instanceId)
    const zip = new AdmZip()
    const exported: Manifest = { version: 1, files: {} }
    let bytes = 0
    for (const dir of target.dirs) {
      let names: string[] = []
      try {
        names = fs.readdirSync(dir.path)
      } catch {
        continue
      }
      for (const name of names) {
        const full = path.join(dir.path, name)
        let stat: fs.Stats
        try {
          stat = fs.statSync(full)
        } catch {
          continue
        }
        if (!stat.isFile() || !STOREABLE.test(name)) continue
        const key = `${dir.kind}/${name}`
        const current = await sha1File(full)
        const known = manifest.files[key]
        if (known && known.sha1 === current) continue
        zip.addLocalFile(full, dir.kind, name)
        exported.files[key] = {
          baseSha1: known?.baseSha1 ?? known?.sha1 ?? '',
          sha1: current,
          linked: false,
          updatedAt: Date.now(),
        }
        bytes += stat.size
      }
    }
    if (Object.keys(exported.files).length === 0) {
      throw new Error('这个实例没有检测到被修改或新增的资源')
    }
    zip.addFile('berry-resource-manifest.json', Buffer.from(JSON.stringify(exported, null, 2), 'utf8'))
    const dir = path.join(dataDir(), 'exports')
    ensureDir(dir)
    const file = path.join(dir, `${safeName(target.instanceId)}-resources-${Date.now()}.zip`)
    zip.writeZip(file)
    return { path: file, files: Object.keys(exported.files).length, bytes }
  }
}
