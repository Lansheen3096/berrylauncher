import { useEffect, useMemo, useRef, useState } from 'react'
import { Boxes, ChevronDown, Clock3, FolderOpen, Github, Play, Sparkles, Square, Timer, Wand2 } from 'lucide-react'
import { useStore } from '../lib/store'
import { cx, formatRelative, formatDuration, loaderLabel } from '../lib/format'
import { Badge, Button, Card, EmptyState, IconButton } from '../components/ui'
import { BerryLogo } from '../components/BerryLogo'
import { GITHUB_URL, LOADER_COLORS } from '@shared/constants'
import { api } from '../lib/api'

function InstancePicker() {
  const instances = useStore((s) => s.instances)
  const selectedId = useStore((s) => s.selectedId)
  const selectInstance = useStore((s) => s.selectInstance)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = instances.find((i) => i.id === selectedId) ?? instances[0]

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  if (!selected) return null

  return (
    <div className="instance-picker" ref={ref}>
      <button className="instance-trigger" onClick={() => setOpen((v) => !v)}>
        <span className="loader-dot" style={{ background: LOADER_COLORS[selected.loader] }} />
        <span className="instance-trigger-text">
          <strong>{selected.name}</strong>
          <em>
            {selected.mcVersion} · {loaderLabel(selected.loader)}
          </em>
        </span>
        <ChevronDown size={16} className={cx('chevron', open && 'chevron-up')} />
      </button>
      {open ? (
        <div className="instance-menu">
          {instances.map((instance) => (
            <button
              key={instance.id}
              className={cx('instance-option', instance.id === selected.id && 'active')}
              onClick={() => {
                selectInstance(instance.id)
                setOpen(false)
              }}
            >
              <span className="loader-dot" style={{ background: LOADER_COLORS[instance.loader] }} />
              <span className="instance-option-text">
                <strong>{instance.name}</strong>
                <em>
                  {instance.mcVersion} · {loaderLabel(instance.loader)}
                </em>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function HomePage() {
  const instances = useStore((s) => s.instances)
  const selectedId = useStore((s) => s.selectedId)
  const play = useStore((s) => s.play)
  const stop = useStore((s) => s.stop)
  const setPage = useStore((s) => s.setPage)
  const launch = useStore((s) => s.launch)
  const openModal = useStore((s) => s.openModal)
  const remote = useStore((s) => s.remote)
  const selectInstance = useStore((s) => s.selectInstance)

  const selected = instances.find((i) => i.id === selectedId) ?? instances[0]
  const running = launch.status?.state === 'running' && launch.status.versionId === selected?.id
  const totalPlayTime = instances.reduce((sum, i) => sum + (i.playTimeSec ?? 0), 0)
  const latestRelease = useMemo(() => remote.find((v) => v.type === 'release'), [remote])
  const recent = instances.filter((i) => i.lastPlayedAt).slice(0, 3)

  useEffect(() => {
    if (!selectedId && instances[0]) selectInstance(instances[0].id)
  }, [instances, selectedId, selectInstance])

  return (
    <div className="page home-page">
      <section className="hero">
        <div className="hero-glow" aria-hidden />
        <div className="hero-copy">
          <span className="eyebrow">
            <Sparkles size={14} /> 欢迎回到方块世界
          </span>
          <h1>
            把每一段冒险，
            <br />
            <span className="accent-text">收进甜浆果。</span>
          </h1>
          <p className="hero-sub">
            原版、Fabric、Forge、NeoForge 一键安装与启动。绿色的树莓镇，从这里出发。
          </p>

          {selected ? (
            <div className="hero-launch">
              <InstancePicker />
              <Button
                variant={running ? 'danger' : 'primary'}
                size="lg"
                className="play-button"
                icon={running ? <Square size={16} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
                onClick={() => (running ? void stop(selected.id) : void play(selected.id))}
              >
                {running ? '停止游戏' : '启动游戏'}
              </Button>
            </div>
          ) : (
            <div className="hero-launch">
              <Button variant="primary" size="lg" icon={<Play size={18} fill="currentColor" />} onClick={() => setPage('browse')}>
                安装第一个版本
              </Button>
              <Button variant="ghost" size="lg" icon={<Wand2 size={16} />} onClick={() => openModal({ type: 'account' })}>
                先添加账户
              </Button>
            </div>
          )}

          <div className="hero-meta">
            {selected ? (
              <>
                <span className="hero-meta-item">
                  <Clock3 size={14} /> 上次启动 {formatRelative(selected.lastPlayedAt)}
                </span>
                <span className="hero-meta-item">
                  <FolderOpen size={14} /> 实例独立存档与模组目录
                </span>
              </>
            ) : (
              <span className="hero-meta-item">从经典版本到最新正式版，全部主流加载器</span>
            )}
          </div>
        </div>

        {selected ? (
        <div className="hero-side">
          <div className="hero-side-brand">
            <BerryLogo size={72} />
          </div>
          <dl className="hero-facts">
            <div>
              <dt>游戏版本</dt>
              <dd>{selected.mcVersion}</dd>
            </div>
            <div>
              <dt>加载器</dt>
              <dd>{loaderLabel(selected.loader)}</dd>
            </div>
            <div>
              <dt>模组</dt>
              <dd>{selected.modCount ?? 0} 个</dd>
            </div>
            <div>
              <dt>内存</dt>
              <dd>{selected.settings.memoryMB ?? '默认'} MB</dd>
            </div>
          </dl>
        </div>
        ) : (
          <div className="hero-side hero-side-quiet">
            <p className="hero-side-title">快速开始</p>
            <Button variant="secondary" size="sm" block onClick={() => setPage('browse')}>
              安装游戏版本
            </Button>
            <Button variant="secondary" size="sm" block onClick={() => setPage('discover')}>
              浏览模组与整合包
            </Button>
            <Button variant="ghost" size="sm" block onClick={() => openModal({ type: 'account' })}>
              添加账户
            </Button>
          </div>
        )}
      </section>

      <div className="stats-row">
        <Card className="stat-card">
          <span className="stat-icon">
            <Boxes size={18} />
          </span>
          <div>
            <strong>{instances.length}</strong>
            <span>已安装实例</span>
          </div>
        </Card>
        <Card className="stat-card">
          <span className="stat-icon">
            <Timer size={18} />
          </span>
          <div>
            <strong>{formatDuration(totalPlayTime)}</strong>
            <span>累计游玩时长</span>
          </div>
        </Card>
        <Card className="stat-card">
          <span className="stat-icon">
            <Sparkles size={18} />
          </span>
          <div>
            <strong>{latestRelease?.id ?? '—'}</strong>
            <span>最新正式版本</span>
          </div>
        </Card>
      </div>

      <div className="home-columns">
        <Card className="panel recent-panel">
          <div className="panel-head">
            <h2>最近游玩</h2>
            <Button variant="ghost" size="sm" onClick={() => setPage('instances')}>
              全部实例
            </Button>
          </div>
          {recent.length === 0 ? (
            <EmptyState
              icon={<Boxes size={26} />}
              title="还没有游玩记录"
              description="安装一个版本，开始你的第一次冒险。"
              action={
                <Button variant="primary" size="sm" onClick={() => setPage('browse')}>
                  去版本库
                </Button>
              }
            />
          ) : (
            <div className="recent-list">
              {recent.map((instance) => (
                <div key={instance.id} className="recent-item">
                  <span className="recent-icon" style={{ background: LOADER_COLORS[instance.loader] }}>
                    {instance.loader === 'vanilla' ? 'MC' : instance.loader.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="recent-text">
                    <strong>{instance.name}</strong>
                    <em>
                      {instance.mcVersion} · {loaderLabel(instance.loader)} · {formatRelative(instance.lastPlayedAt)}
                    </em>
                  </div>
                  <IconButton label="启动" onClick={() => void play(instance.id)}>
                    <Play size={16} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="panel club-panel">
          <div className="club-badge">
            <Badge tone="accent">开源项目</Badge>
            <Badge tone="muted">GPL-3.0</Badge>
          </div>
          <h2>甜浆果像素同好会</h2>
          <p className="club-sub">辽宁科技大学 · USTL Sweet Berry Pixel Club</p>
          <p className="club-text">
            一群喜欢方块、像素与开源的同学，把日常的热情做成了这个启动器。它不捆绑广告、不收集隐私，只负责把你送进游戏。
          </p>
          <div className="club-actions">
            <Button variant="secondary" size="sm" icon={<Github size={15} />} onClick={() => void api.app.openExternal(GITHUB_URL)}>
              GitHub 仓库
            </Button>
            <span className="club-note">非商业 · 与 Mojang 无关联</span>
          </div>
        </Card>
      </div>
    </div>
  )
}
