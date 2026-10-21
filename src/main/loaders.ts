import fs from 'node:fs'
import path from 'node:path'
import type {
  DownloadSource,
  InstallRequest,
  LoaderKind,
  LoaderVersion,
  MojangVersionJson,
  TaskUpdate,
} from '../shared/types'
import {
  FABRIC_META,
  FORGE_MAVEN,
  NEOFORGE_MAVEN,
  QUILT_META,
} from '../shared/constants'
import { cacheDir, ensureDir } from './paths'
import { getJson, getText, readJsonFile, writeFileAtomic } from './net'
import { Downloader } from './download'
import type { Reporter } from './tasks'
import type { SettingsStore } from './settings'
import { VersionService, libraryArtifact } from './versions'
import { libraryPath } from './paths'
import type { JavaService } from './java'
import { runCommand } from './exec'
import { createInstanceMeta, ensureInstanceFolders, writeMeta } from './instances'
import { log } from './logger'

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
    const mapped =
      typeof patch.progress === 'number'
        ? { ...patch, progress: this.from + patch.progress * (this.to - this.from) }
        : patch
    this.inner.set(mapped)
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0)
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function parseMavenVersions(xml: string): string[] {
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1].trim())
}

function neoForgePrefix(mcVersion: string): string | null {
  const parts = mcVersion.split('.')
  if (parts.length < 2) return null
  const minor = Number(parts[1])
  const patch = parts[2] ? Number(parts[2]) : 0
  if (!Number.isFinite(minor)) return null
  // 1.21.1 -> 21.1.x, 1.20.4 -> 20.4.x, 1.21 -> 21.0.x
  return `${minor}.${patch}.`
}

export class LoaderService {
  constructor(
    private readonly versions: VersionService,
    private readonly settings: SettingsStore,
    private readonly java: JavaService,
  ) {}

  private get source(): DownloadSource {
    return this.settings.get().downloadSource
  }

