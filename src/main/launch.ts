import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import AdmZip from 'adm-zip'
import type { Account, InstanceSettings, LaunchStatus, MojangVersionJson } from '../shared/types'
import { APP_VERSION, LAUNCHER_BRAND } from '../shared/constants'
import { assetsDir, ensureDir, instanceDir, versionJarPath } from './paths'
import type { SettingsStore } from './settings'
import type { VersionService } from './versions'
import { isNativeLibrary, libraryArtifact, libraryKey, rulesAllow } from './versions'
import type { JavaService } from './java'
import { readMeta, writeMeta } from './instances'
import { authlibInjector } from './authlib'
import { playtime } from './playtime'
import { log } from './logger'

interface Session {
  account: Account
  accessToken: string
  userType: 'msa' | 'legacy'
  authlibServer?: string
}

interface Substitutions {
  [key: string]: string
}

/** Java major for the version of the compiled main class in a client jar. */
function clientClassMajor(jarPath: string): number | null {
  try {
    const zip = new AdmZip(jarPath)
    const entry = zip.getEntry('net/minecraft/client/main/Main.class')
    if (!entry) return null
    const data = entry.getData()
    if (data.length < 8 || data[0] !== 0xca || data[1] !== 0xfe || data[2] !== 0xba || data[3] !== 0xbe) return null
    const classMajor = data.readUInt16BE(6)
    return classMajor >= 45 ? classMajor - 44 : null
  } catch {
    return null
  }
}

function substitute(template: string, values: Substitutions): string {
  return template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => values[key] ?? match)
}

function expandArguments(
  entries: (string | { rules?: import('../shared/types').Rule[]; value: string | string[] })[] | undefined,
  values: Substitutions,
  features: Record<string, boolean>,
): string[] {
  if (!entries) return []
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push(substitute(entry, values))
      continue
    }
    if (!rulesAllow(entry.rules, features)) continue
    const list = Array.isArray(entry.value) ? entry.value : [entry.value]
    for (const item of list) out.push(substitute(item, values))
  }
  return out
}

export class LaunchService {
  private readonly running = new Map<
    string,
    { child: ChildProcess; status: LaunchStatus; startedAt: number; stream: fs.WriteStream; pending: string[]; timer: NodeJS.Timeout | null; stopping: boolean }
  >()

  constructor(
    private readonly versions: VersionService,
    private readonly settings: SettingsStore,
    private readonly java: JavaService,
    private readonly emit: (channel: 'launch:status' | 'launch:log', payload: unknown) => void,
  ) {}

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  runningIds(): string[] {
    return [...this.running.keys()]
  }

