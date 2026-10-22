import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { LoaderKind, ModpackInstallRequest, TaskUpdate } from '../shared/types'
import type { SettingsStore } from './settings'
import type { LoaderService } from './loaders'
import type { ModrinthService } from './modrinth'
import type { Reporter } from './tasks'
import { Downloader } from './download'
import { cacheDir, ensureDir, instanceDir } from './paths'
import { readJsonFile, writeFileAtomic } from './net'
import { readMeta, writeMeta } from './instances'
import { ensureDir as ensureDirPath, instancesDir, versionDir } from './paths'
import { log } from './logger'

interface MrpackFile {
  path: string
  hashes: { sha1?: string; sha512?: string }
  downloads: string[]
  fileSize?: number
  env?: { client?: 'required' | 'optional' | 'unsupported'; server?: string }
}

interface MrpackIndex {
  formatVersion: number
  game: string
  versionId: string
  name: string
  summary?: string
  files: MrpackFile[]
  dependencies: Record<string, string>
}

class ScaledReporter implements Reporter {
  constructor(
    private readonly inner: Reporter,
    private readonly from: number,
    private readonly to: number,
  ) {}

  get signal(): AbortSignal {
    return this.inner.signal
  }

  throwIfCancelled(): void {
    this.inner.throwIfCancelled()
  }

  set(patch: Partial<TaskUpdate>): void {
    this.inner.set(
      typeof patch.progress === 'number'
        ? { ...patch, progress: this.from + patch.progress * (this.to - this.from) }
        : patch,
    )
  }
}

function safeJoin(root: string, relative: string): string {
  const base = path.resolve(root)
  const target = path.resolve(base, relative)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`整合包包含非法路径：${relative}`)
  }
  return target
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || 'modpack'
}

function loaderFromManifest(deps: Record<string, string>): { loader: LoaderKind; version?: string; mcVersion: string } {
  const mcVersion = deps.minecraft
  if (!mcVersion) throw new Error('整合包缺少 minecraft 依赖')
  if (deps['fabric-loader']) return { loader: 'fabric', version: deps['fabric-loader'], mcVersion }
  if (deps['quilt-loader']) return { loader: 'quilt', version: deps['quilt-loader'], mcVersion }
  if (deps.neoforge) return { loader: 'neoforge', version: deps.neoforge, mcVersion }
  if (deps.forge) {
    const raw = deps.forge
    const version = raw.startsWith(`${mcVersion}-`) ? raw.slice(mcVersion.length + 1) : raw
    return { loader: 'forge', version, mcVersion }
  }
  return { loader: 'vanilla', mcVersion }
}

export class ModpackService {
  constructor(
    private readonly loaders: LoaderService,
    private readonly modrinth: ModrinthService,
    private readonly settings: SettingsStore,
  ) {}

  private renameVersionFolder(gameDir: string, from: string, to: string): void {
    const fromDir = versionDir(gameDir, from)
    const toDir = versionDir(gameDir, to)
    if (!fs.existsSync(fromDir)) throw new Error(`安装器没有生成版本目录 ${from}`)
    fs.renameSync(fromDir, toDir)
    const oldJson = path.join(toDir, `${from}.json`)
    const newJson = path.join(toDir, `${to}.json`)
    if (fs.existsSync(oldJson) && oldJson !== newJson) {
      const data = JSON.parse(fs.readFileSync(oldJson, 'utf8')) as { id?: string }
      data.id = to
      writeFileAtomic(newJson, JSON.stringify(data, null, 2))
      fs.unlinkSync(oldJson)
    }
    // LoadersService also creates an empty instances/<loaderId> folder.
    try {
      const oldInstance = instanceDir(gameDir, from)
      if (fs.existsSync(oldInstance) && fs.readdirSync(oldInstance).length === 0) {
        fs.rmdirSync(oldInstance)
      }
    } catch {
      /* ignore */
    }
  }