  async list(mcVersion: string, loader: LoaderKind): Promise<LoaderVersion[]> {
    if (loader === 'vanilla') return []
    if (loader === 'fabric' || loader === 'quilt') {
      const base = loader === 'fabric' ? FABRIC_META : QUILT_META
      const api = loader === 'fabric' ? 'v2' : 'v3'
      const data = await getJson<{ loader: { version: string; stable?: boolean } }[]>(
        `${base}/${api}/versions/loader/${encodeURIComponent(mcVersion)}`,
        { source: this.source },
      )
      return data
        .map((entry) => ({
          version: entry.loader.version,
          stable: entry.loader.stable ?? !/beta|alpha|pre|rc/i.test(entry.loader.version),
          gameVersion: mcVersion,
        }))
        .sort((a, b) => compareVersions(b.version, a.version))
    }

    if (loader === 'forge') {
      const xml = await getText(`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`, {
        source: this.source,
      })
      const prefix = `${mcVersion}-`
      return parseMavenVersions(xml)
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ version: v.slice(prefix.length), stable: !/beta|alpha/i.test(v), gameVersion: mcVersion }))
        .sort((a, b) => compareVersions(b.version, a.version))
        .map((v, index) => ({ ...v, recommended: index === 0 }))
    }

    if (loader === 'neoforge') {
      const prefix = neoForgePrefix(mcVersion)
      if (!prefix) return []
      const xml = await getText(`${NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`, {
        source: this.source,
      })
      return parseMavenVersions(xml)
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ version: v, stable: !/beta|alpha/i.test(v), gameVersion: mcVersion }))
        .sort((a, b) => compareVersions(b.version, a.version))
        .map((v, index) => ({ ...v, recommended: index === 0 }))
    }

    return []
  }

  /**
   * Install the requested vanilla base + mod loader. Returns the instance id
   * (the version folder that should be launched).
   */
  async install(req: InstallRequest, reporter: Reporter): Promise<string> {
    const base = this.settings.get()
    await this.versions.ensureVanilla(req.mcVersion, new ScaledReporter(reporter, 0, 0.6))
    this.versions.ensureLauncherProfiles()

    let id: string
    let loaderVersion: string | undefined

    if (req.loader === 'vanilla') {
      id = req.mcVersion
      loaderVersion = undefined
    } else if (req.loader === 'fabric' || req.loader === 'quilt') {
      const result = await this.installModdedProfile(req, new ScaledReporter(reporter, 0.6, 1))
      id = result.id
      loaderVersion = result.loaderVersion
    } else {
      const result = await this.installForgeLike(req, new ScaledReporter(reporter, 0.6, 1))
      id = result.id
      loaderVersion = result.loaderVersion
    }

    const meta = createInstanceMeta(id, req.loader, req.mcVersion, loaderVersion, { memoryMB: base.memoryMB }, req.name)
    writeMeta(base.gameDir, meta)
    ensureInstanceFolders(base.gameDir, id)
    reporter.set({ progress: 1, detail: '安装完成' })
    log.info('installed', id, 'from', req.mcVersion, req.loader)
    return id
  }

  private async installModdedProfile(
    req: InstallRequest,
    reporter: Reporter,
  ): Promise<{ id: string; loaderVersion: string }> {
    const list = await this.list(req.mcVersion, req.loader)
    if (list.length === 0) throw new Error(`没有找到适用于 ${req.mcVersion} 的 ${req.loader} 版本`)
    const chosen = req.loaderVersion ?? list.find((l) => l.stable)?.version ?? list[0].version
    if (!list.some((l) => l.version === chosen)) throw new Error(`不存在的加载器版本：${chosen}`)

    reporter.set({ detail: `获取 ${req.loader} ${chosen} 配置`, progress: 0.05 })
    const api = req.loader === 'fabric' ? 'v2' : 'v3'
    const base = req.loader === 'fabric' ? FABRIC_META : QUILT_META
    const profile = await getJson<MojangVersionJson>(
      `${base}/${api}/versions/loader/${encodeURIComponent(req.mcVersion)}/${encodeURIComponent(chosen)}/profile/json`,
      { source: this.source },
    )
    profile.id = profile.id ?? `${req.loader}-loader-${chosen}-${req.mcVersion}`

    const gameDir = this.settings.get().gameDir
    const dir = path.join(gameDir, 'versions', profile.id)
    ensureDir(dir)
    writeFileAtomic(path.join(dir, `${profile.id}.json`), JSON.stringify(profile, null, 2))

    reporter.set({ detail: '下载加载器依赖', progress: 0.35 })
    const tasks = (profile.libraries ?? [])
      .map((lib) => libraryArtifact(lib))
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .map((artifact) => ({
        url: artifact.url,
        dest: libraryPath(gameDir, artifact.relPath),
        sha1: artifact.sha1,
        size: artifact.size,
      }))
    await new Downloader({
      concurrency: this.settings.get().concurrency,
      source: this.source,
      signal: reporter.signal,
      onProgress: (p) => {
        const ratio = p.total ? p.received / p.total : 0
        reporter.set({ progress: 0.35 + ratio * 0.6, detail: `下载加载器依赖 ${p.filesDone}/${p.filesTotal}` })
      },
    }).run(tasks)

    return { id: profile.id, loaderVersion: chosen }
  }

  private async installForgeLike(
    req: InstallRequest,
    reporter: Reporter,
  ): Promise<{ id: string; loaderVersion: string }> {
    const kind = req.loader === 'neoforge' ? 'neoforge' : 'forge'
    const list = await this.list(req.mcVersion, kind)
    if (list.length === 0) throw new Error(`没有找到适用于 ${req.mcVersion} 的 ${kind === 'forge' ? 'Forge' : 'NeoForge'} 版本`)
    const chosen = req.loaderVersion ?? list.find((l) => l.recommended)?.version ?? list.find((l) => l.stable)?.version ?? list[0].version
    if (!list.some((l) => l.version === chosen)) throw new Error(`不存在的加载器版本：${chosen}`)

    const gameDir = this.settings.get().gameDir
    const installerName =
      kind === 'forge'
        ? `forge-${req.mcVersion}-${chosen}-installer.jar`
        : `neoforge-${chosen}-installer.jar`
    const installerUrl =
      kind === 'forge'
        ? `${FORGE_MAVEN}/net/minecraftforge/forge/${req.mcVersion}-${chosen}/forge-${req.mcVersion}-${chosen}-installer.jar`
        : `${NEOFORGE_MAVEN}/net/neoforged/neoforge/${chosen}/neoforge-${chosen}-installer.jar`
    const installerPath = path.join(cacheDir(), 'installers', installerName)

    reporter.set({ detail: '下载官方安装器', progress: 0.02 })
    if (!fs.existsSync(installerPath) || fs.statSync(installerPath).size < 100_000) {
      await new Downloader({
        concurrency: 1,
        source: this.source,
        signal: reporter.signal,
        onProgress: (p) => {
          const ratio = p.total ? p.received / p.total : 0
          reporter.set({ progress: 0.02 + ratio * 0.1, detail: '下载官方安装器' })
        },
      }).run([{ url: installerUrl, dest: installerPath }])
    }
    reporter.throwIfCancelled()

    const vanilla = await this.versions.fetchVersionJson(req.mcVersion)
    const java = await this.java.ensure(
      vanilla.javaVersion?.majorVersion ?? 17,
      vanilla.javaVersion?.component,
      '',
      reporter.signal,
    )

    const before = new Set(fs.readdirSync(path.join(gameDir, 'versions')))
    const startedAt = Date.now()
    reporter.set({ detail: '正在运行官方安装器（首次安装需要数分钟）', progress: null })

    const javaBin = path.join(java.path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    const result = await runCommand(
      javaBin,
      ['-jar', installerPath, '--installClient', gameDir],
      {
        cwd: gameDir,
        signal: reporter.signal,
        timeoutMs: 15 * 60 * 1000,
        onLine: (line) => {
          const text = line.replace(/\s+/g, ' ').trim()
          if (!text) return
          reporter.set({ detail: text.slice(0, 160) })
        },
      },
    )

    if (result.code !== 0) {
      const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-8).join('\n')
      throw new Error(`安装器执行失败（退出码 ${result.code}）\n${tail}`)
    }

    const installed = this.findInstalledVersion(req.mcVersion, kind, before, startedAt)
    reporter.set({ detail: '写入实例配置', progress: 0.98 })
    return { id: installed, loaderVersion: chosen }
  }

  private findInstalledVersion(mcVersion: string, kind: LoaderKind, before: Set<string>, startedAt: number): string {
    const gameDir = this.settings.get().gameDir
    const versionsRoot = path.join(gameDir, 'versions')
    const ids = fs
      .readdirSync(versionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    const matches = ids.filter((id) => {
      const json = readJsonFile<MojangVersionJson>(path.join(versionsRoot, id, `${id}.json`))
      if (!json) return false
      if (json.inheritsFrom !== mcVersion) return false
      if (kind === 'forge') return id.includes('forge') && !id.includes('neoforge')
      return id.startsWith('neoforge')
    })
    const touched = matches.filter((id) => {
      if (!before.has(id)) return true
      try {
        return fs.statSync(path.join(versionsRoot, id, `${id}.json`)).mtimeMs >= startedAt - 3000
      } catch {
        return false
      }
    })
    const candidates = touched.length > 0 ? touched : matches
    if (candidates.length === 0) throw new Error('官方安装器已结束，但没有生成版本配置，请查看日志')
    return candidates.sort((a, b) => {
      const ta = fs.statSync(path.join(versionsRoot, a)).mtimeMs
      const tb = fs.statSync(path.join(versionsRoot, b)).mtimeMs
      return tb - ta
    })[0]
  }
}
