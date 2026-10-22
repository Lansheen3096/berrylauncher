import { create } from 'zustand'
import type {
  Account,
  PageId,
  DeepPartial,
  AccountsState,
  AppInfo,
  InstanceSummary,
  LaunchStatus,
  RemoteVersion,
  Settings,
  TaskUpdate,
} from '@shared/types'
import { api } from './api'

export type ModalState =
  | { type: 'install'; version: RemoteVersion }
  | { type: 'account' }
  | { type: 'instance'; id: string }
  | null

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  title: string
  detail?: string
}

interface State {
  ready: boolean
  page: PageId
  info: AppInfo | null
  settings: Settings | null
  instances: InstanceSummary[]
  accounts: AccountsState
  tasks: TaskUpdate[]
  remote: RemoteVersion[]
  remoteLoading: boolean
  selectedId: string | null
  launch: {
    status: LaunchStatus | null
    logs: string[]
    mode: 'hidden' | 'peek' | 'open'
    versionId: string | null
  }
  modal: ModalState
  toasts: Toast[]

  init: () => Promise<void>
  setPage: (page: State['page']) => void
  refreshInstances: () => Promise<void>
  refreshTasks: () => Promise<void>
  loadRemote: (refresh?: boolean) => Promise<void>
  selectInstance: (id: string) => void
  openModal: (modal: ModalState) => void
  toast: (kind: Toast['kind'], title: string, detail?: string) => void
  dismissToast: (id: number) => void
  play: (id?: string) => Promise<void>
  stop: (id: string) => Promise<void>
  removeInstance: (id: string) => Promise<void>
  setConsoleMode: (mode: 'hidden' | 'peek' | 'open') => void
  setLaunchStatus: (status: LaunchStatus) => void
  appendLogs: (lines: string[]) => void
  updateSettings: (patch: DeepPartial<Settings>) => Promise<void>
  setTasks: (task: TaskUpdate) => void
}

let toastSeq = 1

export const useStore = create<State>((set, get) => ({
  ready: false,
  page: 'home',
  info: null,
  settings: null,
  instances: [],
  accounts: { accounts: [], activeId: null },
  tasks: [],
  remote: [],
  remoteLoading: false,
  selectedId: null,
  launch: { status: null, logs: [], mode: 'hidden', versionId: null },
  modal: null,
  toasts: [],

  init: async () => {
    const [info, settings, instances, accounts, tasks] = await Promise.all([
      api.app.info(),
      api.settings.get(),
      api.versions.installed(),
      api.accounts.state(),
      api.tasks.list(),
    ])
    set({
      info,
      settings,
      instances,
      accounts,
      tasks,
      ready: true,
      selectedId: instances.find((i) => i.lastPlayedAt)?.id ?? instances[0]?.id ?? null,
    })
    void get().loadRemote(false)
  },

  setPage: (page) => set({ page }),

  refreshInstances: async () => {
    const instances = await api.versions.installed()
    set((state) => ({
      instances,
      selectedId: state.selectedId && instances.some((i) => i.id === state.selectedId) ? state.selectedId : instances[0]?.id ?? null,
    }))
  },

  refreshTasks: async () => {
    set({ tasks: await api.tasks.list() })
  },

  loadRemote: async (refresh = false) => {
    set({ remoteLoading: true })
    try {
      set({ remote: await api.versions.remote(refresh) })
    } catch (err) {
      get().toast('error', '获取版本列表失败', err instanceof Error ? err.message : String(err))
    } finally {
      set({ remoteLoading: false })
    }
  },

  selectInstance: (id) => set({ selectedId: id }),

  openModal: (modal) => set({ modal }),

  toast: (kind, title, detail) => {
    const id = toastSeq++
    set((state) => ({ toasts: [...state.toasts, { id, kind, title, detail }].slice(-4) }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000)
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  play: async (id) => {
    const target = id ?? get().selectedId
    if (!target) {
      get().toast('info', '还没有安装任何版本', '先去版本库安装一个 Minecraft 吧')
      set({ page: 'browse' })
      return
    }
    if (get().accounts.accounts.length === 0) {
      get().toast('info', '需要先添加一个账户', '离线账户也可以游玩单人游戏')
      set({ modal: { type: 'account' } })
      return
    }
    set((state) => ({
      launch: {
        status: null,
        logs: [],
        mode: state.settings?.consoleAutoOpen ? 'open' : 'peek',
        versionId: target,
      },
      selectedId: target,
    }))
    try {
      const status = await api.instances.launch(target)
      set((state) => ({ launch: { ...state.launch, status } }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const failed: LaunchStatus = {
        id: `local-${Date.now()}`,
        versionId: target,
        state: 'failed',
        startedAt: Date.now(),
        error: message,
      }
      set((state) => ({ launch: { ...state.launch, status: failed } }))
      get().toast('error', '启动失败', message)
    }
  },

  stop: async (id) => {
    await api.instances.stop(id)
  },

  removeInstance: async (id) => {
    try {
      await api.instances.remove(id)
      get().toast('success', '实例已删除')
      await get().refreshInstances()
    } catch (err) {
      get().toast('error', '删除失败', err instanceof Error ? err.message : String(err))
    }
  },

  setConsoleMode: (mode) => set((state) => ({ launch: { ...state.launch, mode } })),

  setLaunchStatus: (status) =>
    set((state) => {
      let mode = state.launch.mode
      if (status.state === 'failed') mode = 'open'
      else if (status.state === 'exited') mode = mode === 'hidden' ? 'hidden' : 'peek'
      else if (status.state === 'preparing' && mode === 'hidden') mode = 'peek'
      return { launch: { ...state.launch, status, mode } }
    }),

  appendLogs: (lines) =>
    set((state) => ({
      launch: { ...state.launch, logs: [...state.launch.logs, ...lines].slice(-1500) },
    })),

  updateSettings: async (patch) => {
    const next = await api.settings.update(patch)
    set({ settings: next })
  },

  setTasks: (task) =>
    set((state) => {
      const exists = state.tasks.some((t) => t.id === task.id)
      const tasks = exists ? state.tasks.map((t) => (t.id === task.id ? task : t)) : [task, ...state.tasks]
      if (task.status === 'completed' && task.kind === 'install' && !exists) void get().refreshInstances()
      return { tasks }
    }),
}))

export function activeAccount(accounts: AccountsState): Account | null {
  return accounts.accounts.find((a) => a.id === accounts.activeId) ?? accounts.accounts[0] ?? null
}
