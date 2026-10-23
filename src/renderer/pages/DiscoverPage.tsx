import { useEffect, useMemo, useState } from 'react'
import { Boxes, Download, Package, Search, SlidersHorizontal, Sparkles, Upload } from 'lucide-react'
import type { InstanceSummary, ModrinthProject, ModrinthVersion } from '@shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Badge, Button, EmptyState, Modal, ProgressBar, Segmented, Select, Spinner } from '../components/ui'
import { formatDate, loaderLabel } from '../lib/format'

type Tab = 'mod' | 'modpack'
type Sort = 'relevance' | 'downloads' | 'follows' | 'newest'

const LOADERS = [
  { value: '', label: '全部加载器' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
]

function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function ProjectCard({ project, onOpen }: { project: ModrinthProject; onOpen: () => void }) {
  const [iconSrc, setIconSrc] = useState(project.iconUrl ?? '')
  const [iconFailed, setIconFailed] = useState(!project.iconUrl)
  const [triedFallback, setTriedFallback] = useState(false)

  useEffect(() => {
    setIconSrc(project.iconUrl ?? '')
    setIconFailed(!project.iconUrl)
    setTriedFallback(false)
  }, [project.id, project.iconUrl])

  const onIconError = async () => {
    if (!project.iconUrl || triedFallback) {
      setIconFailed(true)
      return
    }
    setTriedFallback(true)
    const cached = await api.modrinth.icon(project.iconUrl).catch(() => null)
    if (cached) {
      setIconSrc(cached)
      setIconFailed(false)
    } else {
      setIconFailed(true)
    }
  }

  return (
    <button className="mod-card" onClick={onOpen}>
      <div className="mod-card-head">
        {!iconFailed && iconSrc ? (
          <img
            className="mod-icon"
            src={iconSrc}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => void onIconError()}
          />
        ) : (
          <span className="mod-icon mod-icon-empty" aria-label={project.title}>
            <Package size={20} />
          </span>
        )}
        <div className="mod-card-title">
          <strong>{project.title}</strong>
          <em>{project.author ?? project.slug}</em>
        </div>
        <span className="mod-downloads">
          <Download size={12} /> {compactNumber(project.downloads)}
        </span>
      </div>
      <p className="mod-desc">{project.description}</p>
      <div className="mod-tags">
        {project.categories.slice(0, 4).map((category) => (
          <span key={category} className="chip">
            {category}
          </span>
        ))}
      </div>
    </button>
  )
}

