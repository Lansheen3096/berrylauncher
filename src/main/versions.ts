import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { DownloadSource, InstanceSettings, Library, MojangVersionJson, RemoteVersion, Rule } from '../shared/types'
import { MOJANG } from '../shared/constants'
import {
  assetsDir,
  cacheDir,
  ensureDir,
  libraryPath,
  versionDir,
  versionJarPath,
  versionJsonPath,
} from './paths'
import { Downloader, throwIfAborted } from './download'
import { bmclClientJar, bmclVersionJson, getJson, platformName, readJsonFile, writeFileAtomic } from './net'
import type { Reporter } from './tasks'
import type { SettingsStore } from './settings'
import { log } from './logger'

export interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>
  virtual?: boolean
  map_to_resources?: boolean
}

export interface NativeFile {
  url: string
  relPath: string
  sha1?: string
  size?: number
}

export interface DownloadedLibrary {
  relPath: string
  url: string
  sha1?: string
  size?: number
}

const MANIFEST_TTL = 10 * 60 * 1000

export function rulesAllow(rules: Rule[] | undefined, features: Record<string, boolean> = {}): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    let matches = true
    if (rule.os) {
      if (rule.os.name && rule.os.name !== platformName()) matches = false
      if (rule.os.arch && !archMatches(rule.os.arch)) matches = false
    }
    if (rule.features) {
      for (const [key, value] of Object.entries(rule.features)) {
        if (Boolean(features[key]) !== Boolean(value)) matches = false
      }
    }
    if (!matches) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

function archMatches(required: string): boolean {
  const current: string = process.arch === 'x64' ? 'x86_64' : process.arch
  if (required === current) return true
  if (required === 'x86' && (current === 'ia32' || current === 'x86')) return true
  if (required === 'x86_64' && current === 'x64') return true
  if (required === 'arm64' && current === 'arm64') return true
  return false
}

export function nativeSuffix(): string {
  if (process.platform === 'win32') return 'natives-windows'
  if (process.platform === 'darwin') return 'natives-macos'
  return 'natives-linux'
}

export function isNativeLibrary(lib: Library): boolean {
  if (lib.natives) return true
  return /:natives-(windows|macos|linux|osx)/.test(lib.name)
}

