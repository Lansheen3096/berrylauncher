import { useEffect, useMemo, useState } from 'react'
import { Check, DownloadCloud, Loader2, RefreshCw, Search } from 'lucide-react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Badge, Button, EmptyState, IconButton, Segmented, Spinner } from '../components/ui'
import { formatDate, formatRelative } from '../lib/format'
import type { RemoteVersion, VersionType } from '@shared/types'

type Tab = 'release' | 'snapshot' | 'old'

function matchesTab(version: RemoteVersion, tab: Tab): boolean {
  if (tab === 'release') return version.type === 'release'
  if (tab === 'snapshot') return version.type === 'snapshot'
  return version.type === 'old_beta' || version.type === 'old_alpha'
}

const TYPE_LABEL: Record<VersionType, string> = {
  release: '正式版',
  snapshot: '快照',
  old_beta: '远古 Beta',
  old_alpha: '远古 Alpha',
}

export function BrowsePage() {
  const remote = useStore((s) => s.remote)
  const remoteLoading = useStore((s) => s.remoteLoading)
  const loadRemote = useStore((s) => s.loadRemote)
  const instances = useStore((s) => s.instances)
  const openModal = useStore((s) => s.openModal)
  const toast = useStore((s) => s.toast)

  const [tab, setTab] = useState<Tab>('release')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(120)

  const latestReleaseId = useMemo(() => remote.find((v) => v.type === 'release')?.id, [remote])
  const latestSnapshotId = useMemo(() => remote.find((v) => v.type === 'snapshot')?.id, [remote])
  const installedIds = useMemo(() => new Set(instances.map((i) => i.id)), [instances])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return remote.filter((version) => matchesTab(version, tab) && (!q || version.id.toLowerCase().includes(q)))
  }, [remote, tab, query])

  useEffect(() => {
    setLimit(120)
  }, [tab, query])

  return (
    <div className="page browse-page">
      <header className="page-head">
        <div>
          <h1>版本库</h1>
          <p>来自 Mojang 官方清单 · 安装时可附加 Fabric / Forge / NeoForge 加载器</p>
        </div>
        <div className="page-head-actions">
          <div className="search">
            <Search size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索版本号，例如 1.20.1" />
          </div>
          <IconButton label="刷新版本清单" onClick={() => void loadRemote(true)} disabled={remoteLoading}>
            <RefreshCw size={16} className={remoteLoading ? 'spin' : undefined} />
          </IconButton>
        </div>
      </header>

      <div className="toolbar">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'release', label: '正式版' },
            { value: 'snapshot', label: '快照' },
            { value: 'old', label: '远古版本' },
          ]}
        />
        <span className="toolbar-count">{filtered.length} 个版本</span>
      </div>

      {remoteLoading && remote.length === 0 ? (
        <div className="version-list">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="version-row skeleton-row">
              <div className="skeleton skeleton-title" />
              <div className="skeleton skeleton-short" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<DownloadCloud size={26} />}
          title={remote.length === 0 ? '版本清单加载失败' : '没有匹配的版本'}
          description={remote.length === 0 ? '请检查网络连接后重试。' : '换个关键词，或切换到其他分类看看。'}
          action={
            remote.length === 0 ? (
              <Button variant="primary" size="sm" onClick={() => void loadRemote(true)}>
                重新加载
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <div className="version-list">
            {filtered.slice(0, limit).map((version) => {
              const installed = installedIds.has(version.id)
              return (
                <div key={version.id} className="version-row">
                  <div className="version-main">
                    <span className="version-id">{version.id}</span>
                    <div className="version-tags">
                      {version.id === latestReleaseId ? <Badge tone="accent">最新正式版</Badge> : null}
                      {version.id === latestSnapshotId ? <Badge tone="muted">最新快照</Badge> : null}
                      {version.type !== 'release' ? <Badge tone="muted">{TYPE_LABEL[version.type]}</Badge> : null}
                      {installed ? (
                        <Badge tone="accent">
                          <Check size={11} /> 已安装
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="version-side">
                    <span className="version-date" title={new Date(version.releaseTime).toLocaleString('zh-CN')}>
                      {formatDate(version.releaseTime)}
                    </span>
                    <Button
                      size="sm"
                      variant={installed ? 'secondary' : 'primary'}
                      onClick={() => openModal({ type: 'install', version })}
                    >
                      {installed ? '添加加载器' : '安装'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
          {limit < filtered.length ? (
            <div className="load-more">
              <Button variant="ghost" onClick={() => setLimit((v) => v + 120)} icon={<Loader2 size={15} />}>
                显示更多（剩余 {filtered.length - limit}）
              </Button>
            </div>
          ) : (
            <p className="list-footnote">
              共 {filtered.length} 个版本 · 最新版本发布于 {formatRelative(Date.parse(remote[0]?.releaseTime ?? ''))}
            </p>
          )}
        </>
      )}

      <div className="browse-tip">
        <Spinner size={14} />
        <span>提示：下载源可在「设置 → 游戏」切换为 BMCLAPI 镜像，国内网络会快很多。</span>
        <button className="link-button" onClick={() => toast('info', '镜像说明', 'BMCLAPI 由社区维护，用于加速 Mojang / Forge 资源下载。')}>
          了解镜像
        </button>
      </div>
    </div>
  )
}
