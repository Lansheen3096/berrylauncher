import type { LoaderKind } from './types'

export const APP_NAME = 'BerryLauncher'
export const APP_NAME_CN = '甜浆果启动器'
export const APP_VERSION = '0.1.0'
export const CLUB_NAME = '辽宁科技大学 甜浆果像素同好会'
export const CLUB_NAME_SHORT = 'USTL Sweet Berry Pixel Club'
export const APP_ID = 'club.ustl.berrylauncher'
export const GITHUB_URL = 'https://github.com/USTL-SweetBerry/berrylauncher'
export const LAUNCHER_BRAND = 'BerryLauncher'

export const LOADER_LABELS: Record<LoaderKind, string> = {
  vanilla: '原版',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
}

export const LOADER_COLORS: Record<LoaderKind, string> = {
  vanilla: '#7dd3a0',
  fabric: '#d9b86c',
  quilt: '#c084fc',
  forge: '#e88a5a',
  neoforge: '#e2a86b',
}

export const ACCENT_PRESETS = [
  { name: '森林绿', color: '#3ddc84' },
  { name: '薄荷青', color: '#2dd4bf' },
  { name: '樱花粉', color: '#f472b6' },
  { name: '晴空蓝', color: '#38bdf8' },
  { name: '琥珀橙', color: '#f59e0b' },
  { name: '葡萄紫', color: '#a78bfa' },
] as const

export const MOJANG = {
  versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  javaRuntimeAll:
    'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
}

export const BMCLAPI = 'https://bmclapi2.bangbang93.com'

export const FABRIC_META = 'https://meta.fabricmc.net'
export const QUILT_META = 'https://meta.quiltmc.org'
export const FORGE_MAVEN = 'https://maven.minecraftforge.net'
export const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases'
export const FABRIC_MAVEN = 'https://maven.fabricmc.net'

export const DEFAULT_MEMORY = 4096
export const MIN_MEMORY = 1024
export const MAX_MEMORY = 32768
