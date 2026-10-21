import { CheckCircle2, DownloadCloud, Package, X, XCircle } from 'lucide-react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Badge, Button, Card, EmptyState, ProgressBar } from '../components/ui'
import { formatBytes, formatSpeed, percent } from '../lib/format'

export function DownloadsPage() {
  const tasks = useStore((s) => s.tasks)
  const setPage = useStore((s) => s.setPage)
  const toast = useStore((s) => s.toast)

  const active = tasks.filter((t) => t.status === 'running' || t.status === 'queued')
  const finished = tasks.filter((t) => t.status !== 'running' && t.status !== 'queued')

  return (
    <div className="page downloads-page">
      <header className="page-head">
        <div>
          <h1>下载</h1>
          <p>安装、修复与运行时下载任务都集中在这里</p>
        </div>
        {active.length > 0 ? <Badge tone="accent">{active.length} 个进行中</Badge> : null}
      </header>

      {tasks.length === 0 ? (
        <EmptyState
          icon={<DownloadCloud size={28} />}
          title="没有下载任务"
          description="去版本库安装一个游戏版本，进度会显示在这里。"
          action={
            <Button variant="primary" onClick={() => setPage('browse')}>
              浏览版本
            </Button>
          }
        />
      ) : (
        <div className="download-sections">
          {active.length > 0 ? (
            <section>
              <h2 className="section-title">进行中</h2>
              <div className="download-list">
                {active.map((task) => (
                  <Card key={task.id} className="download-card">
                    <div className="download-head">
                      <span className="download-icon">
                        <Package size={17} />
                      </span>
                      <div className="download-title">
                        <strong>{task.title}</strong>
                        <em>{task.detail || '准备中…'}</em>
                      </div>
                      <Badge tone="accent">{task.progress !== null ? percent(task.progress) : '处理中'}</Badge>
                    </div>
                    <ProgressBar value={task.progress} />
                    <div className="download-meta">
                      <span>
                        {task.total > 0
                          ? `${formatBytes(task.received)} / ${formatBytes(task.total)}`
                          : task.received > 0
                            ? formatBytes(task.received)
                            : '正在计算大小'}
                      </span>
                      <span>{task.speed > 0 ? formatSpeed(task.speed) : ''}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void api.installs.cancel(task.id).then(() => toast('info', '已请求取消任务'))
                        }}
                      >
                        <X size={14} /> 取消
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ) : null}

          {finished.length > 0 ? (
            <section>
              <h2 className="section-title">历史记录</h2>
              <div className="download-list">
                {finished.map((task) => (
                  <Card key={task.id} className="download-card download-card-compact">
                    <div className="download-head">
                      <span className={`download-icon ${task.status === 'completed' ? 'ok' : 'fail'}`}>
                        {task.status === 'completed' ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
                      </span>
                      <div className="download-title">
                        <strong>{task.title}</strong>
                        <em>
                          {task.status === 'failed'
                            ? task.error
                            : task.status === 'cancelled'
                              ? '已取消'
                              : task.detail}
                        </em>
                      </div>
                      <Badge tone={task.status === 'completed' ? 'accent' : task.status === 'failed' ? 'danger' : 'muted'}>
                        {task.status === 'completed' ? '完成' : task.status === 'failed' ? '失败' : '已取消'}
                      </Badge>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}
