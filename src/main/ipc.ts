import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AuthlibLoginRequest,
  DeepPartial,
  InstallRequest,
  InstanceSettings,
  ModpackInstallRequest,
  ModrinthSearchQuery,
  Settings,
} from '../shared/types'
import { APP_VERSION } from '../shared/constants'
import { settingsStore } from './settings'
import { VersionService } from './versions'
import { JavaService, detectJava } from './java'
import { LoaderService } from './loaders'
import { AccountService } from './accounts'
import { LaunchService } from './launch'
import { InstallService } from './installer'
import { taskManager } from './tasks'
import { listInstances, deleteInstance, updateInstanceSettings, readMeta, writeMeta, instanceGameDir } from './instances'
import { dataDir, instanceDir } from './paths'
import { ModrinthService } from './modrinth'
import { ModService } from './mods'
import { ModpackService } from './modpacks'
import { ResourceStore, type ResourceTarget } from './resources'
import { playtime } from './playtime'
import type { SlimResult } from '../shared/types'
import { log } from './logger'

const settings = settingsStore

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

const versions = new VersionService(settings)
const javaService = new JavaService(
  () => settings.get().concurrency,
  () => settings.get().downloadSource,
)
const loaders = new LoaderService(versions, settings, javaService)
const modrinth = new ModrinthService()
const resources = new ResourceStore(settings)
const mods = new ModService(settings, modrinth, resources)
const modpacks = new ModpackService(loaders, modrinth, settings, resources)
const accounts = new AccountService(settings)
const launchService = new LaunchService(versions, settings, javaService, (channel, payload) =>
  broadcast(channel, payload),
)

accounts.setChangeListener((state) => broadcast('accounts:changed', state))

const installs = new InstallService(loaders, versions, settings, () => {
  broadcast('instances:changed', listInstances(versions))
})

taskManager.on('update', (task) => broadcast('task:update', task))

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      const data = await fn(...(args as A))
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`ipc ${channel} failed: ${message}`)
      return { ok: false, error: message }
    }
  })
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`参数 ${field} 无效`)
  return value
}

function resourceTargets(): ResourceTarget[] {
  const gameDir = settings.get().gameDir
  const isolated = settings.get().versionIsolation
  const running = new Set(launchService.runningIds())
  return listInstances(versions)
    .filter((instance) => !running.has(instance.id))
    .map((instance) => {
      const baseDir = instanceGameDir(gameDir, instance.id, readMeta(gameDir, instance.id), isolated)
      return {
        instanceId: instance.id,
        baseDir,
        dirs: [
          { kind: 'mods' as const, path: path.join(baseDir, 'mods') },
          { kind: 'resourcepacks' as const, path: path.join(baseDir, 'resourcepacks') },
          { kind: 'shaderpacks' as const, path: path.join(baseDir, 'shaderpacks') },
        ],
      }
    })
}

async function runSlim(): Promise<SlimResult> {
  const task = taskManager.create('storage', '整理资源存储', '扫描资源文件…')
  try {
    const result = await resources.slim(resourceTargets(), task)
    taskManager.finish(task.id, 'completed', {
      detail: `整理完成：新增共享 ${result.linked} 个，节省 ${(result.savedBytes / 1024 / 1024).toFixed(1)} MB`,
      progress: 1,
    })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    taskManager.finish(task.id, task.signal.aborted ? 'cancelled' : 'failed', { error: message })
    throw err
  }
}

