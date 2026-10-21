import { contextBridge, ipcRenderer } from 'electron'
import type { BerryAPI, EventMap, IpcResult } from '../shared/types'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    throw new Error(`IPC ${channel} 返回了无效结果`)
  }
  if (!result.ok) throw new Error(result.error)
  return result.data
}

const EVENT_CHANNELS: (keyof EventMap)[] = [
  'task:update',
  'launch:status',
  'launch:log',
  'settings:changed',
  'instances:changed',
  'accounts:changed',
  'navigate',
]

const api: BerryAPI = {
  app: {
    info: () => call('app:info'),
    minimize: () => ipcRenderer.send('app:minimize'),
    toggleMaximize: () => ipcRenderer.send('app:toggle-maximize'),
    close: () => ipcRenderer.send('app:close'),
    openExternal: (url) => call('app:open-external', url),
    openPath: (target) => call('app:open-path', target),
    chooseDirectory: (title) => call('app:choose-directory', title),
    relaunch: () => call('app:relaunch'),
  },
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch),
  },
  versions: {
    remote: (refresh) => call('versions:remote', refresh),
    installed: () => call('versions:installed'),
    loaders: (mcVersion, loader) => call('versions:loaders', mcVersion, loader),
  },
  installs: {
    start: (req) => call('installs:start', req),
    cancel: (taskId) => call('installs:cancel', taskId),
  },
  instances: {
    launch: (id) => call('instances:launch', id),
    stop: (id) => call('instances:stop', id),
    remove: (id) => call('instances:remove', id),
    openFolder: (id) => call('instances:open-folder', id),
    updateSettings: (id, patch) => call('instances:update-settings', id, patch),
    setLastPlayed: (id) => call('instances:set-last-played', id),
    readLog: (id) => call('instances:read-log', id),
  },
  accounts: {
    state: () => call('accounts:state'),
    addOffline: (name) => call('accounts:add-offline', name),
    remove: (id) => call('accounts:remove', id),
    setActive: (id) => call('accounts:set-active', id),
    microsoftStart: () => call('accounts:microsoft-start'),
    microsoftPoll: (deviceCode) => call('accounts:microsoft-poll', deviceCode),
  },
  java: {
    detect: () => call('java:detect'),
    download: (component) => call('java:download', component),
  },
  tasks: {
    list: () => call('tasks:list'),
  },
  on: (channel, listener) => {
    if (!EVENT_CHANNELS.includes(channel)) {
      throw new Error(`不允许监听事件 ${String(channel)}`)
    }
    const wrapped = (_event: Electron.IpcRendererEvent, payload: EventMap[typeof channel]) => listener(payload)
    ipcRenderer.on(channel, wrapped as never)
    return () => {
      ipcRenderer.removeListener(channel, wrapped as never)
    }
  },
}

contextBridge.exposeInMainWorld('berry', api)