export function mavenPath(name: string): string {
  const [coords, classifier] = name.split('@')
  const parts = coords.split(':')
  const [group, artifact, version, cls] = parts
  const ext = name.includes('@') ? classifier : 'jar'
  const classifierPart = cls ? `-${cls}` : ''
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifierPart}.${ext}`
}

export function libraryArtifact(lib: Library): DownloadedLibrary | null {
  if (lib.downloads?.artifact) {
    return {
      relPath: lib.downloads.artifact.path,
      url: lib.downloads.artifact.url,
      sha1: lib.downloads.artifact.sha1,
      size: lib.downloads.artifact.size,
    }
  }
  if (lib.name.includes('@')) return null
  const relPath = mavenPath(lib.name)
  const base = lib.url?.replace(/\/$/, '') ?? 'https://libraries.minecraft.net'
  const extra = lib as Library & { sha1?: string; size?: number }
  return { relPath, url: `${base}/${relPath}`, sha1: extra.sha1, size: extra.size }
}

export function nativeLibrary(lib: Library): NativeFile | null {
  const platform = platformName()
  if (lib.natives) {
    const key = lib.natives[platform] ?? lib.natives[platform === 'osx' ? 'macos' : platform]
    if (!key) return null
    const classifier = lib.downloads?.classifiers?.[key]
    if (!classifier) return null
    return { url: classifier.url, relPath: classifier.path, sha1: classifier.sha1, size: classifier.size }
  }
  if (!isNativeLibrary(lib)) return null
  const wanted = nativeSuffix()
  const alt = process.platform === 'darwin' ? 'natives-osx' : wanted
  if (!lib.name.includes(`:${wanted}`) && !lib.name.includes(`:${alt}`)) return null
  const artifact = lib.downloads?.artifact
  if (!artifact) return null
  return { url: artifact.url, relPath: artifact.path, sha1: artifact.sha1, size: artifact.size }
}

export function libraryKey(name: string): string {
  const parts = name.split('@')[0].split(':')
  return `${parts[0]}:${parts[1]}:${parts[3] ?? ''}`
}

export function mergeLibraries(parent: Library[], child: Library[]): Library[] {
  const map = new Map<string, Library>()
  for (const lib of [...parent, ...child]) map.set(libraryKey(lib.name), lib)
  return [...map.values()]
}

export interface ResolvedVersion {
  id: string
  /** id of the vanilla version whose client jar is used */
  jarId: string
  mcVersion: string
  json: MojangVersionJson
  chain: MojangVersionJson[]
}

export class VersionService {
  private manifest: { fetchedAt: number; versions: RemoteVersion[] } | null = null
  private readonly jsonCache = new Map<string, MojangVersionJson>()

  constructor(private readonly settings: SettingsStore) {}

  private get source(): DownloadSource {
    return this.settings.get().downloadSource
  }

  get gameDir(): string {
    return this.settings.get().gameDir
  }

  async getManifest(refresh = false): Promise<RemoteVersion[]> {
    if (!refresh && this.manifest && Date.now() - this.manifest.fetchedAt < MANIFEST_TTL) {
      return this.manifest.versions
    }
    const cacheFile = path.join(cacheDir(), 'version_manifest_v2.json')
    if (!refresh) {
      const cached = readJsonFile<{ fetchedAt: number; versions: RemoteVersion[] }>(cacheFile)
      if (cached && Date.now() - cached.fetchedAt < 6 * 60 * 60 * 1000) {
        this.manifest = cached
        return cached.versions
      }
    }
    const data = await getJson<{ latest: Record<string, string>; versions: RemoteVersion[] }>(MOJANG.versionManifest, {
      source: this.source,
    })
    this.manifest = { fetchedAt: Date.now(), versions: data.versions }
    ensureDir(cacheDir())
    writeFileAtomic(cacheFile, JSON.stringify(this.manifest))
    return data.versions
  }

  async getRemoteVersion(id: string): Promise<RemoteVersion> {
    const versions = await this.getManifest()
    const found = versions.find((v) => v.id === id)
    if (!found) throw new Error(`Mojang 版本清单中不存在 ${id}`)
    return found
  }

  /** Fetch (and cache) a version JSON without installing it. */
  async fetchVersionJson(id: string, refresh = false): Promise<MojangVersionJson> {
    if (!refresh && this.jsonCache.has(id)) return this.jsonCache.get(id)!
    const cacheFile = path.join(cacheDir(), 'version-json', `${id}.json`)
    if (!refresh) {
      const cached = readJsonFile<MojangVersionJson>(cacheFile)
      if (cached) return cached
    }
    const remote = await this.getRemoteVersion(id)
    const url = this.source === 'bmclapi' ? bmclVersionJson(id) : remote.url
    const json = await getJson<MojangVersionJson>(url)
    ensureDir(path.dirname(cacheFile))
    writeFileAtomic(cacheFile, JSON.stringify(json))
    this.jsonCache.set(id, json)
    return json
  }

  readInstalledJson(id: string, gameDir = this.gameDir): MojangVersionJson | null {
    return readJsonFile<MojangVersionJson>(versionJsonPath(gameDir, id))
  }

  isInstalled(id: string, gameDir = this.gameDir): boolean {
    return fs.existsSync(versionJsonPath(gameDir, id))
  }

  /** Resolve a version and all its `inheritsFrom` ancestors into one object. */
  resolve(id: string, gameDir = this.gameDir): ResolvedVersion {
    const chain: MojangVersionJson[] = []
    let current = this.readInstalledJson(id, gameDir)
    if (!current) throw new Error(`版本 ${id} 未安装`)
    const visited = new Set<string>()
    while (current) {
      if (visited.has(current.id)) throw new Error(`版本继承链存在循环：${current.id}`)
      visited.add(current.id)
      chain.push(current)
      const parentId: string | undefined = current.inheritsFrom
      current = parentId ? this.readInstalledJson(parentId, gameDir) : null
    }
    chain.reverse()

    let merged: MojangVersionJson = { ...chain[0], libraries: [...(chain[0].libraries ?? [])] }
    for (const child of chain.slice(1)) {
      merged = {
        ...merged,
        ...child,
        id: child.id,
        libraries: mergeLibraries(merged.libraries ?? [], child.libraries ?? []),
        arguments: {
          game: [...(merged.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
          jvm: [...(merged.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])],
        },
        minecraftArguments: child.minecraftArguments ?? merged.minecraftArguments,
        downloads: { ...(merged.downloads ?? {}), ...(child.downloads ?? {}) },
      }
    }

    const root = chain[0]
    return {
      id,
      jarId: root.id,
      mcVersion: root.id,
      json: merged,
      chain,
    }
  }

  /** Install (or repair) a vanilla version. Existing files are verified by size and skipped. */
  async ensureVanilla(id: string, reporter: Reporter): Promise<void> {
    const marker = path.join(versionDir(this.gameDir, id), '.berry-installed')
    if (fs.existsSync(marker) && fs.existsSync(versionJarPath(this.gameDir, id))) return
    await this.installVanilla(id, reporter, true)
  }

  async installVanilla(id: string, reporter: Reporter, force = false): Promise<void> {
    const gameDir = this.gameDir
    const vdir = versionDir(gameDir, id)
    if (!force && fs.existsSync(path.join(vdir, '.berry-installed'))) return
    reporter.set({ detail: `读取 ${id} 版本信息`, progress: 0.01 })
    const json = await this.fetchVersionJson(id)
    if (!json.downloads?.client) throw new Error('该版本不提供客户端下载')
    ensureDir(vdir)
    writeFileAtomic(versionJsonPath(gameDir, id), JSON.stringify(json, null, 2))
    ensureDir(versionDir(gameDir, json.id))

    const concurrency = this.settings.get().concurrency
    const source = this.source
    const dl = (onProgress: (p: { received: number; total: number; filesDone: number; filesTotal: number }) => void) =>
      new Downloader({ concurrency, source, signal: reporter.signal, onProgress })

    // 1. client jar
    const jarPath = versionJarPath(gameDir, id)
    const clientUrl = source === 'bmclapi' ? bmclClientJar(id) : json.downloads.client.url
    const jarDl = dl((p) => {
      const ratio = p.total ? p.received / p.total : 0
      reporter.set({ progress: 0.02 + ratio * 0.05, detail: '下载游戏主程序' })
    })
    await jarDl.run([{ url: clientUrl, dest: jarPath, sha1: json.downloads.client.sha1, size: json.downloads.client.size }])

    // 2. libraries + logging config
    const libTasks: { url: string; dest: string; sha1?: string; size?: number }[] = []
    let libTotal = 0
    for (const lib of json.libraries ?? []) {
      if (!rulesAllow(lib.rules)) continue
      const artifact = libraryArtifact(lib)
      if (artifact) {
        libTasks.push({
          url: artifact.url,
          dest: libraryPath(gameDir, artifact.relPath),
          sha1: artifact.sha1,
          size: artifact.size,
        })
        libTotal += artifact.size ?? 0
      }
      const native = nativeLibrary(lib)
      if (native) {
        libTasks.push({ url: native.url, dest: libraryPath(gameDir, native.relPath), sha1: native.sha1, size: native.size })
        libTotal += native.size ?? 0
      }
    }
    if (json.logging?.client) {
      libTasks.push({
        url: json.logging.client.file.url,
        dest: path.join(assetsDir(gameDir), 'log_configs', json.logging.client.file.id),
        sha1: json.logging.client.file.sha1,
        size: json.logging.client.file.size,
      })
      libTotal += json.logging.client.file.size
    }
    const libProgress = (p: { received: number; total: number; filesDone: number; filesTotal: number }) => {
      const ratio = p.total ? p.received / p.total : 0
      reporter.set({
        progress: 0.07 + ratio * 0.16,
        detail: `下载依赖库 ${p.filesDone}/${p.filesTotal}`,
      })
    }
    await dl(libProgress).run(libTasks)

    // 3. assets
    reporter.throwIfCancelled()
    const assetIndexId = json.assetIndex?.id ?? json.assets
    if (json.assetIndex) {
      const indexFile = path.join(assetsDir(gameDir), 'indexes', `${json.assetIndex.id}.json`)
      ensureDir(path.dirname(indexFile))
      await dl(() => {}).run([
        {
          url: json.assetIndex.url,
          dest: indexFile,
          sha1: json.assetIndex.sha1,
          size: json.assetIndex.size,
        },
      ])
      const index = readJsonFile<AssetIndex>(indexFile)
      if (!index) throw new Error('资源索引解析失败')
      const entries = Object.entries(index.objects)
      const assetTasks = entries.map(([name, obj]) => ({
        url: `https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`,
        dest: path.join(assetsDir(gameDir), 'objects', obj.hash.slice(0, 2), obj.hash),
        sha1: obj.hash,
        size: obj.size,
        label: name,
      }))
      const totalAssetBytes = assetTasks.reduce((sum, t) => sum + (t.size ?? 0), 0)
      reporter.set({ total: totalAssetBytes, received: 0, detail: `准备下载 ${assetTasks.length} 个资源文件` })
      await dl((p) => {
        reporter.set({
          progress: 0.23 + (p.total ? p.received / p.total : 0) * 0.77,
          received: p.received,
          total: p.total,
          detail: `下载游戏资源 ${p.filesDone}/${p.filesTotal}`,
        })
      }).run(assetTasks)

      if (index.virtual || index.map_to_resources) {
        const virtualRoot = path.join(assetsDir(gameDir), 'virtual', json.assetIndex.id)
        ensureDir(virtualRoot)
        for (const [name, obj] of entries) {
          const dest = path.join(virtualRoot, ...name.split('/'))
          if (fs.existsSync(dest)) continue
          ensureDir(path.dirname(dest))
          try {
            fs.copyFileSync(path.join(assetsDir(gameDir), 'objects', obj.hash.slice(0, 2), obj.hash), dest)
          } catch (err) {
            log.warn('failed to materialize virtual asset', name, err)
          }
        }
      }
    } else if (json.assets) {
      throw new Error('该远古版本使用旧版资源索引，暂不支持自动安装')
    }

    writeFileAtomic(path.join(vdir, '.berry-installed'), new Date().toISOString())
    reporter.set({ progress: 1, detail: '游戏文件安装完成' })
  }

  /** Write launcher_profiles.json so official installers are happy. */
  ensureLauncherProfiles(): void {
    const file = path.join(this.gameDir, 'launcher_profiles.json')
    if (fs.existsSync(file)) return
    writeFileAtomic(
      file,
      JSON.stringify(
        {
          profiles: {
            BerryLauncher: {
              name: 'BerryLauncher',
              type: 'custom',
              created: new Date().toISOString(),
              lastUsed: new Date().toISOString(),
              icon: 'Grass',
            },
          },
          settings: { enableSnapshots: false, keepLauncherOpen: false },
          version: 3,
        },
        null,
        2,
      ),
    )
  }

  extractNatives(resolved: ResolvedVersion, targetDir: string): void {
    ensureDir(targetDir)
    fs.rmSync(targetDir, { recursive: true, force: true })
    ensureDir(targetDir)
    const libs = resolved.json.libraries ?? []
    for (const lib of libs) {
      if (!rulesAllow(lib.rules)) continue
      const native = nativeLibrary(lib)
      if (!native) continue
      const jar = libraryPath(this.gameDir, native.relPath)
      if (!fs.existsSync(jar)) continue
      try {
        const zip = new AdmZip(jar)
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue
          if (entry.entryName.startsWith('META-INF/')) continue
          const excluded = lib.extract?.exclude?.some((pattern) => entry.entryName.startsWith(pattern))
          if (excluded) continue
          const dest = path.join(targetDir, entry.entryName)
          ensureDir(path.dirname(dest))
          fs.writeFileSync(dest, entry.getData())
        }
      } catch (err) {
        log.warn('failed to extract natives from', native.relPath, err)
      }
    }
  }
}

export function instanceMetaDefaults(settings: InstanceSettings, memoryMB: number): InstanceSettings {
  return { memoryMB, ...settings }
}
