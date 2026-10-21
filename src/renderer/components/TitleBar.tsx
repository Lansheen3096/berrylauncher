import { Maximize2, Minus, X } from 'lucide-react'
import { BerryLogo } from './BerryLogo'
import { api } from '../lib/api'

export function TitleBar() {
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <BerryLogo size={24} plate />
        <span className="brand-name">BerryLauncher</span>
        <span className="brand-divider" />
        <span className="brand-club">USTL · 甜浆果像素同好会</span>
      </div>
      <div className="window-controls">
        <button className="window-btn" onClick={() => api.app.minimize()} aria-label="最小化">
          <Minus size={16} />
        </button>
        <button className="window-btn" onClick={() => api.app.toggleMaximize()} aria-label="最大化">
          <Maximize2 size={14} />
        </button>
        <button className="window-btn window-close" onClick={() => api.app.close()} aria-label="关闭">
          <X size={16} />
        </button>
      </div>
    </header>
  )
}
