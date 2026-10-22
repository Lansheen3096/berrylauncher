import { useEffect, useState } from 'react'
import {
  Check,
  Coffee,
  Download,
  FolderOpen,
  Github,
  HardDrive,
  Info,
  Palette,
  RefreshCw,
  Settings2,
  Terminal,
  UserRound,
} from 'lucide-react'
import type { JavaInfo } from '@shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { APP_NAME_CN, CLUB_NAME, GITHUB_URL, MAX_MEMORY, MIN_MEMORY } from '@shared/constants'
import { Badge, Button, Field, Segmented, Slider, Switch } from '../components/ui'
import { BerryLogo } from '../components/BerryLogo'
import { cx } from '../lib/format'

function Section({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <span className="settings-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="settings-body">{children}</div>
    </section>
  )
}

export function SettingsPage() {
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.info)
  const accounts = useStore((s) => s.accounts)
  const update = useStore((s) => s.updateSettings)
  const toast = useStore((s) => s.toast)
  const openModal = useStore((s) => s.openModal)
  const refreshInstances = useStore((s) => s.refreshInstances)

  const [javas, setJavas] = useState<JavaInfo[]>([])
  const [detecting, setDetecting] = useState(false)
  const [gameDir, setGameDir] = useState(settings?.gameDir ?? '')
  const [clientId, setClientId] = useState(settings?.msClientId ?? '')
  const [jvmArgs, setJvmArgs] = useState(settings?.jvmArgs ?? '')
  const [downloading, setDownloading] = useState('')

  useEffect(() => {
    setGameDir(settings?.gameDir ?? '')
    setClientId(settings?.msClientId ?? '')
    setJvmArgs(settings?.jvmArgs ?? '')
  }, [settings])

  useEffect(() => {
    setDetecting(true)
    api.java
      .detect()
      .then(setJavas)
      .catch(() => undefined)
      .finally(() => setDetecting(false))
  }, [])

  if (!settings || !info) return null
  const account = accounts.accounts.find((a) => a.id === accounts.activeId) ?? accounts.accounts[0]

  const chooseGameDir = async () => {
    const dir = await api.app.chooseDirectory('选择 Minecraft 数据目录')
    if (!dir) return
    await update({ gameDir: dir })
    await refreshInstances()
    toast('success', '游戏目录已更新', '已安装的版本需要重新安装到新目录后才会显示')
  }

  const downloadJava = async (component: string, label: string) => {
    setDownloading(component)
    try {
      const java = await api.java.download(component)
      toast('success', `${label} 下载完成`, java.path)
      setJavas(await api.java.detect())
    } catch (err) {
      toast('error', `${label} 下载失败`, err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading('')
    }
  }

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <p>外观、游戏与账户偏好，修改后自动保存</p>
        </div>
        <Badge tone="muted">
          <Settings2 size={12} /> {info.platform} · {info.arch}
        </Badge>
      </header>

      <Section icon={<Palette size={19} />} title="外观" description="固定森林绿与同一套控件，保证所有页面的一致性。">
        <Field label="主题模式">
          <Segmented
            value={settings.theme.mode}
            onChange={(mode) => void update({ theme: { mode } })}
            options={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
            ]}
          />
        </Field>

        <Field label="强调色" hint="固定森林绿，保证所有页面的一致性与可读性">
          <div className="accent-fixed">
            <span className="accent-swatch active" style={{ background: settings.theme.accent }}>
              <Check size={14} />
            </span>
            <span>森林绿 · {settings.theme.accent.toUpperCase()}</span>
          </div>
        </Field>

        <div className="theme-preview">
          <div className="preview-window">
            <div className="preview-bar">
              <span />
              <span />
              <span />
            </div>
            <div className="preview-body">
              <div className="preview-orb" />
              <div className="preview-lines">
                <span style={{ width: '58%' }} />
                <span style={{ width: '36%' }} />
              </div>
              <div className="preview-button">启动游戏</div>
            </div>
          </div>
          <p>当前主色 {settings.theme.accent.toUpperCase()}</p>
        </div>
      </Section>

      <Section icon={<HardDrive size={19} />} title="游戏" description="实例文件、内存与下载行为。">
        <Field label="游戏数据目录" hint="assets / libraries / versions 与实例存档都存放于此">
          <div className="input-row">
            <input className="input" value={gameDir} onChange={(e) => setGameDir(e.target.value)} onBlur={() => gameDir !== settings.gameDir && void update({ gameDir }).then(refreshInstances)} />
            <Button variant="secondary" onClick={() => void chooseGameDir()}>
              选择
            </Button>
            <Button variant="ghost" icon={<FolderOpen size={15} />} onClick={() => void api.app.openPath(settings.gameDir)}>
              打开
            </Button>
          </div>
        </Field>

        <Field label="默认内存" hint={`最大堆 ${(settings.memoryMB / 1024).toFixed(1)} GB，可按实例覆盖`}>
          <Slider
            value={settings.memoryMB}
            min={MIN_MEMORY}
            max={MAX_MEMORY}
            step={512}
            onChange={(v) => void update({ memoryMB: v })}
            format={(v) => `${(v / 1024).toFixed(1)} GB`}
          />
        </Field>

        <Field label="下载源" hint="BMCLAPI 为社区镜像，国内网络更稳定">
          <Segmented
            value={settings.downloadSource}
            onChange={(source) => void update({ downloadSource: source })}
            options={[
              { value: 'official', label: '官方源' },
              { value: 'bmclapi', label: 'BMCLAPI 镜像' },
            ]}
          />
        </Field>

        <Field label="启动时展开控制台" hint="关闭时只在底部显示一条日志状态栏">
          <Switch
            checked={settings.consoleAutoOpen}
            onChange={(value) => void update({ consoleAutoOpen: value })}
            label="启动时展开控制台"
          />
        </Field>

        <Field label="并发下载数" hint="网络较差时调低可减少超时">
          <Slider value={settings.concurrency} min={1} max={32} onChange={(v) => void update({ concurrency: v })} format={(v) => `${v} 线程`} />
        </Field>

        <Field label="默认 Java 路径" hint="留空则自动检测；也可为单个实例单独指定">
          <div className="input-row">
            <input
              className="input"
              value={settings.javaPath}
              placeholder="自动检测（推荐）"
              onChange={(e) => void update({ javaPath: e.target.value })}
            />
            <Button
              variant="secondary"
              icon={<RefreshCw size={14} className={detecting ? 'spin' : undefined} />}
              onClick={async () => {
                setDetecting(true)
                setJavas(await api.java.detect())
                setDetecting(false)
              }}
            >
              检测
            </Button>
          </div>
        </Field>

        <div className="java-list">
          {javas.length === 0 ? (
            <p className="muted-text">没有检测到 Java，可在下方下载官方运行时。</p>
          ) : (
            javas.slice(0, 6).map((java) => (
              <button
                key={java.path}
                className={cx('java-item', settings.javaPath === java.path && 'active')}
                onClick={() => void update({ javaPath: java.path })}
                title={java.path}
              >
                <Coffee size={15} />
                <span className="java-version">Java {java.major}</span>
                <span className="java-path">{java.path}</span>
                <Badge tone={java.source === 'downloaded' ? 'accent' : 'muted'}>{java.source === 'downloaded' ? '已下载' : '系统'}</Badge>
              </button>
            ))
          )}
        </div>

        <div className="java-downloads">
          <span className="muted-text">下载 Mojang 官方运行时：</span>
          {[
            { component: 'java-runtime-delta', label: 'Java 21' },
            { component: 'java-runtime-gamma', label: 'Java 17' },
            { component: 'jre-legacy', label: 'Java 8' },
          ].map((item) => (
            <Button
              key={item.component}
              variant="secondary"
              size="sm"
              icon={<Download size={14} />}
              loading={downloading === item.component}
              onClick={() => void downloadJava(item.component, item.label)}
            >
              {item.label}
            </Button>
          ))}
        </div>

        <Field label="默认 JVM 参数" hint="空格分隔，留空使用启动器推荐值">
          <input
            className="input"
            value={jvmArgs}
            placeholder="-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions"
            onChange={(e) => setJvmArgs(e.target.value)}
            onBlur={() => jvmArgs !== settings.jvmArgs && void update({ jvmArgs })}
          />
        </Field>
      </Section>

      <Section icon={<UserRound size={19} />} title="账户与登录" description="离线账户开箱即用；微软登录需要自备 Azure Client ID。">
        <Field label="当前账户">
          {account ? (
            <div className="current-account">
              <span className="avatar">{account.name.slice(0, 1).toUpperCase()}</span>
              <div className="account-row-text">
                <strong>{account.name}</strong>
                <em>{account.type === 'microsoft' ? '微软账户' : account.type === 'authlib' ? 'MUA / 外置账户' : '离线账户'}</em>
              </div>
              <Button variant="secondary" size="sm" onClick={() => openModal({ type: 'account' })}>
                管理账户
              </Button>
            </div>
          ) : (
            <Button variant="primary" size="sm" onClick={() => openModal({ type: 'account' })}>
              添加账户
            </Button>
          )}
        </Field>

        <Field
          label="微软登录 Client ID"
          hint="Azure 应用（公开客户端）的 Application (client) ID"
        >
          <div className="input-row">
            <input
              className="input mono"
              value={clientId}
              placeholder="例如 00000000-0000-0000-0000-000000000000"
              onChange={(e) => setClientId(e.target.value)}
              onBlur={() => clientId !== settings.msClientId && void update({ msClientId: clientId.trim() })}
            />
            <Button variant="ghost" icon={<Info size={15} />} onClick={() => void api.app.openExternal('https://learn.microsoft.com/entra/identity-platform/quickstart-register-app')}>
              如何获取
            </Button>
          </div>
        </Field>
        <p className="option-note">
          注册应用时选择「移动和桌面应用程序」，勾选「允许公共客户端流」即可。Client ID 不是密钥，可以安全地保存在本机配置中。
        </p>
      </Section>

      <Section icon={<Info size={19} />} title="关于" description="开源、非商业，与 Mojang / Microsoft 没有隶属关系。">
        <div className="about-card">
          <BerryLogo size={56} plate />
          <div className="about-text">
            <h3>
              {APP_NAME_CN} <span className="version-tag">v{info.version}</span>
            </h3>
            <p>{CLUB_NAME} 的开源项目 · GPL-3.0-or-later</p>
            <p className="about-path">配置目录：{info.dataDir}</p>
          </div>
          <div className="about-actions">
            <Button variant="secondary" size="sm" icon={<Github size={14} />} onClick={() => void api.app.openExternal(GITHUB_URL)}>
              GitHub
            </Button>
            <Button variant="ghost" size="sm" icon={<FolderOpen size={14} />} onClick={() => void api.app.openPath(info.dataDir)}>
              数据目录
            </Button>
            <Button variant="ghost" size="sm" icon={<Terminal size={14} />} onClick={() => void api.app.openPath(`${info.dataDir}/logs`)}>
              日志
            </Button>
            <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void api.app.relaunch()}>
              重启
            </Button>
          </div>
        </div>
        <p className="option-note">
          游戏本体、Forge / NeoForge 安装器与资源文件版权归各自作者所有。启动器只负责下载与启动，不分发任何游戏内容。
        </p>
      </Section>
    </div>
  )
}
