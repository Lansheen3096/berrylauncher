import type { LoaderKind } from '@shared/types'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, index)
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatDate(input: string | number): string {
  const date = typeof input === 'number' ? new Date(input) : new Date(input)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export function formatRelative(timestamp?: number): string {
  if (!timestamp) return '从未启动'
  const diff = Date.now() - timestamp
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  return formatDate(timestamp)
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds < 60) return `${Math.max(0, Math.floor(seconds ?? 0))} 秒`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分钟`
}

export function loaderLabel(loader: LoaderKind): string {
  return { vanilla: '原版', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[loader]
}

export function loaderInitial(loader: LoaderKind): string {
  return { vanilla: 'MC', fabric: 'F', quilt: 'Q', forge: 'Fo', neoforge: 'N' }[loader]
}

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return ''
  return `${Math.round(value * 100)}%`
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
