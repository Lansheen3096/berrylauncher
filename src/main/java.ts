import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DownloadSource, JavaInfo } from '../shared/types'
import { MOJANG } from '../shared/constants'
import { dataDir, ensureDir, runtimeDir } from './paths'
import { Downloader } from './download'
import { getJson, platformName } from './net'
import { log } from './logger'

const execFileAsync = promisify(execFile)

const WIN_JAVA_ROOTS = [
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\Zulu',
  'C:\\Program Files\\BellSoft',
  'C:\\Program Files\\Amazon Corretto',
]

export function javaExecutableName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

function candidateRoots(): string[] {
  const roots = new Set<string>()
  const env = process.env
  if (env.JAVA_HOME) roots.add(env.JAVA_HOME)

  if (process.platform === 'win32') {
    for (const root of WIN_JAVA_ROOTS) roots.add(root)
    if (env.APPDATA) {
      roots.add(path.join(env.APPDATA, '.minecraft', 'runtime'))
      roots.add(path.join(env.APPDATA, 'BerryLauncher', 'runtime'))
    }
    if (env.LOCALAPPDATA) {
      roots.add(
        path.join(
          env.LOCALAPPDATA,
          'Packages',
          'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
          'LocalCache',
          'Local',
          'runtime',
        ),
      )
    }
  } else if (process.platform === 'darwin') {
    roots.add('/Library/Java/JavaVirtualMachines')
    roots.add('/System/Library/Java/JavaVirtualMachines')
    roots.add(path.join(env.HOME ?? '', 'Library', 'Java', 'JavaVirtualMachines'))
  } else {
    roots.add('/usr/lib/jvm')
    roots.add('/usr/lib64/jvm')
    roots.add(path.join(env.HOME ?? '', '.jdks'))
    roots.add(path.join(env.HOME ?? '', '.sdkman', 'candidates', 'java'))
  }
  roots.add(runtimeDir())
  roots.add(path.join(dataDir(), 'runtime'))
  return [...roots].filter(Boolean)
}

/** Recursively find `bin/java(.exe)` up to `depth` levels below root. */
function findJavaHome(root: string, depth = 4): string[] {
  const found: string[] = []
  const javaName = javaExecutableName()

  const walk = (dir: string, remaining: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const direct = path.join(dir, 'bin', javaName)
    if (fs.existsSync(direct)) {
      found.push(dir)
      return
    }
    if (remaining <= 0) return
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(path.join(dir, entry.name), remaining - 1)
    }
  }
  walk(root, depth)
  return found
}

const versionCache = new Map<string, JavaInfo | null>()

export async function describeJava(javaHome: string, source: JavaInfo['source']): Promise<JavaInfo | null> {
  const cached = versionCache.get(javaHome)
  if (cached !== undefined) return cached ? { ...cached, source } : null

  const bin = path.join(javaHome, 'bin', javaExecutableName())
  if (!fs.existsSync(bin)) {
    versionCache.set(javaHome, null)
    return null
  }
  try {
    const { stderr, stdout } = await execFileAsync(bin, ['-XshowSettings:properties', '-version'], {
      timeout: 10000,
      windowsHide: true,
    })
    const text = `${stderr}\n${stdout}`
    const versionMatch = /java\.version\s*=\s*([^\s]+)/.exec(text) ?? /version "([^"]+)"/.exec(text)
    const specMatch = /java\.specification\.version\s*=\s*([^\s]+)/.exec(text)
    if (!versionMatch) throw new Error('无法解析 java -version 输出')
    const version = versionMatch[1]
    const spec = specMatch?.[1]
    // Java 8 reports `java.specification.version = 1.8`, newer JDKs report 17/21.
    const major = /^1\.\d+$/.test(spec ?? '')
      ? Number((spec as string).split('.')[1])
      : Number((spec ?? version).split('.')[0])
    if (!Number.isFinite(major)) throw new Error('无法解析 Java 主版本')
    const info: JavaInfo = { path: javaHome, version, major, source }
    versionCache.set(javaHome, info)
    return info
  } catch (err) {
    log.warn('could not identify java at', javaHome, err)
    versionCache.set(javaHome, null)
    return null
  }
}

export async function detectJava(customPath?: string): Promise<JavaInfo[]> {
  const results: JavaInfo[] = []
  const seen = new Set<string>()

  if (customPath) {
    const home = customPath.endsWith(javaExecutableName()) ? path.dirname(path.dirname(customPath)) : customPath
    const info = await describeJava(home, 'custom')
    if (info) {
      results.push(info)
      seen.add(info.path)
    }
  }

  for (const root of candidateRoots()) {
    if (!fs.existsSync(root)) continue
    for (const home of findJavaHome(root)) {
      if (seen.has(home)) continue
      seen.add(home)
      const source: JavaInfo['source'] = home.startsWith(runtimeDir()) ? 'bundled' : 'system'
      const info = await describeJava(home, source)
      if (info) results.push(info)
    }
  }

  // PATH lookup as a last resort.
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(which, ['java'], { timeout: 5000, windowsHide: true })
    const bin = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (bin) {
      const home = path.dirname(path.dirname(bin))
      if (!seen.has(home)) {
        const info = await describeJava(home, 'system')
        if (info) results.push(info)
      }
    }
  } catch {
    /* no java on PATH */
  }

  return results.sort((a, b) => b.major - a.major)
}

interface RuntimeManifestEntry {
  manifest: { url: string; sha1: string; size: number }
  version: { name: string; released: string }
}

interface RuntimeFile {
  type: 'file' | 'directory' | 'link'
  executable?: boolean
  target?: string
  downloads?: { raw: { url: string; sha1: string; size: number } }
}