  async launch(id: string, session: Session): Promise<LaunchStatus> {
    if (this.running.has(id)) throw new Error('该实例已经在运行中')

    const settings = this.settings.get()
    const gameDir = settings.gameDir
    const meta = readMeta(gameDir, id)
    const resolved = this.versions.resolve(id, gameDir)
    const instanceSettings: InstanceSettings = meta?.settings ?? {}
    const isolated = settings.versionIsolation || Boolean(meta?.pack)
    const instancePath = isolated ? instanceDir(gameDir, id) : gameDir
    ensureDir(instancePath)

    const clientJar = versionJarPath(gameDir, resolved.jarId)
    if (!fs.existsSync(clientJar)) throw new Error(`缺少客户端主程序：${path.basename(clientJar)}，请重新安装该版本`)

    const preparing: LaunchStatus = {
      id: `launch-${Date.now()}`,
      versionId: id,
      state: 'preparing',
      startedAt: Date.now(),
    }
    this.emit('launch:status', preparing)

    const declaredJava = resolved.json.javaVersion?.majorVersion ?? 8
    const requiredJava = Math.max(declaredJava, clientClassMajor(clientJar) ?? 0)
    const javaInfo = await this.java.ensure(
      requiredJava,
      resolved.json.javaVersion?.component,
      instanceSettings.javaPath || settings.javaPath,
    )
    if (javaInfo.major < requiredJava) {
      throw new Error(
        `该版本需要 Java ${requiredJava}，当前选中的 Java ${javaInfo.major} 过低。请在实例设置中指定更新的 Java。`,
      )
    }
    log.info('java selected', javaInfo.path, `major=${javaInfo.major}`, `required=${requiredJava}`)

    const memory = instanceSettings.memoryMB ?? settings.memoryMB
    const nativesDir = path.join(instanceDir(gameDir, id), 'natives')
    this.versions.extractNatives(resolved, nativesDir)

    // Forge 1.17+ / NeoForge use BootstrapLauncher: the vanilla client jar must
    // NOT be on the classpath (it would be turned into an automatic module and
    // clash with Forge's patched `minecraft` module). It is passed by property.
    const usesBootstrap = (resolved.json.mainClass ?? '').includes('bootstraplauncher')
    const classpath = this.buildClasspath(resolved.json, gameDir, usesBootstrap ? null : clientJar)
    const separator = process.platform === 'win32' ? ';' : ':'
    const assetsRoot = assetsDir(gameDir)
    const assetIndexName = resolved.json.assetIndex?.id ?? resolved.json.assets ?? 'legacy'

    const features: Record<string, boolean> = {}
    if (instanceSettings.width && instanceSettings.height) features.has_custom_resolution = true

    const values: Substitutions = {
      auth_player_name: session.account.name,
      version_name: id,
      game_directory: instancePath,
      assets_root: assetsRoot,
      assets_index_name: assetIndexName,
      auth_uuid: session.account.uuid,
      auth_access_token: session.accessToken || '0',
      auth_session: `${session.accessToken || '0'}:${session.account.uuid}`,
      user_type: session.userType,
      version_type: resolved.json.type ?? 'release',
      natives_directory: nativesDir,
      launcher_name: LAUNCHER_BRAND,
      launcher_version: APP_VERSION,
      classpath: classpath.join(separator),
      classpath_separator: separator,
      library_directory: path.join(gameDir, 'libraries'),
      game_assets: path.join(assetsRoot, 'virtual', assetIndexName),
      user_properties: '{}',
      resolution_width: String(instanceSettings.width ?? 1280),
      resolution_height: String(instanceSettings.height ?? 720),
    }

    const jvmFromJson = expandArguments(resolved.json.arguments?.jvm, values, features)
    const usesLegacyDefaults = jvmFromJson.length === 0
    const jvmArgs: string[] = [
      `-Xmx${Math.max(512, memory)}M`,
      `-Xms${Math.min(1024, Math.max(256, Math.floor(memory / 4)))}M`,
      '-Dfile.encoding=UTF-8',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      `-Dminecraft.launcher.brand=${LAUNCHER_BRAND}`,
      `-Dminecraft.launcher.version=${APP_VERSION}`,
      ...(usesBootstrap ? [`-Dminecraft.client.jar=${clientJar}`] : []),
      ...(usesLegacyDefaults
        ? [`-Djava.library.path=${nativesDir}`, '-cp', classpath.join(separator)]
        : jvmFromJson),
    ]

    if (session.authlibServer) {
      const jar = await authlibInjector.ensureJar()
      jvmArgs.push(`-javaagent:${jar}=${session.authlibServer}`)
    }

    const extraJvm = (instanceSettings.jvmArgs ?? settings.jvmArgs ?? '').trim()
    if (extraJvm) jvmArgs.push(...extraJvm.split(/\s+/))

    const namespaceArgs = expandArguments(resolved.json.arguments?.game, values, features)
    const legacyArgs = resolved.json.minecraftArguments
      ? resolved.json.minecraftArguments.split(/\s+/).filter(Boolean).map((a) => substitute(a, values))
      : []
    const gameArgs = namespaceArgs.length > 0 ? namespaceArgs : legacyArgs

    if (instanceSettings.fullscreen && !gameArgs.includes('--fullscreen')) gameArgs.push('--fullscreen')

    const extraGame = (instanceSettings.gameArgs ?? '').trim()
    if (extraGame) gameArgs.push(...extraGame.split(/\s+/))

    const mainClass = resolved.json.mainClass
    if (!mainClass) throw new Error('版本配置缺少 mainClass')

    const javaBin = path.join(javaInfo.path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    const args = [...jvmArgs, mainClass, ...gameArgs]

    const logFile = path.join(gameDir, 'logs', `${id}-latest.log`)
    ensureDir(path.dirname(logFile))
    const stream = fs.createWriteStream(logFile, { flags: 'w' })

    log.info('launching', id, 'on java', javaInfo.path, javaInfo.version)
    stream.write(`# BerryLauncher ${APP_VERSION} — ${new Date().toISOString()}\n`)
    stream.write(`# instance: ${id} (${resolved.mcVersion}) | java: ${javaBin} | memory: ${memory}MB\n`)
    stream.write(`# args: ${args.join(' ')}\n\n`)

    const child = spawn(javaBin, args, {
      cwd: instancePath,
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const status: LaunchStatus = {
      ...preparing,
      state: 'running',
      pid: child.pid,
      logPath: logFile,
    }

    const entry = {
      child,
      status,
      startedAt: Date.now(),
      stream,
      pending: [] as string[],
      timer: null as NodeJS.Timeout | null,
      stopping: false,
    }
    this.running.set(id, entry)

    const queueLine = (line: string) => {
      stream.write(`${line}\n`)
      entry.pending.push(line)
      if (entry.pending.length >= 100) flush()
      else if (!entry.timer) entry.timer = setTimeout(flush, 120)
    }
    const flush = () => {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      if (entry.pending.length === 0) return
      const lines = entry.pending.splice(0, entry.pending.length)
      this.emit('launch:log', { id, lines })
    }

    const pipe = (source: NodeJS.ReadableStream) => {
      let buffer = ''
      source.setEncoding('utf8')
      source.on('data', (chunk: string) => {
        buffer += chunk
        const parts = buffer.split(/\r?\n/)
        buffer = parts.pop() ?? ''
        for (const line of parts) queueLine(line)
        if (buffer.length > 8192) {
          queueLine(buffer)
          buffer = ''
        }
      })
      source.on('end', () => {
        if (buffer) queueLine(buffer)
      })
    }
    if (child.stdout) pipe(child.stdout)
    if (child.stderr) pipe(child.stderr)

    child.on('error', (err) => {
      flush()
      const failed: LaunchStatus = {
        ...status,
        state: 'failed',
        error: `无法启动 Java：${err.message}`,
      }
      this.emit('launch:status', failed)
      this.finishInstance(id, entry)
    })

    child.on('close', (code) => {
      flush()
      const exited: LaunchStatus = {
        ...status,
        state: code === 0 ? 'exited' : 'failed',
        exitCode: code,
        error: code === 0 ? undefined : `游戏异常退出（退出码 ${code}）`,
      }
      this.emit('launch:status', exited)
      stream.end()
      this.finishInstance(id, entry)
      log.info('instance exited', id, 'code', code)
    })

    playtime.start(id, {
      name: meta?.name ?? id,
      mcVersion: meta?.mcVersion ?? resolved.mcVersion,
      loader: meta?.loader ?? 'vanilla',
    })
    this.emit('launch:status', status)
    return status
  }

  stop(id: string): void {
    const entry = this.running.get(id)
    if (!entry || !entry.child.pid) return
    entry.stopping = true
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      entry.child.kill('SIGTERM')
      setTimeout(() => {
        if (this.running.has(id)) entry.child.kill('SIGKILL')
      }, 5000)
    }
  }

  private finishInstance(
    id: string,
    entry: { startedAt: number; stream: fs.WriteStream; pending: string[]; timer: NodeJS.Timeout | null },
  ): void {
    if (!this.running.has(id)) return
    this.running.delete(id)
    playtime.end(id)
    const gameDir = this.settings.get().gameDir
    const meta = readMeta(gameDir, id)
    if (meta) {
      const seconds = Math.max(0, Math.round((Date.now() - entry.startedAt) / 1000))
      writeMeta(gameDir, {
        ...meta,
        lastPlayedAt: Date.now(),
        playTimeSec: (meta.playTimeSec ?? 0) + seconds,
      })
    }
  }

  private buildClasspath(json: MojangVersionJson, gameDir: string, clientJar: string | null): string[] {
    const entries: string[] = []
    const seen = new Set<string>()
    for (const lib of json.libraries ?? []) {
      if (!rulesAllow(lib.rules)) continue
      if (isNativeLibrary(lib)) continue
      const artifact = libraryArtifact(lib)
      if (!artifact) continue
      const key = libraryKey(lib.name)
      if (seen.has(key)) continue
      seen.add(key)
      const full = path.join(gameDir, 'libraries', ...artifact.relPath.split('/'))
      if (!fs.existsSync(full)) {
        throw new Error(`缺少依赖库 ${artifact.relPath}，请重新安装该版本`)
      }
      entries.push(full)
    }
    if (clientJar) entries.push(clientJar)
    return entries
  }
}
