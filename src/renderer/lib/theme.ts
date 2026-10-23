export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized
  const int = Number.parseInt(full, 16)
  if (Number.isNaN(int)) return [43, 143, 92]
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  const mix = (channel: number) =>
    Math.round(amount < 0 ? channel * (1 + amount) : channel + (255 - channel) * amount)
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

export function applyTheme(accent: string, mode: 'dark' | 'light'): void {
  const root = document.documentElement
  const [r, g, b] = hexToRgb(accent)
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`)
  root.style.setProperty('--accent-strong', shade(accent, -0.22))
  root.style.setProperty('--accent-bright', shade(accent, 0.18))
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.12)`)
  root.style.setProperty('--accent-line', `rgba(${r}, ${g}, ${b}, 0.28)`)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  root.style.setProperty('--on-accent', luminance > 0.62 ? '#08130d' : '#ffffff')
  root.dataset.mode = mode
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', mode === 'dark' ? '#07110c' : '#f3f7f2')
}
