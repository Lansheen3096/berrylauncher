import fs from 'node:fs'
import path from 'node:path'
import type { InstalledMod, ModInstallResult, ModrinthVersion } from '../shared/types'
import type { SettingsStore } from './settings'
import type { ModrinthService } from './modrinth'
import type { Reporter } from './tasks'
import { Downloader } from './download'
import { ensureDir, instanceDir } from './paths'
import { readJsonFile, writeFileAtomic } from './net'
import { readMeta } from './instances'
import { log } from './logger'

interface ModIndexEntry {
  projectId?: string
  versionId?: string
  versionNumber?: string
  title?: string
  iconUrl?: string
  installedAt: number
}

type ModIndex = Record<string, ModIndexEntry>

const INDEX_FILE = '.berry-mods.json'

const LOADER_ALIASES: Record<string, string[]> = {
  fabric: ['fabric'],
  quilt: ['quilt', 'fabric'],
  forge: ['forge'],
  neoforge: ['neoforge', 'forge'],
  vanilla: [],
}

function compatible(version: ModrinthVersion, gameVersion: string, loader: string): boolean {
  const loaders = LOADER_ALIASES[loader] ?? [loader]
  if (loaders.length > 0 && !version.loaders.some((l) => loaders.includes(l))) return false
  return version.gameVersions.includes(gameVersion)
}

