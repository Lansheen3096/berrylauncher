import fs from 'node:fs'
import path from 'node:path'
import type { InstanceSettings, InstanceSummary, LoaderKind, ModpackInfo, MojangVersionJson } from '../shared/types'
import { ensureDir, instanceDir, instancesDir, versionDir, versionJsonPath } from './paths'
import { readJsonFile, writeFileAtomic } from './net'
import type { VersionService } from './versions'

export interface InstanceMeta {
  id: string
  name: string
  mcVersion: string
  loader: LoaderKind
  loaderVersion?: string
  createdAt: number
  lastPlayedAt?: number
  playTimeSec?: number
  settings: InstanceSettings
  pack?: ModpackInfo
}

const META_FILE = 'berry.json'

export function metaPath(gameDir: string, id: string): string {
  return path.join(versionDir(gameDir, id), META_FILE)
}

export function readMeta(gameDir: string, id: string): InstanceMeta | null {
  return readJsonFile<InstanceMeta>(metaPath(gameDir, id))
}

export function writeMeta(gameDir: string, meta: InstanceMeta): void {
  writeFileAtomic(metaPath(gameDir, meta.id), JSON.stringify(meta, null, 2))
}

export function loaderFromId(id: string): { loader: LoaderKind; loaderVersion?: string } {
  let match = /^fabric-loader-(.+)-(\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?)$/i.exec(id)
  if (match) return { loader: 'fabric', loaderVersion: match[1] }
  match = /^quilt-loader-(.+)-(\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?)$/i.exec(id)
  if (match) return { loader: 'quilt', loaderVersion: match[1] }
  match = /^(\d+\.\d+(?:\.\d+)?)-forge-(.+)$/i.exec(id)
  if (match) return { loader: 'forge', loaderVersion: match[2] }
  match = /^forge-(.+)$/i.exec(id)
  if (match) return { loader: 'forge', loaderVersion: match[1] }
  match = /^neoforge-(.+)$/i.exec(id)
  if (match) return { loader: 'neoforge', loaderVersion: match[1] }
  return { loader: 'vanilla' }
}

export function defaultInstanceName(loader: LoaderKind, mcVersion: string, loaderVersion?: string): string {
  if (loader === 'vanilla') return `Minecraft ${mcVersion}`
  const label = loader === 'neoforge' ? 'NeoForge' : loader.charAt(0).toUpperCase() + loader.slice(1)
  return `${label} ${loaderVersion ?? ''} · ${mcVersion}`.replace(/\s+/g, ' ')
}

export function createInstanceMeta(
  id: string,
  loader: LoaderKind,
  mcVersion: string,
  loaderVersion: string | undefined,
  settings: InstanceSettings,
  name?: string,
): InstanceMeta {
  return {
    id,
    name: name?.trim() || defaultInstanceName(loader, mcVersion, loaderVersion),
    mcVersion,
    loader,
    loaderVersion,
    createdAt: Date.now(),
    settings,
  }
}

export function ensureInstanceFolders(gameDir: string, id: string): void {
  const dir = instanceDir(gameDir, id)
  for (const sub of ['mods', 'saves', 'resourcepacks', 'shaderpacks', 'screenshots']) {
    ensureDir(path.join(dir, sub))
  }
}

function dirSize(dir: string, depth = 3): number {
  if (depth < 0) return 0
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirSize(full, depth - 1)
      else total += fs.statSync(full).size
    } catch {
      /* ignore */
    }
  }
  return total
}

export function listInstances(vs: VersionService): InstanceSummary[] {
  const gameDir = vs.gameDir
  const root = path.join(gameDir, 'versions')
  let ids: string[] = []
  try {
    ids = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }

  const result: InstanceSummary[] = []
  for (const id of ids) {
    const json = vs.readInstalledJson(id)
    if (!json) continue
    const meta = readMeta(gameDir, id)
    // Hide half-finished installs: only versions with launcher metadata (or a
    // completed vanilla marker) are real instances.
    if (!meta && !fs.existsSync(path.join(versionDir(gameDir, id), '.berry-installed'))) continue
    const guessed = loaderFromId(id)
    const chainRoot = (() => {
      let current: MojangVersionJson | null = json
      const seen = new Set<string>()
      while (current?.inheritsFrom && !seen.has(current.id)) {
        seen.add(current.id)
        current = vs.readInstalledJson(current.inheritsFrom)
      }
      return current?.id ?? id
    })()
    let modCount = 0
    try {
      modCount = fs
        .readdirSync(path.join(instanceDir(gameDir, id), 'mods'))
        .filter((file) => file.endsWith('.jar') || file.endsWith('.jar.disabled')).length
    } catch {
      /* no mods dir */
    }
    result.push({
      id,
      name: meta?.name ?? (id === chainRoot ? `Minecraft ${id}` : id),
      mcVersion: meta?.mcVersion ?? chainRoot,
      loader: meta?.loader ?? guessed.loader,
      loaderVersion: meta?.loaderVersion ?? guessed.loaderVersion,
      createdAt: meta?.createdAt ?? fs.statSync(versionDir(gameDir, id)).birthtimeMs,
      lastPlayedAt: meta?.lastPlayedAt,
      playTimeSec: meta?.playTimeSec,
      settings: meta?.settings ?? {},
      broken: !fs.existsSync(versionJsonPath(gameDir, id)),
      size: dirSize(versionDir(gameDir, id)),
      modCount,
      pack: meta?.pack,
    })
  }
  return result.sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt))
}

export function updateInstanceSettings(
  gameDir: string,
  id: string,
  patch: Partial<InstanceSettings>,
  vs: VersionService,
): InstanceMeta {
  const existing = readMeta(gameDir, id)
  const json = vs.readInstalledJson(id)
  if (!json) throw new Error(`实例 ${id} 不存在`)
  const base =
    existing ??
    createInstanceMeta(id, loaderFromId(id).loader, json.inheritsFrom ?? id, loaderFromId(id).loaderVersion, {})
  const meta: InstanceMeta = { ...base, settings: { ...base.settings, ...patch } }
  writeMeta(gameDir, meta)
  return meta
}

export function deleteInstance(gameDir: string, id: string, vs: VersionService): void {
  const root = path.join(gameDir, 'versions')
  let dependents: string[] = []
  try {
    dependents = fs
      .readdirSync(root)
      .filter((other) => other !== id)
      .filter((other) => vs.readInstalledJson(other)?.inheritsFrom === id)
  } catch {
    /* ignore */
  }
  if (dependents.length > 0) {
    throw new Error(`无法删除：${dependents.join('、')} 依赖该版本`)
  }
  fs.rmSync(versionDir(gameDir, id), { recursive: true, force: true })
  fs.rmSync(instanceDir(gameDir, id), { recursive: true, force: true })
  ensureDir(instancesDir(gameDir))
}
