import type { InstallRequest } from '../shared/types'
import type { LoaderService } from './loaders'
import { taskManager, TaskCancelledError, type TaskReporter } from './tasks'
import type { SettingsStore } from './settings'
import type { VersionService } from './versions'
import { createInstanceMeta, ensureInstanceFolders, writeMeta } from './instances'
import { log } from './logger'

export class InstallService {
  constructor(
    private readonly loaders: LoaderService,
    private readonly versions: VersionService,
    private readonly settings: SettingsStore,
    private readonly onChanged: () => void,
  ) {}

  start(req: InstallRequest): string {
    if (!req.mcVersion) throw new Error('缺少游戏版本')
    const label =
      req.loader === 'vanilla'
        ? `Minecraft ${req.mcVersion}`
        : `${req.loader === 'neoforge' ? 'NeoForge' : req.loader.charAt(0).toUpperCase() + req.loader.slice(1)} ${req.loaderVersion ?? ''} · ${req.mcVersion}`

    const task = taskManager.create('install', `安装 ${label}`, '准备中…')
    void this.run(req, task, label)
    return task.id
  }

  private async run(req: InstallRequest, task: TaskReporter, label: string): Promise<void> {
    try {
      if (this.settings.get().gameDir == null) throw new Error('游戏目录无效')
      task.throwIfCancelled()
      const id = await this.loaders.install(req, task)
      taskManager.finish(task.id, 'completed', { detail: `${label} 安装完成`, resultId: id })
      this.onChanged()
    } catch (err) {
      if (err instanceof TaskCancelledError || task.signal.aborted) {
        taskManager.finish(task.id, 'cancelled', { detail: '已取消' })
        return
      }
      log.error('install failed', label, err)
      taskManager.finish(task.id, 'failed', {
        error: err instanceof Error ? err.message : String(err),
        detail: '安装失败',
      })
    }
  }

  /** Creates instance metadata for an already existing version folder. */
  adoptExisting(id: string, mcVersion: string): void {
    const gameDir = this.settings.get().gameDir
    const meta = createInstanceMeta(id, 'vanilla', mcVersion, undefined, {})
    writeMeta(gameDir, meta)
    ensureInstanceFolders(gameDir, id)
  }

  get versionService(): VersionService {
    return this.versions
  }
}
