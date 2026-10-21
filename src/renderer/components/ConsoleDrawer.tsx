import { useEffect, useMemo, useRef } from 'react'
import { ExternalLink, Square, Terminal, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Button } from './ui'
import { cx } from '../lib/format'

export function ConsoleDrawer() {
  const launch = useStore((s) => s.launch)
  const setOpen = useStore((s) => s.setLaunchOpen)
  const stop = useStore((s) => s.stop)
  const instances = useStore((s) => s.instances)
  const scrollRef = useRef<HTMLDivElement>(null)

  const instance = instances.find((i) => i.id === launch.versionId)
  const status = launch.status
  const running = status?.state === 'running' || status?.state === 'preparing'

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [launch.logs])

  const lines = useMemo(() => launch.logs.slice(-600), [launch.logs])

  if (!launch.open && launch.logs.length === 0) return null

  return (
    <div className={cx('console-drawer', !launch.open && 'console-collapsed')}>
      <div className="console-head">
        <div className="console-title">
          <Terminal size={15} />
          <strong>{instance?.name ?? launch.versionId ?? '启动控制台'}</strong>
          {status?.state === 'preparing' ? <span className="console-status preparing">正在准备</span> : null}
          {status?.state === 'running' ? <span className="console-status running">运行中 · PID {status.pid}</span> : null}
          {status?.state === 'exited' ? <span className="console-status exited">已退出</span> : null}
          {status?.state === 'failed' ? <span className="console-status failed">启动失败</span> : null}
        </div>
        <div className="console-actions">
          {running && launch.versionId ? (
            <Button variant="danger" size="sm" icon={<Square size={12} fill="currentColor" />} onClick={() => void stop(launch.versionId!)}>
              停止游戏
            </Button>
          ) : null}
          {status?.logPath ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<ExternalLink size={14} />}
              onClick={() => void api.app.openPath(status.logPath!).catch(() => undefined)}
            >
              日志文件
            </Button>
          ) : null}
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="收起控制台">
            <X size={16} />
          </button>
        </div>
      </div>

      {status?.state === 'failed' && status.error ? <div className="console-error">{status.error}</div> : null}

      {!launch.open ? (
        <button className="console-expand" onClick={() => setOpen(true)}>
          展开控制台（{launch.logs.length} 行日志）
        </button>
      ) : (
        <div className="console-body" ref={scrollRef}>
          {lines.length === 0 ? (
            <p className="console-empty">等待游戏输出…</p>
          ) : (
            lines.map((line, index) => (
              <div
                key={index}
                className={cx(
                  'console-line',
                  /ERROR|FATAL|Exception|Caused by/i.test(line) && 'line-error',
                  /\bWARN\b/i.test(line) && 'line-warn',
                )}
              >
                {line}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