export function registerIpc(): void {
  playtime.init(listInstances(versions))
  if (settings.get().resourceAutoSlim) {
    setTimeout(() => {
      void runSlim().catch((err) => log.warn('auto slim failed', err))
    }, 6000)
  }

  // ---------- app ----------
  handle('app:info', () => ({
    version: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    dataDir: dataDir(),
    gameDir: settings.get().gameDir,
    isPackaged: app.isPackaged,
    msConfigured: Boolean(settings.get().msClientId),
  }))

  ipcMain.on('app:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on('app:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('app:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())

  handle('app:open-external', async (url: string) => {
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('只允许打开 HTTP(S) 链接')
    await shell.openExternal(url)
  })

  handle('app:open-path', async (target: string) => {
    const result = await shell.openPath(target)
    if (result) throw new Error(result)
  })

  handle('app:choose-directory', async (title?: string) => {
    const result = await dialog.showOpenDialog({
      title: title ?? '选择文件夹',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.get().gameDir,
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })

  // ---------- settings ----------
  handle('settings:get', () => settings.get())
  handle('settings:update', (patch: DeepPartial<Settings>) => {
    const next = settings.update(patch)
    broadcast('settings:changed', next)
    return next
  })

  // ---------- versions ----------
  handle('versions:remote', (refresh?: boolean) => versions.getManifest(Boolean(refresh)))
  handle('versions:installed', () => listInstances(versions))
  handle('versions:loaders', (mcVersion: string, loader: string) => {
    requireString(mcVersion, 'mcVersion')
    if (!['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) throw new Error('未知加载器')
    return loaders.list(mcVersion, loader as never)
  })

  // ---------- installs ----------
  handle('installs:start', (req: InstallRequest) => installs.start(req))
  handle('installs:cancel', (taskId: string) => taskManager.cancel(taskId))

  // ---------- instances ----------
  handle('instances:launch', async (id: string) => {
    const session = await accounts.ensureSession()
    return launchService.launch(id, session)
  })
  handle('instances:stop', (id: string) => launchService.stop(id))
  handle('instances:remove', (id: string) => {
    if (launchService.isRunning(id)) throw new Error('实例正在运行，无法删除')
    deleteInstance(settings.get().gameDir, id, versions)
    playtime.markDeleted(id)
    resources.gc()
    broadcast('instances:changed', listInstances(versions))
  })
  handle('instances:open-folder', async (id: string) => {
    const gameDir = settings.get().gameDir
    const meta = readMeta(gameDir, id)
    const dir = instanceGameDir(gameDir, id, meta, settings.get().versionIsolation)
    fs.mkdirSync(dir, { recursive: true })
    const result = await shell.openPath(dir)
    if (result) throw new Error(result)
  })
  handle('instances:update-settings', (id: string, patch: DeepPartial<InstanceSettings>) => {
    updateInstanceSettings(settings.get().gameDir, id, patch as Partial<InstanceSettings>, versions)
    broadcast('instances:changed', listInstances(versions))
  })
  handle('instances:set-last-played', (id: string) => {
    const gameDir = settings.get().gameDir
    const meta = readMeta(gameDir, id)
    if (meta) writeMeta(gameDir, { ...meta, lastPlayedAt: Date.now() })
    broadcast('instances:changed', listInstances(versions))
  })
  handle('instances:read-log', (id: string) => {
    const file = path.join(settings.get().gameDir, 'logs', `${id}-latest.log`)
    try {
      const stat = fs.statSync(file)
      const start = Math.max(0, stat.size - 512 * 1024)
      const fd = fs.openSync(file, 'r')
      const buffer = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      fs.closeSync(fd)
      return buffer.toString('utf8')
    } catch {
      return ''
    }
  })

  // ---------- accounts ----------
  handle('accounts:state', () => accounts.publicState())
  handle('accounts:add-offline', (name: string) => accounts.addOffline(requireString(name, 'name')))
  handle('accounts:remove', (id: string) => accounts.remove(id))
  handle('accounts:set-active', (id: string) => accounts.setActive(id))
  handle('accounts:microsoft-start', () => accounts.startMicrosoft())
  handle('accounts:microsoft-poll', (deviceCode: string) => accounts.pollMicrosoft(deviceCode))

  // ---------- modrinth / mods / modpacks ----------
  handle('modrinth:search', (query: ModrinthSearchQuery) => modrinth.search(query))
  handle('modrinth:icon', (url: string) => modrinth.icon(requireString(url, 'url')))
  handle('modrinth:versions', (projectId: string, gameVersion?: string, loader?: string) =>
    modrinth.versions(projectId, gameVersion, loader),
  )
  handle('mods:list', (instanceId: string) => mods.list(instanceId))
  handle('mods:install', async (instanceId: string, versionId: string, withDependencies?: boolean) => {
    const task = taskManager.create('install', '安装模组', '解析依赖…')
    try {
      const result = await mods.install(instanceId, versionId, withDependencies !== false, task)
      taskManager.finish(task.id, 'completed', {
        detail: result.installed.length > 0 ? `已安装 ${result.installed.length} 个模组` : '没有需要安装的模组',
        progress: 1,
        resultId: instanceId,
      })
      broadcast('instances:changed', listInstances(versions))
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskManager.finish(task.id, task.signal.aborted ? 'cancelled' : 'failed', { error: message })
      throw err
    }
  })
  handle('mods:toggle', (instanceId: string, file: string) => {
    mods.toggle(instanceId, file)
    broadcast('instances:changed', listInstances(versions))
  })
  handle('mods:remove', (instanceId: string, file: string) => {
    mods.remove(instanceId, file)
    resources.gc()
    broadcast('instances:changed', listInstances(versions))
  })
  handle('modpacks:install', async (request: ModpackInstallRequest) => {
    const task = taskManager.create('install', '安装整合包', '准备中…')
    try {
      const id = await modpacks.install(request, task)
      taskManager.finish(task.id, 'completed', { detail: '整合包安装完成', progress: 1, resultId: id })
      broadcast('instances:changed', listInstances(versions))
      return id
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskManager.finish(task.id, task.signal.aborted ? 'cancelled' : 'failed', { error: message })
      throw err
    }
  })
  handle('modpacks:import-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 Modrinth 整合包',
      properties: ['openFile'],
      filters: [{ name: 'Minecraft 整合包', extensions: ['mrpack', 'zip'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const task = taskManager.create('install', '导入整合包', '准备中…')
    try {
      const id = await modpacks.importFile(result.filePaths[0], task)
      taskManager.finish(task.id, 'completed', { detail: '整合包导入完成', progress: 1, resultId: id })
      broadcast('instances:changed', listInstances(versions))
      return id
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskManager.finish(task.id, task.signal.aborted ? 'cancelled' : 'failed', { error: message })
      throw err
    }
  })
  handle('authlib:servers', () => accounts.authlibServers())
  handle('authlib:login', (request: AuthlibLoginRequest) => accounts.loginAuthlib(request))

  // ---------- storage / playtime ----------
  handle('storage:usage', () => resources.usage())
  handle('storage:slim', () => runSlim())
  handle('storage:gc', () => resources.gc())
  handle('storage:export', (instanceId: string) => {
    const gameDir = settings.get().gameDir
    const meta = readMeta(gameDir, instanceId)
    const baseDir = instanceGameDir(gameDir, instanceId, meta, settings.get().versionIsolation)
    return resources.exportResources({
      instanceId,
      baseDir,
      dirs: [
        { kind: 'mods', path: path.join(baseDir, 'mods') },
        { kind: 'resourcepacks', path: path.join(baseDir, 'resourcepacks') },
        { kind: 'shaderpacks', path: path.join(baseDir, 'shaderpacks') },
      ],
    })
  })
  handle('playtime:snapshot', () => playtime.snapshot())
  handle('playtime:reset', () => playtime.reset())

  // ---------- java ----------
  handle('java:detect', () => detectJava(settings.get().javaPath))
  handle('java:download', async (component: string) => {
    const task = taskManager.create('java', `下载 Java 运行时 ${component}`, '准备中…')
    try {
      const info = await javaService.downloadComponent(component, task.signal)
      taskManager.finish(task.id, 'completed', { detail: `Java ${info.version} 已就绪`, progress: 1 })
      return info
    } catch (err) {
      taskManager.finish(task.id, 'failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  })

  // ---------- tasks ----------
  handle('tasks:list', () => taskManager.list())
}
