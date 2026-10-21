import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useEffect } from 'react'
import { ChevronDown, Loader2, X } from 'lucide-react'
import { cx } from '../lib/format'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  loading?: boolean
  block?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  block,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cx('btn', `btn-${variant}`, `btn-${size}`, block && 'btn-block', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={16} className="spin" /> : icon}
      {children ? <span>{children}</span> : null}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  tone?: 'default' | 'danger'
}

export function IconButton({ label, tone = 'default', className, children, ...rest }: IconButtonProps) {
  return (
    <button className={cx('icon-btn', tone === 'danger' && 'icon-btn-danger', className)} title={label} aria-label={label} {...rest}>
      {children}
    </button>
  )
}

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('card', className)} {...rest}>
      {children}
    </div>
  )
}

export function Badge({ tone = 'muted', children }: { tone?: 'accent' | 'muted' | 'warn' | 'danger'; children: ReactNode }) {
  return <span className={cx('badge', `badge-${tone}`)}>{children}</span>
}

export function ProgressBar({ value, tone = 'accent' }: { value: number | null; tone?: 'accent' | 'danger' }) {
  return (
    <div className={cx('progress', tone === 'danger' && 'progress-danger')} role="progressbar" aria-valuenow={value ?? undefined}>
      <div
        className={cx('progress-fill', value === null && 'progress-indeterminate')}
        style={value === null ? undefined : { width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  )
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', `modal-${size}`)} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Select({
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  disabled?: boolean
  className?: string
}) {
  return (
    <div className={cx('select', className)}>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={15} className="select-chevron" />
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('switch', checked && 'switch-on')}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="switch-thumb" />
    </button>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  format?: (value: number) => string
}) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--fill': `${((value - min) / Math.max(1, max - min)) * 100}%` } as React.CSSProperties}
      />
      <span className="slider-value">{format ? format(value) : value}</span>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          className={cx('segmented-item', value === option.value && 'active')}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  inline,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  inline?: boolean
}) {
  return (
    <div className={cx('field', inline && 'field-inline')}>
      <div className="field-label">
        <span>{label}</span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </div>
      <div className="field-control">{children}</div>
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="spin" />
}
