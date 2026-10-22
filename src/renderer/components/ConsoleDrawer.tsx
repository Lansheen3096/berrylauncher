import { useEffect, useMemo, useRef } from 'react'
import { ChevronDown, ChevronUp, ExternalLink, Square, Terminal, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Button } from './ui'
import { cx } from '../lib/format'

export function ConsoleDrawer() {
  const launch = useStore((s) => s.launch)
  const setMode = useStore((s) => s.setConsoleMode)
  const stop = useStore((s) => s.stop)
  const instances = useStore((s) => s.instances)
  const scrollRef = useRef<HTMLDivElement>(null)

  const instance = instances.find((i) => i.id === launch.versionId)
  const status = launch.status
  const running = status?.state === 'running' || status?.state === 'preparing'
  const open = launch.mode === 'open'

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [launch.logs, open])

  const lines = useMemo(() => launch.logs.slice(-800), [launch.logs])

  if (launch.mode === 'hidden' || !launch.versionId) return null

  return (
    <section className={cx('console-dock', open ? 'is-open' : 'is-peek')} aria-label="启动日志">
      <header className="console-dock-head">
        <button
          className="console-dock-toggle"
          onClick={() => setMode(open ? 'peek' : 'open')}
          title={open ? '收起控制台' : '展开控制台'}
        >
          <Terminal size={15} />
          <span className="console-dock-name">{instance?.name ?? launch.versionId}</span>
          {status?.state === 'preparing' ? <span className="console-badge preparing">正在准备</span> : null}
          {status?.state === 'running' ? <span className="console-badge running">运行中 · PID {status.pid}</span> : null}
          {status?.state === 'exited' ? <span className="console-badge exited">已退出 · 代码 {status.exitCode ?? 0}</span> : null}
          {status?.state === 'failed' ? <span className="console-badge failed">启动失败</span> : null}
          <span className="console-dock-lines">{launch.logs.length} 行</span>
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        <div className="console-dock-actions">
          {running && launch.versionId ? (
            <Button variant="danger" size="sm" icon={<Square size={12} fill="currentColor" />} onClick={() => void stop(launch.versionId!)}>
              停止
            </Button>
          ) : null}
          {status?.logPath ? (
            <button className="icon-btn" title="打开日志文件" onClick={() => void api.app.openPath(status.logPath!).catch(() => undefined)}>
              <ExternalLink size={15} />
            </button>
          ) : null}
          <button className="icon-btn" title="隐藏控制台" onClick={() => setMode('hidden')}>
            <X size={16} />
          </button>
        </div>
      </header>

      {open ? (
        <>
          {status?.state === 'failed' && status.error ? <div className="console-error">{status.error}</div> : null}
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
        </>
      ) : null}
    </section>
  )
}