export class ModService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly modrinth: ModrinthService,
  ) {}

  private modsDir(instanceId: string): string {
    return path.join(instanceDir(this.settings.get().gameDir, instanceId), 'mods')
  }

  private readIndex(modsDir: string): ModIndex {
    return readJsonFile<ModIndex>(path.join(modsDir, INDEX_FILE)) ?? {}
  }

  private writeIndex(modsDir: string, index: ModIndex): void {
    writeFileAtomic(path.join(modsDir, INDEX_FILE), JSON.stringify(index, null, 2))
  }

  async list(instanceId: string): Promise<InstalledMod[]> {
    const dir = this.modsDir(instanceId)
    let files: string[] = []
    try {
      files = fs.readdirSync(dir)
    } catch {
      return []
    }
    const index = this.readIndex(dir)
    const result: InstalledMod[] = []
    for (const file of files) {
      if (file === INDEX_FILE) continue
      const isDisabled = file.endsWith('.disabled')
      const base = isDisabled ? file.slice(0, -'.disabled'.length) : file
      if (!base.endsWith('.jar')) continue
      const entry = index[base]
      const full = path.join(dir, file)
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      result.push({
        file: base,
        name: entry?.title ?? base,
        enabled: !isDisabled,
        size,
        projectId: entry?.projectId,
        versionId: entry?.versionId,
        versionNumber: entry?.versionNumber,
        title: entry?.title,
        iconUrl: entry?.iconUrl,
      })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  async install(
    instanceId: string,
    versionId: string,
    withDependencies = true,
    reporter?: Reporter,
  ): Promise<ModInstallResult> {
    const gameDir = this.settings.get().gameDir
    const meta = readMeta(gameDir, instanceId)
    if (!meta) throw new Error('实例不存在或缺少元数据')
    const modsDir = this.modsDir(instanceId)
    ensureDir(modsDir)
    const index = this.readIndex(modsDir)
    const installedProjects = new Set(Object.values(index).map((entry) => entry.projectId).filter(Boolean) as string[])

    const queue: ModrinthVersion[] = [await this.modrinth.version(versionId)]
    const seenVersions = new Set<string>()
    const planned: { version: ModrinthVersion; dest: string }[] = []
    const skipped: string[] = []
    let guard = 0

    while (queue.length > 0) {
      if (++guard > 40) throw new Error('依赖解析层数过多，已中止')
      const version = queue.shift()!
      if (seenVersions.has(version.id)) continue
      seenVersions.add(version.id)
      if (!compatible(version, meta.mcVersion, meta.loader)) {
        skipped.push(`${version.name}（不兼容 ${meta.mcVersion} / ${meta.loader}）`)
        continue
      }
      if (installedProjects.has(version.projectId)) {
        skipped.push(`${version.name}（已安装）`)
        continue
      }
      installedProjects.add(version.projectId)
      const file = version.files.find((f) => f.primary) ?? version.files[0]
      if (!file) {
        skipped.push(`${version.name}（没有可下载文件）`)
        continue
      }
      let dest = path.join(modsDir, file.filename)
      if (fs.existsSync(dest)) {
        dest = path.join(modsDir, file.filename.replace(/\.jar$/i, `-${version.projectId.slice(0, 8)}.jar`))
      }
      planned.push({ version, dest })

      if (withDependencies) {
        for (const dep of version.dependencies) {
          if (dep.dependencyType !== 'required') continue
          try {
            const resolved = await this.resolveDependency(dep.versionId, dep.projectId, meta.mcVersion, meta.loader)
            if (resolved) queue.push(resolved)
          } catch (err) {
            log.warn('dependency resolve failed', dep, err)
            skipped.push(dep.projectId ? `依赖 ${dep.projectId} 解析失败` : '依赖解析失败')
          }
        }
      }
    }

    const installs: InstalledMod[] = []
    const total = planned.reduce((sum, item) => {
      const file = item.version.files.find((f) => f.primary) ?? item.version.files[0]
      return sum + (file?.size ?? 0)
    }, 0)
    let doneBytes = 0

    for (const item of planned) {
      const file = item.version.files.find((f) => f.primary) ?? item.version.files[0]
      if (!file) continue
      await new Downloader({
        concurrency: 1,
        source: 'official',
        signal: reporter?.signal,
        onProgress: (progress) => {
          if (total > 0) reporter?.set({ progress: (doneBytes + progress.received) / total, detail: `下载模组 ${item.version.name}` })
        },
      }).run([{ url: file.url, dest: item.dest, sha1: file.hashes.sha1, size: file.size }])
      doneBytes += file.size
      index[path.basename(item.dest)] = {
        projectId: item.version.projectId,
        versionId: item.version.id,
        versionNumber: item.version.versionNumber,
        title: item.version.name,
        installedAt: Date.now(),
      }
      this.writeIndex(modsDir, index)
      installs.push({
        file: path.basename(item.dest),
        name: item.version.name,
        enabled: true,
        size: file.size,
        projectId: item.version.projectId,
        versionId: item.version.id,
        versionNumber: item.version.versionNumber,
        title: item.version.name,
      })
    }

    reporter?.set({ detail: '模组安装完成', progress: 1 })
    return { installed: installs, skipped, instanceId }
  }

  private async resolveDependency(
    versionId: string | undefined,
    projectId: string | undefined,
    gameVersion: string,
    loader: string,
  ): Promise<ModrinthVersion | null> {
    if (versionId) {
      const version = await this.modrinth.version(versionId)
      return compatible(version, gameVersion, loader) ? version : null
    }
    if (!projectId) return null
    const versions = await this.modrinth.versions(projectId, gameVersion, loader)
    return versions[0] ?? null
  }

  toggle(instanceId: string, file: string): void {
    const dir = this.modsDir(instanceId)
    const base = file.replace(/\.disabled$/, '')
    const enabledPath = path.join(dir, base)
    const disabledPath = `${enabledPath}.disabled`
    if (fs.existsSync(enabledPath)) {
      fs.renameSync(enabledPath, disabledPath)
    } else if (fs.existsSync(disabledPath)) {
      fs.renameSync(disabledPath, enabledPath)
    } else {
      throw new Error('模组文件不存在')
    }
  }

  remove(instanceId: string, file: string): void {
    const dir = this.modsDir(instanceId)
    const base = file.replace(/\.disabled$/, '')
    for (const target of [path.join(dir, base), path.join(dir, `${base}.disabled`)]) {
      try {
        fs.unlinkSync(target)
      } catch {
        /* ignore */
      }
    }
    const index = this.readIndex(dir)
    delete index[base]
    this.writeIndex(dir, index)
  }

  count(instanceId: string): number {
    try {
      return fs
        .readdirSync(this.modsDir(instanceId))
        .filter((file) => file.endsWith('.jar') || file.endsWith('.jar.disabled')).length
    } catch {
      return 0
    }
  }
}
