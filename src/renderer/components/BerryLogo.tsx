const ART = [
  '................',
  '................',
  '.....g...g......',
  '....ggg.gGg.....',
  '...ggggggggg....',
  '....gGGGGGg.....',
  '....rRRRRRr.....',
  '...rRwRRRRRr....',
  '..rRRwRRrRRRr...',
  '..rRRRRRrRRRr...',
  '..rRRrrRrRRRr...',
  '...rRRrRRRRr....',
  '...rRRRRRRRr....',
  '....rRRRRRr.....',
  '.....rRdRr......',
  '......rrr.......',
]

const PALETTE: Record<string, string> = {
  g: '#3ddc84',
  G: '#1f9d63',
  r: '#e8435e',
  R: '#ff5c77',
  w: '#ffd1d9',
  d: '#a8243e',
}

const CELLS: { x: number; y: number; fill: string }[] = []
for (let y = 0; y < ART.length; y++) {
  for (let x = 0; x < ART[y].length; x++) {
    const fill = PALETTE[ART[y][x]]
    if (fill) CELLS.push({ x, y, fill })
  }
}

export function BerryLogo({
  size = 28,
  plate = false,
  className,
}: {
  size?: number
  plate?: boolean
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden="true"
      style={{ imageRendering: 'pixelated' }}
    >
      {plate ? <rect x="0" y="0" width="16" height="16" rx="3.4" fill="#0a1a12" /> : null}
      {plate ? <rect x="0.5" y="0.5" width="15" height="15" rx="3" fill="none" stroke="rgba(61,220,132,0.28)" /> : null}
      {CELLS.map((cell) => (
        <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width="1" height="1" fill={cell.fill} />
      ))}
    </svg>
  )
}
