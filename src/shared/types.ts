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

export interface ModpackInfo {
  name: string
  versionId: string
  projectId?: string
  source: 'modrinth' | 'file'
  iconUrl?: string
  summary?: string
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
  modCount?: number
  pack?: ModpackInfo
}

export type AccountType = 'offline' | 'microsoft' | 'authlib'

export interface Account {
  id: string
  type: AccountType
  name: string
  uuid: string
  /** Epoch ms; only for Microsoft accounts. */
  expiresAt?: number
  skinUrl?: string
  /** Yggdrasil / authlib-injector API root, e.g. MUA. */
  authlibServer?: string
}

export interface AuthlibLoginRequest {
  server: string
  username: string
  password: string
}

export interface AuthlibServerInfo {
  url: string
  name: string
  registerUrl?: string
}

export interface ModrinthProject {
  id: string
  slug: string
  title: string
  description: string
  iconUrl?: string
  downloads: number
  follows: number
  categories: string[]
  clientSide: string
  serverSide: string
  projectType: string
  author?: string
  versions?: string[]
}

export interface ModrinthSearchQuery {
  query: string
  projectType: 'mod' | 'modpack'
  gameVersion?: string
  loader?: string
  category?: string
  sort?: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'
  offset?: number
  limit?: number
}

export interface ModrinthSearchResult {
  hits: ModrinthProject[]
  totalHits: number
  offset: number
  limit: number
}

export interface ModrinthFile {
  filename: string
  url: string
  size: number
  primary: boolean
  hashes: { sha1?: string; sha512?: string }
}

export interface ModrinthDependency {
  versionId?: string
  projectId?: string
  fileName?: string
  dependencyType: 'required' | 'optional' | 'incompatible' | 'embedded'
}

export interface ModrinthVersion {
  id: string
  projectId: string
  name: string
  versionNumber: string
  gameVersions: string[]
  loaders: string[]
  datePublished: string
  downloads: number
  files: ModrinthFile[]
  dependencies: ModrinthDependency[]
}

export interface InstalledMod {
  file: string
  name: string
  enabled: boolean
  size: number
  sha1?: string
  projectId?: string
  versionId?: string
  versionNumber?: string
  title?: string
  iconUrl?: string
}

export interface ModInstallResult {
  installed: InstalledMod[]
  skipped: string[]
  instanceId: string
}

export interface ModpackInstallRequest {
  projectId?: string
  versionId?: string
  filePath?: string
  instanceName?: string
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
  /** Open the log console automatically when a game starts. */
  consoleAutoOpen: boolean
  /** Per-instance mods/saves/config isolation (classic version isolation). */
  versionIsolation: boolean
  /** Opt-in background dedupe of manually added resources. */
  resourceAutoSlim: boolean
}

export type TaskKind = 'install' | 'java' | 'assets' | 'storage'
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

export type PageId = 'home' | 'browse' | 'instances' | 'downloads' | 'discover' | 'settings'

export interface ResourceUsage {
  storeBytes: number
  storeFiles: number
  linkedFiles: number
  savedBytes: number
  copyFallback: number
}

export interface SlimResult {
  scanned: number
  linked: number
  moved: number
  savedBytes: number
  skipped: number
  errors: string[]
}

export interface ResourceExportResult {
  path: string
  files: number
  bytes: number
}

export interface InstancePlaytime {
  id: string
  name: string
  mcVersion: string
  loader: LoaderKind
  seconds: number
  lastPlayedAt?: number
  deleted?: boolean
}

export interface McVersionPlaytime {
  mcVersion: string
  seconds: number
  instances: number
}

export interface PlaytimeSnapshot {
  totalSeconds: number
  byInstance: InstancePlaytime[]
  byMcVersion: McVersionPlaytime[]
  active: { id: string; startedAt: number }[]
}

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
  modrinth: {
    search(query: ModrinthSearchQuery): Promise<ModrinthSearchResult>
    versions(projectId: string, gameVersion?: string, loader?: string): Promise<ModrinthVersion[]>
  }
  mods: {
    list(instanceId: string): Promise<InstalledMod[]>
    install(instanceId: string, versionId: string, withDependencies?: boolean): Promise<ModInstallResult>
    toggle(instanceId: string, file: string): Promise<void>
    remove(instanceId: string, file: string): Promise<void>
  }
  modpacks: {
    install(request: ModpackInstallRequest): Promise<string>
    importFile(): Promise<string | null>
  }
  authlib: {
    servers(): Promise<AuthlibServerInfo[]>
    login(request: AuthlibLoginRequest): Promise<Account>
  }
  storage: {
    usage(): Promise<ResourceUsage>
    slim(): Promise<SlimResult>
    gc(): Promise<{ freedBytes: number; removed: number }>
    exportResources(instanceId: string): Promise<ResourceExportResult>
  }
  playtime: {
    snapshot(): Promise<PlaytimeSnapshot>
    reset(): Promise<void>
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
