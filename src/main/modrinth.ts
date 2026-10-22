import type {
  ModrinthProject,
  ModrinthSearchQuery,
  ModrinthSearchResult,
  ModrinthVersion,
} from '../shared/types'
import { MODRINTH_API } from '../shared/constants'
import { getJson } from './net'
import { log } from './logger'

const USER_AGENT = 'BerryLauncher/0.2.0 (USTL Sweet Berry Pixel Club; github.com/USTL-SweetBerry/berrylauncher)'

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
}

export const modrinth = new ModrinthService()