function InstallModal({
  project,
  tab,
  gameVersion,
  loader,
  onClose,
}: {
  project: ModrinthProject
  tab: Tab
  gameVersion: string
  loader: string
  onClose: () => void
}) {
  const instances = useStore((s) => s.instances)
  const toast = useStore((s) => s.toast)
  const setPage = useStore((s) => s.setPage)
  const [versions, setVersions] = useState<ModrinthVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [target, setTarget] = useState('')
  const [installing, setInstalling] = useState(false)

  const targetInstance = instances.find((instance) => instance.id === target)
  const effectiveGame = gameVersion || (tab === 'mod' ? targetInstance?.mcVersion : undefined)
  const effectiveLoader =
    loader || (tab === 'mod' && targetInstance && targetInstance.loader !== 'vanilla' ? targetInstance.loader : undefined)

  const compatibleInstances = useMemo(
    () =>
      instances.filter((instance) => {
        if (!gameVersion) return true
        return instance.mcVersion === gameVersion
      }),
    [instances, gameVersion],
  )

  useEffect(() => {
    setLoading(true)
    setError('')
    void api.modrinth
      .versions(project.id, effectiveGame, effectiveLoader)
      .then((list) => {
        setVersions(list)
        setSelected(list[0]?.id ?? '')
        if (list.length === 0) setError('当前筛选条件下没有可安装的版本')
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [project.id, effectiveGame, effectiveLoader])

  useEffect(() => {
    if (compatibleInstances.length === 0) {
      setTarget('')
      return
    }
    if (!compatibleInstances.some((instance) => instance.id === target)) {
      setTarget(compatibleInstances[0].id)
    }
  }, [compatibleInstances, target])

  const selectedVersion = versions.find((version) => version.id === selected)

  const install = async () => {
    if (!selectedVersion) return
    setInstalling(true)
    setError('')
    try {
      if (tab === 'modpack') {
        await api.modpacks.install({ projectId: project.id, versionId: selectedVersion.id })
        toast('success', '整合包已加入安装队列', `${project.title} ${selectedVersion.versionNumber}`)
        onClose()
      } else {
        if (!target) throw new Error('请先选择一个实例')
        const result = await api.mods.install(target, selectedVersion.id, true)
        toast(
          'success',
          `已安装 ${result.installed.length} 个模组`,
          result.skipped.length > 0 ? `跳过 ${result.skipped.length} 项依赖` : project.title,
        )
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Modal
      title={
        <span className="install-title">
          {project.title}
          <Badge tone="muted">{tab === 'modpack' ? '整合包' : '模组'}</Badge>
        </span>
      }
      subtitle={project.description}
      onClose={onClose}
      size="lg"
      footer={
        <div className="install-foot">
          <div className="install-foot-message">
            {error ? <span className="error-text">{error}</span> : <span className="muted-text">{versions.length} 个版本可用</span>}
          </div>
          <div className="install-foot-actions">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={installing}
              disabled={!selectedVersion || (tab === 'mod' && !target)}
              onClick={() => void install()}
            >
              {tab === 'modpack' ? '安装整合包' : '安装到实例'}
            </Button>
          </div>
        </div>
      }
    >
      {tab === 'mod' ? (
        <div className="mod-install-target">
          <label>安装到</label>
          {instances.length === 0 ? (
            <div className="no-instance-hint">
              <p className="muted-text">还没有实例，请先在版本库安装一个游戏版本。</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onClose()
                  setPage('browse')
                }}
              >
                去版本库
              </Button>
            </div>
          ) : compatibleInstances.length === 0 ? (
            <p className="error-text">没有与 {gameVersion} 匹配的实例，请调整筛选或先安装对应版本。</p>
          ) : (
            <Select
              value={target}
              onChange={setTarget}
              options={compatibleInstances.map((instance) => ({
                value: instance.id,
                label: `${instance.name} · ${instance.mcVersion} / ${loaderLabel(instance.loader)}`,
              }))}
            />
          )}
        </div>
      ) : null}

      {loading ? (
        <div className="inline-loading">
          <Spinner size={16} /> 正在获取版本…
        </div>
      ) : (
        <div className="version-picker">
          {versions.slice(0, 40).map((version) => (
            <button
              key={version.id}
              className={`version-choice ${selected === version.id ? 'active' : ''}`}
              onClick={() => setSelected(version.id)}
            >
              <div className="version-choice-main">
                <strong>{version.versionNumber}</strong>
                <em>{version.name}</em>
              </div>
              <div className="version-choice-meta">
                <span>{version.gameVersions.slice(-3).join(', ')}</span>
                <span>{version.loaders.join(' / ')}</span>
                <span>{formatDate(version.datePublished)}</span>
              </div>
              <span className="version-choice-size">{compactNumber(version.downloads)} 次下载</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}

export function DiscoverPage() {
  const instances = useStore((s) => s.instances)
  const setPage = useStore((s) => s.setPage)
  const toast = useStore((s) => s.toast)
  const [tab, setTab] = useState<Tab>('mod')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [gameVersion, setGameVersion] = useState('')
  const [loader, setLoader] = useState('')
  const [sort, setSort] = useState<Sort>('relevance')
  const [projects, setProjects] = useState<ModrinthProject[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<ModrinthProject | null>(null)
  const [nonce, setNonce] = useState(0)

  const versions = useMemo(() => {
    const set = new Set(instances.map((instance) => instance.mcVersion))
    return [...set].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  }, [instances])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 350)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void api.modrinth
      .search({
        query: debounced,
        projectType: tab,
        gameVersion: gameVersion || undefined,
        loader: loader || undefined,
        sort,
        limit: 30,
      })
      .then((result) => {
        if (cancelled) return
        setProjects(result.hits)
        setTotal(result.totalHits)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debounced, tab, gameVersion, loader, sort, nonce])

  return (
    <div className="page discover-page">
      <header className="page-head">
        <div>
          <h1>资源库</h1>
          <p>来自 Modrinth · 搜索模组与整合包，直接安装到实例</p>
        </div>
        <div className="page-head-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<Upload size={15} />}
            onClick={() => {
              void api.modpacks
                .importFile()
                .then((id) => {
                  if (id) {
                    toast('success', '整合包导入完成', '可在实例列表中查看')
                    setPage('instances')
                  }
                })
                .catch((err: unknown) => toast('error', '导入失败', err instanceof Error ? err.message : String(err)))
            }}
          >
            导入 .mrpack
          </Button>
          <Button variant="secondary" size="sm" icon={<Boxes size={15} />} onClick={() => setPage('instances')}>
            我的实例
          </Button>
        </div>
      </header>

      <div className="discover-toolbar">
        <Segmented
          value={tab}
          onChange={(next) => {
            setTab(next)
            setSelected(null)
          }}
          options={[
            { value: 'mod', label: '模组' },
            { value: 'modpack', label: '整合包' },
          ]}
        />
        <div className="search discover-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === 'mod' ? '搜索 Sodium、JEI、Create…' : '搜索整合包，例如 Fabulously Optimized'}
          />
        </div>
      </div>

      <div className="discover-filters">
        <span className="filter-label">
          <SlidersHorizontal size={13} /> 筛选
        </span>
        <Select
          value={gameVersion}
          onChange={setGameVersion}
          options={[{ value: '', label: '全部 MC 版本' }, ...versions.map((v) => ({ value: v, label: v }))]}
        />
        <Select value={loader} onChange={setLoader} options={LOADERS} />
        <Select
          value={sort}
          onChange={(value) => setSort(value as Sort)}
          options={[
            { value: 'relevance', label: '相关度' },
            { value: 'downloads', label: '下载量' },
            { value: 'follows', label: '关注数' },
            { value: 'newest', label: '最新发布' },
          ]}
        />
        <span className="discover-count">{loading ? '搜索中…' : `${compactNumber(total)} 个结果`}</span>
      </div>

      {error ? (
        <EmptyState
          icon={<Sparkles size={26} />}
          title="Modrinth 请求失败"
          description={error}
          action={
            <Button variant="secondary" onClick={() => setNonce((value) => value + 1)}>
              重试
            </Button>
          }
        />
      ) : loading && projects.length === 0 ? (
        <div className="mod-grid">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="mod-card skeleton-card">
              <div className="skeleton skeleton-icon" />
              <div className="skeleton skeleton-title" />
              <div className="skeleton skeleton-short" />
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Search size={26} />}
          title="没有找到结果"
          description="试试其他关键词，或清空 MC 版本 / 加载器筛选。"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setQuery('')
                setGameVersion('')
                setLoader('')
              }}
            >
              清空筛选
            </Button>
          }
        />
      ) : (
        <>
          {loading ? <ProgressBar value={null} /> : null}
          <div className="mod-grid">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} onOpen={() => setSelected(project)} />
            ))}
          </div>
          <p className="list-footnote">显示 {projects.length} / {total} 个结果 · 数据来自 Modrinth</p>
        </>
      )}

      {selected ? (
        <InstallModal
          project={selected}
          tab={tab}
          gameVersion={gameVersion}
          loader={loader}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  )
}
