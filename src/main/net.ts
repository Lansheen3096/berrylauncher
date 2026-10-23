import fs from 'node:fs'
import path from 'node:path'
import { APP_VERSION, BMCLAPI } from '../shared/constants'
import type { DownloadSource } from '../shared/types'
import { ensureDir } from './paths'
import { log } from './logger'

export const USER_AGENT = `BerryLauncher/${APP_VERSION} (USTL Sweet Berry Pixel Club; +https://github.com/Lansheen3096/berrylauncher)`

export function platformName(): 'windows' | 'osx' | 'linux' {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'osx'
  return 'linux'
}

export function archName(): string {
  return process.arch === 'x64' ? 'x86_64' : process.arch
}

const HOST_MIRRORS: [string, string][] = [
  ['https://libraries.minecraft.net/', `${BMCLAPI}/maven/`],
  ['https://maven.minecraftforge.net/', `${BMCLAPI}/maven/`],
  ['https://maven.neoforged.net/releases/', `${BMCLAPI}/maven/`],
  ['https://maven.fabricmc.net/', `${BMCLAPI}/maven/`],
  ['https://maven.quiltmc.org/repository/release/', `${BMCLAPI}/maven/`],
  ['https://resources.download.minecraft.net/', `${BMCLAPI}/assets/`],
  ['https://piston-meta.mojang.com/', `${BMCLAPI}/`],
  ['https://piston-data.mojang.com/', `${BMCLAPI}/`],
  ['https://launchermeta.mojang.com/', `${BMCLAPI}/`],
  ['https://launcher.mojang.com/', `${BMCLAPI}/`],
  ['https://meta.fabricmc.net/', `${BMCLAPI}/fabric-meta/`],
  ['https://meta.quiltmc.org/', `${BMCLAPI}/quilt-meta/`],
]

export function mirrorUrl(url: string, source: DownloadSource): string {
  if (source !== 'bmclapi') return url
  for (const [prefix, replacement] of HOST_MIRRORS) {
    if (url.startsWith(prefix)) return replacement + url.slice(prefix.length)
  }
  return url
}

export function bmclVersionJson(id: string): string {
  return `${BMCLAPI}/version/${encodeURIComponent(id)}/json`
}

export function bmclClientJar(id: string): string {
  return `${BMCLAPI}/version/${encodeURIComponent(id)}/client`
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`)
    this.name = 'HttpError'
  }
}

export interface FetchOptions {
  signal?: AbortSignal
  timeoutMs?: number
  retries?: number
  method?: string
  body?: string
  headers?: Record<string, string>
  source?: DownloadSource
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * fetch with mirror rewriting, timeout, and bounded retries.
 * Retries only on network errors and 5xx/429 responses.
 */
export async function request(url: string, opts: FetchOptions = {}): Promise<Response> {
  const target = opts.source ? mirrorUrl(url, opts.source) : url
  const retries = opts.retries ?? 3
  const timeoutMs = opts.timeoutMs ?? 45000
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    opts.signal?.addEventListener('abort', onAbort)
    try {
      const res = await fetch(target, {
        method: opts.method ?? 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body,
        signal: controller.signal,
      })
      if (res.ok) return res
      lastError = new HttpError(res.status, target)
      // A definitive client error on the original host is final. On a mirror
      // we still fall back to the origin below.
      if (target === url && res.status < 500 && res.status !== 429) {
        throw lastError
      }
    } catch (err) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err
      lastError = err
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    if (attempt < retries) await sleep(400 * Math.pow(2, attempt) + Math.random() * 300)
  }
  if (target !== url) {
    log.warn('mirror request failed, falling back to origin', target, lastError)
    return request(url, { ...opts, source: undefined, retries: 1 })
  }
  log.warn('request failed', target, lastError)
  throw lastError instanceof Error ? lastError : new Error(`请求失败: ${target}`)
}

export async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await request(url, opts)
  return (await res.json()) as T
}

export async function getText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await request(url, opts)
  return res.text()
}

export function writeFileAtomic(dest: string, data: Buffer | string): void {
  ensureDir(path.dirname(dest))
  const tmp = `${dest}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, dest)
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}
