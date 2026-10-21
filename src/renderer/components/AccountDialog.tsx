import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, LogIn, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import type { DeviceCodeInfo } from '@shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Badge, Button, Field, Modal, Segmented } from './ui'

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const accounts = useStore((s) => s.accounts)
  const setPage = useStore((s) => s.setPage)
  const toast = useStore((s) => s.toast)

  const [tab, setTab] = useState<'offline' | 'microsoft'>('offline')
  const [name, setName] = useState('')
  const [device, setDevice] = useState<DeviceCodeInfo | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [remaining, setRemaining] = useState(0)

  const clientId = settings?.msClientId ?? ''
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!device) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const tick = async () => {
      if (cancelled) return
      setRemaining(Math.max(0, Math.ceil((device.expiresIn * 1000 - (Date.now() - started)) / 1000)))
      try {
        const account = await api.accounts.microsoftPoll(device.deviceCode)
        if (cancelled) return
        if (account) {
          toast('success', `欢迎，${account.name}`, '微软账户登录成功')
          closeRef.current()
          return
        }
        timer = setTimeout(tick, 2500)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setDevice(null)
      }
    }
    timer = setTimeout(tick, 2500)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [device, onClose, toast])

  const addOffline = async () => {
    try {
      setError('')
      const account = await api.accounts.addOffline(name)
      toast('success', `已添加离线账户 ${account.name}`)
      setName('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const startMicrosoft = async () => {
    setStarting(true)
    setError('')
    try {
      const info = await api.accounts.microsoftStart()
      setDevice(info)
      setRemaining(info.expiresIn)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const copyCode = async () => {
    if (!device) return
    await navigator.clipboard.writeText(device.userCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <Modal
      title="账户"
      subtitle="离线账户可游玩单人游戏；微软账户可使用正版皮肤与服务器"
      onClose={onClose}
    >
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'offline', label: '离线账户' },
          { value: 'microsoft', label: '微软账户' },
        ]}
      />

      {tab === 'offline' ? (
        <div className="account-form">
          <Field label="玩家名" hint="3–16 位字母、数字或下划线">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Steve"
              maxLength={16}
              onKeyDown={(e) => e.key === 'Enter' && void addOffline()}
            />
          </Field>
          {error ? <p className="error-text">{error}</p> : null}
          <Button variant="primary" icon={<UserRound size={16} />} onClick={() => void addOffline()} disabled={name.trim().length < 3}>
            添加离线账户
          </Button>
        </div>
      ) : (
        <div className="account-form">
          {!clientId ? (
            <div className="notice-box">
              <ShieldCheck size={18} />
              <div>
                <strong>还没有配置微软登录</strong>
                <p>
                  在 Azure 门户注册一个「公开客户端」应用，启用「允许公共客户端流」，把客户端 ID 填到设置里即可。启动器不会上传任何数据。
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onClose()
                    setPage('settings')
                  }}
                >
                  前往设置填写 Client ID
                </Button>
              </div>
            </div>
          ) : device ? (
            <div className="device-flow">
              <p className="device-instruction">
                在浏览器打开 <span className="mono">{device.verificationUri}</span>，输入下面的代码：
              </p>
              <button className="device-code" onClick={() => void copyCode()}>
                <span>{device.userCode}</span>
                {copied ? <Check size={18} /> : <Copy size={18} />}
              </button>
              <div className="device-actions">
                <Button variant="primary" size="sm" icon={<ExternalLink size={14} />} onClick={() => void api.app.openExternal(device.verificationUri)}>
                  打开登录页面
                </Button>
                <span className="device-wait">
                  <span className="pulse-dot" /> 等待授权… {remaining > 0 ? `${remaining}s` : ''}
                </span>
              </div>
              {error ? <p className="error-text">{error}</p> : null}
            </div>
          ) : (
            <>
              <p className="option-note">
                将使用设备码登录，无需在启动器里输入密码。需要先在设置中填写 Azure 应用的 Client ID。
              </p>
              <Button variant="primary" icon={<LogIn size={16} />} onClick={() => void startMicrosoft()} loading={starting}>
                开始微软登录
              </Button>
              {error ? <p className="error-text">{error}</p> : null}
            </>
          )}
        </div>
      )}

      <div className="account-list">
        <h3 className="section-title">已保存的账户</h3>
        {accounts.accounts.length === 0 ? (
          <p className="muted-text">还没有账户，先添加一个吧。</p>
        ) : (
          accounts.accounts.map((account) => (
            <div key={account.id} className={`account-row ${account.id === accounts.activeId ? 'active' : ''}`}>
              <span className="avatar">{account.name.slice(0, 1).toUpperCase()}</span>
              <div className="account-row-text">
                <strong>{account.name}</strong>
                <em>{account.type === 'microsoft' ? '微软账户' : '离线账户'}</em>
              </div>
              {account.id === accounts.activeId ? <Badge tone="accent">当前</Badge> : null}
              {account.id !== accounts.activeId ? (
                <Button variant="ghost" size="sm" onClick={() => void api.accounts.setActive(account.id)}>
                  切换
                </Button>
              ) : null}
              <button
                className="icon-btn icon-btn-danger"
                title="删除账户"
                onClick={() => void api.accounts.remove(account.id).then(() => toast('info', '账户已删除'))}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}
