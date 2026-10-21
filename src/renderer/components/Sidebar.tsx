import { Boxes, DownloadCloud, Home, LibraryBig, Settings, UserRound } from 'lucide-react'
import { useStore, activeAccount } from '../lib/store'
import { cx, percent } from '../lib/format'
import { Spinner } from './ui'
import { APP_VERSION } from '@shared/constants'
import type { PageId } from '@shared/types'

const NAV: { id: PageId; label: string; icon: typeof Home }[] = [
  { id: 'home', label: '主页', icon: Home },
  { id: 'browse', label: '版本库', icon: LibraryBig },
  { id: 'instances', label: '实例', icon: Boxes },
  { id: 'downloads', label: '下载', icon: DownloadCloud },
  { id: 'settings', label: '设置', icon: Settings },
]

export function Sidebar() {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const accounts = useStore((s) => s.accounts)
  const openModal = useStore((s) => s.openModal)
  const tasks = useStore((s) => s.tasks)
  const account = activeAccount(accounts)
  const running = tasks.filter((t) => t.status === 'running')

  return (
    <aside className="sidebar">
      <nav className="nav">
        {NAV.map((item) => {
          const Icon = item.icon
          return (
            <button key={item.id} className={cx('nav-item', page === item.id && 'active')} onClick={() => setPage(item.id)}>
              <span className="nav-icon">
                <Icon size={18} strokeWidth={2} />
              </span>
              <span>{item.label}</span>
              {item.id === 'downloads' && running.length > 0 ? <span className="nav-count">{running.length}</span> : null}
            </button>
          )
        })}
      </nav>

      {running.length > 0 ? (
        <button className="task-pill" onClick={() => setPage('downloads')}>
          <Spinner size={15} />
          <span className="task-pill-text">
            {running[0].title}
            <em>{running[0].progress !== null ? percent(running[0].progress) : running[0].detail}</em>
          </span>
        </button>
      ) : null}

      <div className="sidebar-spacer" />

      <button className="account-card" onClick={() => openModal({ type: 'account' })}>
        {account ? (
          <>
            <span className="avatar">{account.name.slice(0, 1).toUpperCase()}</span>
            <span className="account-meta">
              <strong>{account.name}</strong>
              <em>{account.type === 'microsoft' ? '微软账户' : '离线账户'}</em>
            </span>
          </>
        ) : (
          <>
            <span className="avatar avatar-empty">
              <UserRound size={16} />
            </span>
            <span className="account-meta">
              <strong>添加账户</strong>
              <em>离线或微软登录</em>
            </span>
          </>
        )}
      </button>

      <div className="sidebar-foot">
        <span>v{APP_VERSION}</span>
        <span className="dot" />
        <span>开源 · GPL-3.0</span>
      </div>
    </aside>
  )
}
