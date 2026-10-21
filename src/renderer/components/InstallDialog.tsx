import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Boxes, Check, Loader2 } from 'lucide-react'
import type { LoaderKind, LoaderVersion, RemoteVersion } from '@shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Badge, Button, Field, Modal, Select } from '../components/ui'
import { LOADER_COLORS, LOADER_LABELS } from '@shared/constants'
import { formatDate, loaderLabel } from '../lib/format'

const LOADER_META: { id: LoaderKind; desc: string }[] = [
  { id: 'vanilla', desc: '纯净原版，最稳定' },
  { id: 'fabric', desc: '轻量，模组生态活跃' },
  { id: 'quilt', desc: 'Fabric 分支，更新更快' },
  { id: 'forge', desc: '老牌模组加载器' },
  { id: 'neoforge', desc: 'Forge 分支，新版本首选' },
]

export function InstallDialog({ version, onClose }: { version: RemoteVersion; onClose: () => void }) {
  const installed = useStore((s) => s.instances)
  const startInstall = async (req: Parameters<typeof api.installs.start>[0]) => api.installs.start(req)
  const setPage = useStore((s) => s.setPage)
  const toast = useStore((s) => s.toast)

  const [loader, setLoader] = useState<LoaderKind>('vanilla')
  const [loaderVersions, setLoaderVersions] = useState<Partial<Record<LoaderKind, LoaderVersion[]>>>({})
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const requestRef = useRef(0)

  const vanillaInstalled = installed.some((i) => i.id === version.id)

  useEffect(() => {
    setLoaderVersion('')
    setError('')
    if (loader === 'vanilla') return
    if (loaderVersions[loader]) {
      const list = loaderVersions[loader]!
      setLoaderVersion(list.find((v) => v.recommended)?.version ?? list.find((v) => v.stable)?.version ?? list[0]?.version ?? '')
      return
    }
    const requestId = ++requestRef.current
    setLoading(true)
    void api.versions
      .loaders(version.id, loader)
      .then((list) => {
        if (requestRef.current !== requestId) return
        setLoaderVersions((prev) => ({ ...prev, [loader]: list }))
        setLoaderVersion(list.find((v) => v.recommended)?.version ?? list.find((v) => v.stable)?.version ?? list[0]?.version ?? '')
        if (list.length === 0) setError(`${version.id} 暂无 ${LOADER_LABELS[loader]} 版本`)
      })
      .catch((err: unknown) => {
        if (requestRef.current !== requestId) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false)
      })
  }, [loader, version.id, loaderVersions])

  const currentList = loaderVersions[loader]
  const options = useMemo(
    () =>
      (currentList ?? []).map((item) => ({
        value: item.version,
        label: `${item.version}${item.recommended ? ' · 推荐' : item.stable ? ' · 稳定' : ' · 测试'}`,
      })),
    [currentList],
  )

  const canInstall = !submitting && (loader === 'vanilla' || Boolean(loaderVersion)) && !loading

  const submit = async () => {
    setSubmitting(true)
    setError('')
    try {
      await startInstall({
        mcVersion: version.id,
        loader,
        loaderVersion: loader === 'vanilla' ? undefined : loaderVersion,
        name: name.trim() || undefined,
      })
      toast('success', '已加入安装队列', `${version.id} · ${loaderLabel(loader)}`)
      onClose()
      setPage('downloads')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={
        <span className="install-title">
          Minecraft {version.id}
          <Badge tone="muted">{version.type === 'release' ? '正式版' : version.type === 'snapshot' ? '快照' : '远古版本'}</Badge>
        </span>
      }
      subtitle={`发布于 ${formatDate(version.releaseTime)} · 选择要安装的加载器`}
      onClose={onClose}
      size="lg"
      footer={
        <div className="install-foot">
          <div className="install-foot-message">
            {error ? (
              <span className="error-text">
                <AlertTriangle size={14} /> {error}
              </span>
            ) : vanillaInstalled ? (
              <span className="muted-text">
                <Check size={13} /> {version.id} 已安装，再次安装会校验并修复文件
              </span>
            ) : (
              <span className="muted-text">
                <Boxes size={13} /> 安装后可随时添加其他加载器
              </span>
            )}
          </div>
          <div className="install-foot-actions">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={!canInstall} loading={submitting}>
              {vanillaInstalled ? '重新安装' : '开始安装'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="loader-grid">
        {LOADER_META.map((meta) => {
          const list = loaderVersions[meta.id]
          const unavailable = list !== undefined && list.length === 0
          return (
            <button
              key={meta.id}
              className={`loader-card ${loader === meta.id ? 'active' : ''}`}
              onClick={() => !unavailable && setLoader(meta.id)}
              disabled={unavailable}
              style={{ '--loader-color': LOADER_COLORS[meta.id] } as React.CSSProperties}
            >
              <span className="loader-card-top">
                <span className="loader-mark" style={{ background: LOADER_COLORS[meta.id] }}>
                  {meta.id === 'vanilla' ? 'MC' : meta.id.slice(0, 1).toUpperCase()}
                </span>
                <span className="loader-name">{LOADER_LABELS[meta.id]}</span>
                {unavailable ? <Badge tone="warn">不可用</Badge> : null}
              </span>
              <span className="loader-desc">{meta.desc}</span>
            </button>
          )
        })}
      </div>

      {loader !== 'vanilla' ? (
        <div className="install-options">
          <Field label={`${LOADER_LABELS[loader]} 版本`} hint={loading ? '正在获取版本列表…' : `${currentList?.length ?? 0} 个可用版本`}>
            {loading ? (
              <div className="inline-loading">
                <Loader2 size={16} className="spin" /> 加载中
              </div>
            ) : (
              <Select value={loaderVersion} onChange={setLoaderVersion} options={options} disabled={options.length === 0} />
            )}
          </Field>
          {loader === 'forge' || loader === 'neoforge' ? (
            <p className="option-note">
              会调用 {LOADER_LABELS[loader]} 官方安装器并自动补齐依赖，首次安装通常需要 1–5 分钟。
            </p>
          ) : null}
        </div>
      ) : (
        <p className="option-note">原版包含完整的游戏文件与官方资源，安装后可直接启动。</p>
      )}

      <Field label="实例名称" hint="可选，用于在实例列表中区分">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${LOADER_LABELS[loader]} ${version.id}`}
          maxLength={48}
        />
      </Field>
    </Modal>
  )
}
