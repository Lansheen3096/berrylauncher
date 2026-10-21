import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useStore } from '../lib/store'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  return (
    <div className="toast-layer">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span className="toast-icon">
            {toast.kind === 'success' ? (
              <CheckCircle2 size={18} />
            ) : toast.kind === 'error' ? (
              <AlertTriangle size={18} />
            ) : (
              <Info size={18} />
            )}
          </span>
          <div className="toast-body">
            <strong>{toast.title}</strong>
            {toast.detail ? <p>{toast.detail}</p> : null}
          </div>
          <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