  async install(request: ModpackInstallRequest, reporter: Reporter): Promise<string> {
    const gameDir = this.settings.get().gameDir
    let archivePath = request.filePath
    let projectId = request.projectId
    let iconUrl: string | undefined
    let source: 'modrinth' | 'file' = 'file'

    if (!archivePath) {
      if (!request.versionId) throw new Error('缺少整合包版本')
      reporter.set({ detail: '获取整合包信息', progress: 0.02 })
      const version = await this.modrinth.version(request.versionId)
      projectId = projectId ?? version.projectId
      const file = version.files.find((f) => f.filename.endsWith('.mrpack')) ?? version.files.find((f) => f.primary)
      if (!file) throw new Error('该版本没有可下载的整合包文件')
      archivePath = path.join(cacheDir(), 'modpacks', file.filename)
      await new Downloader({
        concurrency: 1,
        source: 'official',
        signal: reporter.signal,
        onProgress: (p) => {
          const ratio = p.total ? p.received / p.total : 0
          reporter.set({ progress: 0.02 + ratio * 0.08, detail: '下载整合包' })
        },
      }).run([{ url: file.url, dest: archivePath, sha1: file.hashes.sha1, size: file.size }])
      source = 'modrinth'
      try {
        const project = await this.modrinth.project(projectId)
        iconUrl = project.iconUrl
      } catch {
        /* optional */
      }
    }

    reporter.throwIfCancelled()
    reporter.set({ detail: '解析整合包', progress: 0.12 })
    const zip = new AdmZip(archivePath)
    const indexEntry = zip.getEntry('modrinth.index.json')
    if (!indexEntry) throw new Error('不是有效的 Modrinth 整合包：缺少 modrinth.index.json')
    const index = JSON.parse(indexEntry.getData().toString('utf8')) as MrpackIndex
    if (index.formatVersion !== 1 || index.game !== 'minecraft') {
      throw new Error(`不支持的整合包格式（formatVersion=${index.formatVersion}, game=${index.game}）`)
    }
    const { loader, version: loaderVersion, mcVersion } = loaderFromManifest(index.dependencies ?? {})
    const baseId = request.instanceName?.trim()
      ? slugify(request.instanceName)
      : slugify(`${index.name}-${index.versionId}`)
    let instanceId = baseId
    for (let suffix = 2; fs.existsSync(versionDir(gameDir, instanceId)); suffix++) {
      instanceId = `${baseId}-${suffix}`
    }

    reporter.set({ detail: `安装 ${mcVersion}${loader === 'vanilla' ? '' : ` / ${loader} ${loaderVersion ?? ''}`}`, progress: 0.15 })
    const loaderVersionId = await this.loaders.install(
      { mcVersion, loader, loaderVersion, name: index.name },
      new ScaledReporter(reporter, 0.15, 0.55),
    )
    if (loaderVersionId !== instanceId) {
      reporter.set({ detail: '整理实例目录', progress: 0.555 })
      this.renameVersionFolder(gameDir, loaderVersionId, instanceId)
    }

    const root = instanceDir(gameDir, instanceId)
    ensureDirPath(root)
    ensureDir(root)

    const files = (index.files ?? []).filter((file) => file.env?.client !== 'unsupported')
    const totalBytes = files.reduce((sum, file) => sum + (file.fileSize ?? 0), 0)
    const tasks = files.map((file) => ({
      url: file.downloads[0],
      dest: safeJoin(root, file.path),
      sha1: file.hashes.sha1,
      size: file.fileSize,
    }))
    reporter.set({ detail: `下载整合包文件（${tasks.length} 个）`, progress: 0.56 })
    await new Downloader({
      concurrency: this.settings.get().concurrency,
      source: 'official',
      signal: reporter.signal,
      onProgress: (p) => {
        const ratio = p.total && totalBytes > 0 ? p.received / p.total : 0
        reporter.set({ progress: 0.56 + ratio * 0.34, detail: `下载整合包文件 ${p.filesDone}/${p.filesTotal}` })
      },
    }).run(tasks)

    reporter.throwIfCancelled()
    reporter.set({ detail: '释放覆盖文件', progress: 0.92 })
    let overrideCount = 0
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const name = entry.entryName
      if (!name.startsWith('overrides/') && !name.startsWith('client-overrides/')) continue
      const relative = name.replace(/^(client-)?overrides\//, '')
      if (!relative) continue
      const dest = safeJoin(root, relative)
      ensureDir(path.dirname(dest))
      fs.writeFileSync(dest, entry.getData())
      overrideCount++
    }

    const meta = readMeta(gameDir, instanceId)
    if (meta) {
      writeMeta(gameDir, {
        ...meta,
        name: index.name,
        id: instanceId,
        pack: {
          name: index.name,
          versionId: index.versionId,
          projectId,
          source,
          iconUrl,
          summary: index.summary,
        },
      })
    }
    log.info('installed modpack', index.name, index.versionId, 'overrides', overrideCount)
    reporter.set({ detail: '整合包安装完成', progress: 1 })
    return instanceId
  }

  /** Import a local .mrpack / supported zip. */
  async importFile(filePath: string, reporter: Reporter): Promise<string> {
    if (!fs.existsSync(filePath)) throw new Error('文件不存在')
    return this.install({ filePath }, reporter)
  }
}

export function readModpackSummary(instanceId: string, gameDir: string): string | null {
  const meta = readMeta(gameDir, instanceId)
  if (!meta?.pack) return null
  return `${meta.pack.name} ${meta.pack.versionId}`
}