interface RuntimeManifest {
  files: Record<string, RuntimeFile>
}

function platformKey(): string {
  const os = platformName()
  if (os === 'windows') return process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64'
  if (os === 'osx') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os'
  return process.arch === 'ia32' ? 'linux-i386' : 'linux'
}

export class JavaService {
  private downloading: Promise<JavaInfo> | null = null

  constructor(
    private readonly getConcurrency: () => number,
    private readonly getSource: () => DownloadSource = () => 'official',
  ) {}

  async ensure(
    requiredMajor: number,
    component: string | undefined,
    preferredPath: string,
    signal?: AbortSignal,
  ): Promise<JavaInfo> {
    if (preferredPath) {
      const home = preferredPath.endsWith(javaExecutableName())
        ? path.dirname(path.dirname(preferredPath))
        : preferredPath
      const info = await describeJava(home, 'custom')
      if (info) {
        if (info.major >= requiredMajor) return info
        // A per-instance Java override must not silently launch a game that
        // was compiled for a newer JDK (class file 69 = Java 25).
        log.warn(
          `configured Java ${info.major} is older than required ${requiredMajor}, ignoring override`,
          preferredPath,
        )
      } else {
        throw new Error(`指定的 Java 不可用：${preferredPath}`)
      }
    }

    const all = await detectJava()
    const exact = all.find((j) => j.major === requiredMajor)
    if (exact) return exact
    if (requiredMajor >= 17) {
      const newer = all
        .filter((j) => j.major > requiredMajor && j.major <= 30)
        .sort((a, b) => a.major - b.major)[0]
      if (newer) return newer
    }

    if (!component) {
      throw new Error(`未找到 Java ${requiredMajor}，且该版本没有提供运行时下载信息`)
    }
    return this.downloadComponent(component, signal, requiredMajor)
  }

  async downloadComponent(component: string, signal?: AbortSignal, expectMajor?: number): Promise<JavaInfo> {
    if (this.downloading) return this.downloading
    this.downloading = this.doDownload(component, signal, expectMajor).finally(() => {
      this.downloading = null
    })
    return this.downloading
  }

  private async doDownload(component: string, signal?: AbortSignal, expectMajor?: number): Promise<JavaInfo> {
    const source = this.getSource()
    const all = await getJson<Record<string, Record<string, RuntimeManifestEntry[]>>>(MOJANG.javaRuntimeAll, { source })
    const key = platformKey()
    const platform = all[key] ?? all.linux ?? all['windows-x64']
    if (!platform) throw new Error('无法获取 Java 运行时清单')

    const versionMajor = (entry: RuntimeManifestEntry): number => {
      const match = /^(\d+)/.exec(entry.version?.name ?? '')
      return match ? Number(match[1]) : 0
    }
    const candidates = [
      component,
      'java-runtime-epsilon',
      'java-runtime-delta',
      'java-runtime-gamma',
      'jre-legacy',
    ].filter(Boolean) as string[]
    let entry: RuntimeManifestEntry | undefined
    for (const name of candidates) {
      const versions = platform[name]
      if (!versions?.length) continue
      const picked = expectMajor
        ? versions.find((candidate) => versionMajor(candidate) >= expectMajor)
        : versions[0]
      if (picked) {
        component = name
        entry = picked
        break
      }
    }
    if (!entry && expectMajor) {
      // The version JSON's component can lag behind the class-file version.
      // Find a runtime whose declared version satisfies the requirement.
      let best: { name: string; entry: RuntimeManifestEntry; major: number } | null = null
      for (const [name, versions] of Object.entries(platform)) {
        for (const candidate of versions ?? []) {
          const major = versionMajor(candidate)
          if (major >= expectMajor && (!best || major < best.major)) {
            best = { name, entry: candidate, major }
          }
        }
      }
      if (best) {
        component = best.name
        entry = best.entry
      }
    }
    if (!entry) throw new Error(`当前平台没有可用的 Java 运行时：${component}`)

    const manifest = await getJson<RuntimeManifest>(entry.manifest.url, { source })
    const root = path.join(runtimeDir(), component)
    ensureDir(root)

    const files: { key: string; file: RuntimeFile }[] = []
    for (const [rel, file] of Object.entries(manifest.files)) {
      files.push({ key: rel, file })
    }

    const downloads = files
      .filter(({ file }) => file.type === 'file' && file.downloads?.raw)
      .map(({ key, file }) => ({
        url: file.downloads!.raw.url,
        dest: path.join(root, key),
        sha1: file.downloads!.raw.sha1,
        size: file.downloads!.raw.size,
        label: key,
      }))

    const downloader = new Downloader({
      concurrency: Math.max(4, this.getConcurrency()),
      source,
      signal,
    })
    await downloader.run(downloads)

    for (const { key, file } of files) {
      const dest = path.join(root, key)
      if (file.type === 'directory') {
        ensureDir(dest)
      } else if (file.type === 'link' && file.target) {
        try {
          if (!fs.existsSync(dest)) fs.symlinkSync(file.target, dest)
        } catch {
          /* Windows or unsupported: ignore */
        }
      } else if (process.platform !== 'win32' && file.executable) {
        try {
          fs.chmodSync(dest, 0o755)
        } catch {
          /* ignore */
        }
      }
    }

    const info = await describeJava(root, 'downloaded')
    if (!info) throw new Error(`Java 运行时安装后无法运行：${path.join(root, 'bin', javaExecutableName())}`)
    if (expectMajor !== undefined && info.major < expectMajor) {
      throw new Error(`下载的 Java 版本不满足要求（需要 ${expectMajor}，实际 ${info.major}）`)
    }
    return info
  }
}
