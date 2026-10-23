import iconUrl from '../assets/berry-icon.png'

export function BerryLogo({
  size = 28,
  plate = false,
  className,
}: {
  size?: number
  plate?: boolean
  className?: string
}) {
  const image = (
    <img
      src={iconUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={plate ? 'berry-logo berry-logo-inside' : `berry-logo ${className ?? ''}`.trim()}
    />
  )
  if (!plate) return image
  return (
    <span className={`berry-logo-plate ${className ?? ''}`.trim()} style={{ width: size, height: size }}>
      {image}
    </span>
  )
}
