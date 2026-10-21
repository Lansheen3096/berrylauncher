import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export const dataDir = (): string =>
  process.env.BERRY_DATA_DIR ? path.resolve(process.env.BERRY_DATA_DIR) : app.getPath('userData')
export const cacheDir = (): string => path.join(dataDir(), 'cache')

export function defaultGameDir(): string {
  // Windows: %APPDATA%\BerryLauncher\minecraft
  // Linux:   ~/.config/BerryLauncher/minecraft
  // macOS:   ~/Library/Application Support/BerryLauncher/minecraft
  return path.join(dataDir(), 'minecraft')
}

export const versionDir = (gameDir: string, id: string): string => path.join(gameDir, 'versions', id)
export const versionJsonPath = (gameDir: string, id: string): string => path.join(versionDir(gameDir, id), `${id}.json`)
export const versionJarPath = (gameDir: string, id: string): string => path.join(versionDir(gameDir, id), `${id}.jar`)
export const librariesDir = (gameDir: string): string => path.join(gameDir, 'libraries')
export const assetsDir = (gameDir: string): string => path.join(gameDir, 'assets')
export const instancesDir = (gameDir: string): string => path.join(gameDir, 'instances')
export const instanceDir = (gameDir: string, id: string): string => path.join(instancesDir(gameDir), id)
export const runtimeDir = (): string => path.join(dataDir(), 'runtime')
export const accountsFile = (): string => path.join(dataDir(), 'accounts.json')
export const settingsFile = (): string => path.join(dataDir(), 'settings.json')
export const logDir = (): string => path.join(dataDir(), 'logs')

export function assetObjectPath(gameDir: string, hash: string): string {
  return path.join(assetsDir(gameDir), 'objects', hash.slice(0, 2), hash)
}

export function libraryPath(gameDir: string, rel: string): string {
  return path.join(librariesDir(gameDir), rel)
}

export function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Windows: java.exe / javaw.exe, otherwise bin/java. */
export function javaBinary(runtimeRoot: string): string {
  if (process.platform === 'win32') return path.join(runtimeRoot, 'bin', 'java.exe')
  return path.join(runtimeRoot, 'bin', 'java')
}
