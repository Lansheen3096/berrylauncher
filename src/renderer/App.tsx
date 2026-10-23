import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useStore } from './lib/store'
import { api } from './lib/api'
import { applyTheme } from './lib/theme'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { ConsoleDrawer } from './components/ConsoleDrawer'
import { InstallDialog } from './components/InstallDialog'
import { AccountDialog } from './components/AccountDialog'
import { HomePage } from './pages/HomePage'
import { DiscoverPage } from './pages/DiscoverPage'
import { BrowsePage } from './pages/BrowsePage'
import { InstancesPage } from './pages/InstancesPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { SettingsPage } from './pages/SettingsPage'
import { BerryLogo } from './components/BerryLogo'
import { Button, Modal, Spinner } from './components/ui'

function Splash({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div className="splash">
      <div className="splash-glow" />
      <BerryLogo size={84} className="splash-logo" />
      <h1>BerryLauncher</h1>
      <p>甜浆果启动器 · 辽宁科技大学甜浆果像素同好会</p>
      {error ? (
        <>
          <p className="splash-error">
            <AlertTriangle size={15} /> {error}
          </p>
          <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={onRetry}>
            重试
          </Button>
        </>
      ) : (
        <div className="splash-loading">
          <Spinner size={16} /> 正在加载游戏库…
        </div>
      )}
    </div>
  )
}

export default function App() {
  const ready = useStore((s) => s.ready)
  const page = useStore((s) => s.page)
  const modal = useStore((s) => s.modal)
  const settings = useStore((s) => s.settings)
  const init = useStore((s) => s.init)
  const openModal = useStore((s) => s.openModal)
  const setTasks = useStore((s) => s.setTasks)
  const setLaunchStatus = useStore((s) => s.setLaunchStatus)
  const appendLogs = useStore((s) => s.appendLogs)
  const refreshInstances = useStore((s) => s.refreshInstances)
  const toast = useStore((s) => s.toast)
  const instances = useStore((s) => s.instances)
  const [bootError, setBootError] = useState('')
  const [slimTip, setSlimTip] = useState(false)

  const boot = async () => {
    setBootError('')
    try {
      await init()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      useStore.setState({ ready: false })
      setBootError(message)
    }
  }

  useEffect(() => {
    void boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (settings) applyTheme(settings.theme.accent, settings.theme.mode)
  }, [settings?.theme.accent, settings?.theme.mode, settings])

  useEffect(() => {
    if (!ready || instances.length === 0 || !settings || settings.resourceAutoSlim) return
    if (localStorage.getItem('berry.slimTip')) return
    setSlimTip(true)
    localStorage.setItem('berry.slimTip', 'shown')
  }, [ready, instances.length, settings])

  useEffect(() => {
    const unsubscribers = [
      api.on('task:update', (task) => {
        setTasks(task)
        if (task.status === 'completed' && task.kind === 'install') void refreshInstances()
      }),
      api.on('instances:changed', (instances) => useStore.setState({ instances })),
      api.on('accounts:changed', (accounts) => useStore.setState({ accounts })),
      api.on('settings:changed', (next) => useStore.setState({ settings: next })),
      api.on('launch:status', (status) => {
        setLaunchStatus(status)
        if (status.state === 'failed' && status.error) toast('error', '游戏未能正常启动', status.error)
        if (status.state === 'exited') {
          toast('success', '游戏已退出', '欢迎下次再来')
          void refreshInstances()
        }
      }),
      api.on('launch:log', ({ lines }) => appendLogs(lines)),
    ]
    return () => unsubscribers.forEach((off) => off())
  }, [appendLogs, refreshInstances, setLaunchStatus, setTasks, toast])

  if (!ready) return <Splash error={bootError} onRetry={() => void boot()} />

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <div className="main-column">
          <main className="content" key={page}>
            {page === 'home' ? <HomePage /> : null}
            {page === 'discover' ? <DiscoverPage /> : null}
            {page === 'browse' ? <BrowsePage /> : null}
            {page === 'instances' ? <InstancesPage /> : null}
            {page === 'downloads' ? <DownloadsPage /> : null}
            {page === 'settings' ? <SettingsPage /> : null}
          </main>
          <ConsoleDrawer />
        </div>
      </div>
      <Toasts />
      {modal?.type === 'install' ? <InstallDialog version={modal.version} onClose={() => openModal(null)} /> : null}
      {modal?.type === 'account' ? <AccountDialog onClose={() => openModal(null)} /> : null}
      {slimTip ? (
        <Modal
          title="开启自动瘦身？"
          subtitle="模组、材质包、光影会按 SHA-1 只保留一份，多个实例共享同一份实体。"
          size="sm"
          onClose={() => setSlimTip(false)}
          footer={
            <div className="modal-actions">
              <Button variant="ghost" onClick={() => setSlimTip(false)}>
                以后再说
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  setSlimTip(false)
                  await useStore.getState().updateSettings({ resourceAutoSlim: true })
                  useStore.getState().toast('info', '自动瘦身已开启', '正在扫描已有资源…')
                  void api.storage.slim().then((result) => {
                    useStore.getState().toast('success', '整理完成', `节省 ${(result.savedBytes / 1024 / 1024).toFixed(1)} MB`)
                  }).catch(() => undefined)
                }}
              >
                开启并整理
              </Button>
            </div>
          }
        >
          <p className="option-note">
            关闭也不影响使用：启动器安装的模组仍然只存一份；开启后会额外整理手动拖进文件夹的重复资源。
          </p>
        </Modal>
      ) : null}
    </div>
  )
}
