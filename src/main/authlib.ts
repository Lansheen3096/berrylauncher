import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AUTHLIB_INJECTOR_META } from '../shared/constants'
import { dataDir, ensureDir } from './paths'
import { getJson } from './net'
import { Downloader } from './download'
import { log } from './logger'

interface InjectorMeta {
  version: string
  build_number: number
  download_url: string
  checksums: { sha256: string }
}

async function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

class AuthlibInjector {
  private cached: string | null = null
  private inflight: Promise<string> | null = null

  async ensureJar(): Promise<string> {
    if (this.cached && fs.existsSync(this.cached)) return this.cached
    if (this.inflight) return this.inflight
    this.inflight = this.download().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async download(): Promise<string> {
    const meta = await getJson<InjectorMeta>(AUTHLIB_INJECTOR_META)
    const dir = path.join(dataDir(), 'runtime', 'authlib-injector')
    ensureDir(dir)
    const dest = path.join(dir, `authlib-injector-${meta.version}.jar`)
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 100_000) {
      await new Downloader({ concurrency: 1, source: 'official' }).run([
        { url: meta.download_url, dest },
      ])
    }
    if (meta.checksums?.sha256) {
      const digest = await sha256(dest)
      if (digest !== meta.checksums.sha256) {
        fs.rmSync(dest, { force: true })
        throw new Error('authlib-injector 校验失败，请重试')
      }
    }
    this.cached = dest
    log.info('authlib-injector ready', meta.version, dest)
    return dest
  }
}

export const authlibInjector = new AuthlibInjector()
