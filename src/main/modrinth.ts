import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { net } from 'electron'
import type {
  ModrinthProject,
  ModrinthSearchQuery,
  ModrinthSearchResult,
  ModrinthVersion,
} from '../shared/types'
import { APP_VERSION, MODRINTH_API } from '../shared/constants'
import { getJson, writeFileAtomic } from './net'
import { dataDir, ensureDir } from './paths'
import { log } from './logger'

const USER_AGENT = `BerryLauncher/${APP_VERSION} (USTL Sweet Berry Pixel Club; github.com/USTL-SweetBerry/berrylauncher)`

interface RawHit {
  project_id: string
  slug: string
  title: string
  description: string
  icon_url?: string
  downloads: number
  follows: number
  categories: string[]
  client_side: string
  server_side: string
  project_type: string
  author?: string
  versions?: string[]
}

function mapHit(hit: RawHit): ModrinthProject {
  return {
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    iconUrl: hit.icon_url,
    downloads: hit.downloads ?? 0,
    follows: hit.follows ?? 0,
    categories: hit.categories ?? [],
    clientSide: hit.client_side ?? 'unknown',
    serverSide: hit.server_side ?? 'unknown',
    projectType: hit.project_type ?? 'mod',
    author: hit.author,
    versions: hit.versions,
  }
}

interface RawVersion {
  id: string
  project_id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  date_published: string
  downloads: number
  files: {
    filename: string
    url: string
    size: number
    primary: boolean
    hashes: { sha1?: string; sha512?: string }
  }[]
  dependencies: {
    version_id?: string
    project_id?: string
    file_name?: string
    dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded'
  }[]
}

function mapVersion(raw: RawVersion): ModrinthVersion {
  return {
    id: raw.id,
    projectId: raw.project_id,
    name: raw.name,
    versionNumber: raw.version_number,
    gameVersions: raw.game_versions ?? [],
    loaders: raw.loaders ?? [],
    datePublished: raw.date_published,
    downloads: raw.downloads ?? 0,
    files: (raw.files ?? []).map((file) => ({
      filename: file.filename,
      url: file.url,
      size: file.size,
      primary: Boolean(file.primary),
      hashes: { sha1: file.hashes?.sha1, sha512: file.hashes?.sha512 },
    })),
    dependencies: (raw.dependencies ?? []).map((dep) => ({
      versionId: dep.version_id,
      projectId: dep.project_id,
      fileName: dep.file_name,
      dependencyType: dep.dependency_type,
    })),
  }
}

export class ModrinthService {
  private readonly cache = new Map<string, { expires: number; value: unknown }>()

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value as T
    const value = await load()
    this.cache.set(key, { expires: Date.now() + ttlMs, value })
    return value
  }

  async search(query: ModrinthSearchQuery): Promise<ModrinthSearchResult> {
    const facets: string[][] = [[`project_type:${query.projectType}`]]
    if (query.gameVersion) facets.push([`versions:${query.gameVersion}`])
    if (query.loader && query.loader !== 'vanilla') facets.push([`categories:${query.loader}`])
    if (query.category) facets.push([`categories:${query.category}`])
    const params = new URLSearchParams({
      query: query.query ?? '',
      limit: String(Math.min(50, query.limit ?? 20)),
      offset: String(query.offset ?? 0),
      index: query.sort ?? 'relevance',
      facets: JSON.stringify(facets),
    })
    const key = `search:${params}`
    return this.cached(key, 60_000, async () => {
      const data = await getJson<{ hits: RawHit[]; total_hits: number; offset: number; limit: number }>(
        `${MODRINTH_API}/search?${params}`,
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
      )
      log.debug('modrinth search', query.query, data.total_hits)
      return {
        hits: data.hits.map(mapHit),
        totalHits: data.total_hits,
        offset: data.offset,
        limit: data.limit,
      }
    })
  }

  async project(id: string): Promise<ModrinthProject> {
    const data = await getJson<RawHit & { body?: string }>(`${MODRINTH_API}/project/${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    })
    return mapHit(data)
  }

  async versions(projectId: string, gameVersion?: string, loader?: string): Promise<ModrinthVersion[]> {
    const params = new URLSearchParams()
    if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]))
    if (loader && loader !== 'vanilla') params.set('loaders', JSON.stringify([loader]))
    const key = `versions:${projectId}:${gameVersion ?? ''}:${loader ?? ''}`
    return this.cached(key, 120_000, async () => {
      const data = await getJson<RawVersion[]>(
        `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${params}`,
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
      )
      return data.map(mapVersion)
    })
  }

  async version(versionId: string): Promise<ModrinthVersion> {
    const data = await getJson<RawVersion>(`${MODRINTH_API}/version/${encodeURIComponent(versionId)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    })
    return mapVersion(data)
  }

  /**
   * Fetch a Modrinth icon through Electron's network stack and cache it as a
   * data URL. Some Windows networks can reach api.modrinth.com but fail to
   * load cdn.modrinth.com directly; this gives the renderer a retry path and
   * keeps working after the first successful fetch.
   */
  private readonly iconJobs = new Map<string, Promise<string | null>>()
  async icon(rawUrl: string): Promise<string | null> {
    if (!rawUrl) return null
    const existing = this.iconJobs.get(rawUrl)
    if (existing) return existing
    const job = this.loadIcon(rawUrl).finally(() => this.iconJobs.delete(rawUrl))
    this.iconJobs.set(rawUrl, job)
    return job
  }

  private async loadIcon(rawUrl: string): Promise<string | null> {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return null
    }
    const allowed =
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'cdn.modrinth.com' ||
        parsed.hostname.endsWith('.modrinth.com') ||
        parsed.hostname === 'mod.mcimirror.top')
    if (!allowed) return null

    const key = crypto.createHash('sha1').update(rawUrl).digest('hex')
    const dir = path.join(dataDir(), 'icons')
    const file = path.join(dir, key)
    const mimeFile = `${file}.mime`
    try {
      const mime = fs.readFileSync(mimeFile, 'utf8').trim()
      const data = fs.readFileSync(file)
      if (mime.startsWith('image/') && data.length > 0) {
        return `data:${mime};base64,${data.toString('base64')}`
      }
    } catch {
      /* no cache */
    }

    const candidates = [rawUrl]
    if (parsed.hostname === 'cdn.modrinth.com') {
      // Some networks can fetch png but fail on the webp CDN variant.
      const png = /^\/data\/([^/]+)\//.exec(parsed.pathname)
      if (png) candidates.push(`https://cdn.modrinth.com/data/${png[1]}/icon.png`)
      candidates.push(`https://mod.mcimirror.top${parsed.pathname}${parsed.search}`)
    }
    for (const candidate of candidates) {
      try {
        const res = await net.fetch(candidate, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'image/webp,image/png,image/jpeg,image/*',
          },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) continue
        const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(mime)) continue
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length === 0 || buffer.length > 3 * 1024 * 1024) continue
        ensureDir(dir)
        writeFileAtomic(file, buffer)
        writeFileAtomic(mimeFile, mime)
        return `data:${mime};base64,${buffer.toString('base64')}`
      } catch (err) {
        log.debug('icon fetch failed', candidate, err)
      }
    }
    return null
  }
}

export const modrinth = new ModrinthService()
