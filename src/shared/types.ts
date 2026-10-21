/**
 * Shared contracts between the Electron main process and the renderer.
 * Keep this file free of Node/DOM specific imports so both sides can use it.
 */

export type LoaderKind = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge'
export type VersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha'

/** An entry of Mojang's version_manifest_v2.json. */
export interface RemoteVersion {
  id: string
  type: VersionType
  releaseTime: string
  url: string
  sha1: string
}

export interface LoaderVersion {
  version: string
  stable: boolean
  gameVersion: string
  recommended?: boolean
}

export interface InstallRequest {
  mcVersion: string
  loader: LoaderKind
  loaderVersion?: string
  /** Optional custom instance id; generated from loader+version otherwise. */
  name?: string
}

export interface InstanceSettings {
  memoryMB?: number
  javaPath?: string
  jvmArgs?: string
  gameArgs?: string
  width?: number
  height?: number
  fullscreen?: boolean
}

export interface InstanceSummary {
  id: string
  name: string
  mcVersion: string
  loader: LoaderKind
  loaderVersion?: string
  createdAt: number
  lastPlayedAt?: number
  playTimeSec?: number
  settings: InstanceSettings
  broken?: boolean
  /** Total size of the version folder in bytes (best effort). */
  size?: number
}

export type AccountType = 'offline' | 'microsoft'

export interface Account {
  id: string
  type: AccountType
  name: string
  uuid: string
  /** Epoch ms; only for Microsoft accounts. */
  expiresAt?: number
  skinUrl?: string
}

export interface AccountsState {
  accounts: Account[]
  activeId: string | null
}

export interface DeviceCodeInfo {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  message: string
}

export type DownloadSource = 'official' | 'bmclapi'
export type ThemeMode = 'dark' | 'light'

export interface Settings {
  theme: {
    accent: string
    mode: ThemeMode
  }
  gameDir: string
  downloadSource: DownloadSource
  /** Parallel download connections. */
  concurrency: number
  /** Default heap for new instances; per-instance override wins. */
  memoryMB: number
  /** 0 means "let the launcher auto-detect". */
  javaPath: string
  jvmArgs: string
  /** Azure application (client) ID used by the Microsoft device-code flow. */
  msClientId: string
}

export type TaskKind = 'install' | 'java' | 'assets'
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TaskUpdate {
  id: string
  kind: TaskKind
  title: string
  detail: string
  /** 0..1, or null when indeterminate. */
  progress: number | null
  received: number
  total: number
  /** bytes per second, smoothed */
  speed: number
  status: TaskStatus
  error?: string
  startedAt: number
  finishedAt?: number
  /** Instance id produced by an install task. */
  resultId?: string
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
  dataDir: string
  gameDir: string
  isPackaged: boolean
  /** Whether the device-code flow has a client id configured. */
  msConfigured: boolean
}

export interface JavaInfo {
  path: string
  version: string
  major: number
  source: 'system' | 'bundled' | 'custom' | 'downloaded'
}

export interface LaunchStatus {
  id: string
  versionId: string
  state: 'preparing' | 'running' | 'exited' | 'failed'
  pid?: number
  exitCode?: number | null
  startedAt: number
  message?: string
  logPath?: string
  /** Only set on failure, user friendly. */
  error?: string
}

export interface VersionDetails {
  id: string
  type: VersionType
  releaseTime: string
  javaMajor: number
}

export interface NewsItem {
  title: string
  body: string
  tag: string
}

/** Events pushed from main -> renderer. */
export interface EventMap {
  'task:update': TaskUpdate
  'launch:status': LaunchStatus
  'launch:log': { id: string; lines: string[] }
  'settings:changed': Settings
  'instances:changed': InstanceSummary[]
  'accounts:changed': AccountsState
  'navigate': { page: PageId }
}

export type PageId = 'home' | 'browse' | 'instances' | 'downloads' | 'settings'

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface BerryAPI {
  app: {
    info(): Promise<AppInfo>
    minimize(): void
    toggleMaximize(): void
    close(): void
    openExternal(url: string): Promise<void>
    openPath(target: string): Promise<void>
    chooseDirectory(title?: string): Promise<string | null>
    relaunch(): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: DeepPartial<Settings>): Promise<Settings>
  }
  versions: {
    remote(refresh?: boolean): Promise<RemoteVersion[]>
    installed(): Promise<InstanceSummary[]>
    loaders(mcVersion: string, loader: LoaderKind): Promise<LoaderVersion[]>
  }
  installs: {
    start(req: InstallRequest): Promise<string>
    cancel(taskId: string): Promise<void>
  }
  instances: {
    launch(id: string): Promise<LaunchStatus>
    stop(id: string): Promise<void>
    remove(id: string): Promise<void>
    openFolder(id: string): Promise<void>
    updateSettings(id: string, patch: DeepPartial<InstanceSettings>): Promise<void>
    setLastPlayed(id: string): Promise<void>
    readLog(id: string): Promise<string>
  }
  accounts: {
    state(): Promise<AccountsState>
    addOffline(name: string): Promise<Account>
    remove(id: string): Promise<void>
    setActive(id: string): Promise<void>
    microsoftStart(): Promise<DeviceCodeInfo>
    microsoftPoll(deviceCode: string): Promise<Account | null>
  }
  java: {
    detect(): Promise<JavaInfo[]>
    download(component: string): Promise<JavaInfo>
  }
  tasks: {
    list(): Promise<TaskUpdate[]>
  }
  on<K extends keyof EventMap>(channel: K, listener: (payload: EventMap[K]) => void): () => void
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export interface MojangVersionJson {
  id: string
  type: VersionType
  mainClass: string
  inheritsFrom?: string
  minecraftArguments?: string
  arguments?: {
    game?: (string | ArgumentRule)[]
    jvm?: (string | ArgumentRule)[]
  }
  assetIndex?: { id: string; url: string; sha1: string; size: number; totalSize: number }
  assets?: string
  downloads?: Record<string, { url: string; sha1: string; size: number; path?: string }>
  javaVersion?: { component: string; majorVersion: number }
  libraries: Library[]
  logging?: { client?: { argument: string; file: { id: string; url: string; sha1: string; size: number } } }
  releaseTime?: string
  time?: string
  complianceLevel?: number
}

export interface ArgumentRule {
  rules: Rule[]
  value: string | string[]
}

export interface Rule {
  action: 'allow' | 'disallow'
  os?: { name?: string; arch?: string; version?: string }
  features?: Record<string, boolean>
}

export interface Library {
  name: string
  downloads?: {
    artifact?: { url: string; sha1: string; size: number; path: string }
    classifiers?: Record<string, { url: string; sha1: string; size: number; path: string }>
  }
  natives?: Record<string, string>
  rules?: Rule[]
  extract?: { exclude?: string[] }
  url?: string
}
