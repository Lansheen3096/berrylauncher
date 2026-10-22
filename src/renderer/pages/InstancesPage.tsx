import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  FolderOpen,
  Package,
  Play,
  Plus,
  Settings2,
  Square,
  Trash2,
} from 'lucide-react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Badge, Button, Card, EmptyState, Field, IconButton, Modal, Slider, Spinner } from '../components/ui'
import { LOADER_COLORS } from '@shared/constants'
import { clamp, formatBytes, formatRelative, loaderInitial, loaderLabel } from '../lib/format'
import type { InstalledMod, InstanceSummary } from '@shared/types'

function ModsDialog({ instance, onClose }: { instance: InstanceSummary; onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const setPage = useStore((s) => s.setPage)
  const [mods, setMods] = useState<InstalledMod[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    setLoading(true)
    try {
      setMods(await api.mods.list(instance.id))
    } catch (err) {
      toast('error', '读取模组失败', err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id])

  return (
    <Modal
      title="模组管理"
      subtitle={`${instance.name} · ${instance.mcVersion} / ${loaderLabel(instance.loader)}`}
      onClose={onClose}
      size="lg"
      footer={
        <div className="install-foot">
          <span className="muted-text">
            {mods.filter((mod) => mod.enabled).length} 个启用 · {mods.length} 个文件
          </span>
          <div className="install-foot-actions">
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={15} />}
              onClick={() => {
                onClose()
                setPage('discover')
              }}
            >
              去资源库添加
            </Button>
          </div>
        </div>
      }
    >
      {loading ? (
        <div className="inline-loading">
          <Spinner size={16} /> 正在读取模组…
        </div>
      ) : mods.length === 0 ? (
        <div className="mods-dialog-empty">这个实例还没有模组。去资源库搜索并安装吧。</div>
      ) : (
        <div className="mods-list">
          {mods.map((mod) => (
            <div key={mod.file} className={`mod-row ${mod.enabled ? '' : 'disabled'}`}>
              {mod.iconUrl ? (
                <img className="mod-row-icon" src={mod.iconUrl} alt="" />
              ) : (
                <span className="mod-row-icon mod-icon-empty">
                  <Package size={14} />
                </span>
              )}
              <div className="mod-row-text">
                <strong>{mod.title ?? mod.name}</strong>
                <em>
                  {mod.versionNumber ?? mod.file} · {(mod.size / 1024).toFixed(0)} KB
                </em>
              </div>
              <div className="mod-row-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await api.mods.toggle(instance.id, mod.file)
                      await refresh()
                    } catch (err) {
                      toast('error', '切换失败', err instanceof Error ? err.message : String(err))
                    }
                  }}
                >
                  {mod.enabled ? '禁用' : '启用'}
                </Button>
                <IconButton
                  label="删除模组"
                  tone="danger"
                  onClick={async () => {
                    try {
                      await api.mods.remove(instance.id, mod.file)
                      await refresh()
                      toast('success', '模组已删除')
                    } catch (err) {
                      toast('error', '删除失败', err instanceof Error ? err.message : String(err))
                    }
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

function InstanceCard({ instance }: { instance: InstanceSummary }) {
  const play = useStore((s) => s.play)
  const stop = useStore((s) => s.stop)
  const remove = useStore((s) => s.removeInstance)
  const launch = useStore((s) => s.launch)
  const toast = useStore((s) => s.toast)
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [modsOpen, setModsOpen] = useState(false)
  const [memory, setMemory] = useState(instance.settings.memoryMB ?? 0)
  const [jvmArgs, setJvmArgs] = useState(instance.settings.jvmArgs ?? '')

  const running = launch.status?.state === 'running' && launch.status.versionId === instance.id

  const save = async () => {
    try {
      await api.instances.updateSettings(instance.id, {
        memoryMB: memory || undefined,
        jvmArgs: jvmArgs || undefined,
      })
      toast('success', '实例设置已保存')
      setEditing(false)
    } catch (err) {
      toast('error', '保存失败', err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <Card className={`instance-card ${running ? 'instance-running' : ''}`}>
        <div className="instance-card-head">
          <span className="instance-mark" style={{ background: LOADER_COLORS[instance.loader] }}>
            {loaderInitial(instance.loader)}
          </span>
          <div className="instance-head-text">
            <strong>{instance.name}</strong>
            <em>
              {instance.mcVersion} · {loaderLabel(instance.loader)}
              {instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}
            </em>
          </div>
          {running ? (
            <span className="running-dot">
              <span /> 运行中
            </span>
          ) : instance.broken ? (
            <Badge tone="danger">配置损坏</Badge>
          ) : instance.pack ? (
            <Badge tone="accent">整合包</Badge>
          ) : null}
        </div>

        <div className="instance-meta">
          {instance.pack ? <span className="pack-badge">{instance.pack.name} {instance.pack.versionId}</span> : null}
          <span>{formatRelative(instance.lastPlayedAt)}</span>
          <span className="dot" />
          <span>{instance.modCount ? `${instance.modCount} 个模组` : instance.size && instance.size > 100_000 ? formatBytes(instance.size) : '—'}</span>
          {instance.settings.memoryMB ? (
            <>
              <span className="dot" />
              <span>{instance.settings.memoryMB} MB 内存</span>
            </>
          ) : null}
        </div>

        <div className="instance-actions">
          <Button
            variant={running ? 'danger' : 'primary'}
            size="sm"
            icon={running ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            onClick={() => (running ? void stop(instance.id) : void play(instance.id))}
          >
            {running ? '停止' : '启动'}
          </Button>
          <div className="instance-actions-right">
            <IconButton label="模组管理" onClick={() => setModsOpen(true)}>
              <Package size={16} />
            </IconButton>
            <IconButton label="打开实例目录" onClick={() => void api.instances.openFolder(instance.id).catch((e) => toast('error', '打开失败', String(e)))}>
              <FolderOpen size={16} />
            </IconButton>
            <IconButton label="实例设置" onClick={() => setEditing(true)}>
              <Settings2 size={16} />
            </IconButton>
            <IconButton label="删除实例" tone="danger" onClick={() => setConfirming(true)}>
              <Trash2 size={16} />
            </IconButton>
          </div>
        </div>
      </Card>

      {modsOpen ? <ModsDialog instance={instance} onClose={() => setModsOpen(false)} /> : null}

      {editing ? (
        <Modal
          title="实例设置"
          subtitle={`${instance.name} · ${instance.mcVersion}`}
          onClose={() => setEditing(false)}
          footer={
            <div className="modal-actions">
              <Button variant="ghost" onClick={() => setEditing(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void save()}>
                保存
              </Button>
            </div>
          }
        >
          <Field label="最大内存" hint={`${((memory || 0) / 1024).toFixed(1)} GB · 留空使用全局默认`}>
            <Slider
              value={memory || 4096}
              min={1024}
              max={clamp(16384, 1024, 32768)}
              step={512}
              onChange={setMemory}
              format={(v) => `${(v / 1024).toFixed(1)} GB`}
            />
          </Field>
          <Field label="额外 JVM 参数" hint="每行或空格分隔，例如 -XX:+UseG1GC">
            <input className="input" value={jvmArgs} onChange={(e) => setJvmArgs(e.target.value)} placeholder="留空使用全局设置" />
          </Field>
          <p className="option-note">修改内存后需要重新启动游戏才会生效。</p>
        </Modal>
      ) : null}

      {confirming ? (
        <Modal
          title="删除实例？"
          subtitle={`${instance.name} 的版本文件与独立存档目录都会被删除，此操作不可撤销。`}
          onClose={() => setConfirming(false)}
          size="sm"
          footer={
            <div className="modal-actions">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                取消
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(false)
                  void remove(instance.id)
                }}
              >
                删除
              </Button>
            </div>
          }
        >
          <div className="confirm-body">
            <AlertTriangle size={18} />
            <span>共享的游戏资源（libraries / assets）不会被删除，其他实例仍可正常使用。</span>
          </div>
        </Modal>
      ) : null}
    </>
  )
}

export function InstancesPage() {
  const instances = useStore((s) => s.instances)
  const setPage = useStore((s) => s.setPage)

  return (
    <div className="page instances-page">
      <header className="page-head">
        <div>
          <h1>实例</h1>
          <p>每个实例拥有独立的存档、模组与日志目录</p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setPage('browse')}>
          安装新实例
        </Button>
      </header>

      {instances.length === 0 ? (
        <EmptyState
          icon={<Boxes size={28} />}
          title="还没有实例"
          description="从版本库挑一个 Minecraft 版本，再选择 Fabric、Forge 或 NeoForge。"
          action={
            <Button variant="primary" onClick={() => setPage('browse')}>
              去版本库
            </Button>
          }
        />
      ) : (
        <div className="instance-grid">
          {instances.map((instance) => (
            <InstanceCard key={instance.id} instance={instance} />
          ))}
        </div>
      )}
    </div>
  )
}
