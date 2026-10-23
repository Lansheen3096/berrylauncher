import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { DeepPartial, Settings } from '../shared/types'
import { DEFAULT_MEMORY, MAX_MEMORY, MIN_MEMORY } from '../shared/constants'
import { defaultGameDir, ensureDir, settingsFile } from './paths'
import { log } from './logger'

function defaults(): Settings {
  return {
    theme: { accent: '#2b8f5c', mode: 'dark' },
    gameDir: defaultGameDir(),
    downloadSource: 'official',
    concurrency: 12,
    memoryMB: DEFAULT_MEMORY,
    javaPath: '',
    jvmArgs: '',
    msClientId: '',
    consoleAutoOpen: false,
    versionIsolation: true,
    resourceAutoSlim: false,
  }
}

function sanitize(input: Settings): Settings {
  const memory = Math.round(Number(input.memoryMB) || DEFAULT_MEMORY)
  const concurrency = Math.round(Number(input.concurrency) || 12)
  const rawAccent = input.theme?.accent
  const accent =
    !rawAccent || rawAccent.toLowerCase() === '#3ddc84'
      ? '#2b8f5c'
      : /^#[0-9a-f]{6}$/i.test(rawAccent)
        ? rawAccent
        : '#2b8f5c'
  return {
    ...input,
    theme: { accent, mode: input.theme?.mode === 'light' ? 'light' : 'dark' },
    concurrency: Math.min(32, Math.max(1, concurrency)),
    memoryMB: Math.min(MAX_MEMORY, Math.max(MIN_MEMORY, memory)),
    gameDir: input.gameDir?.trim() || defaultGameDir(),
    downloadSource: input.downloadSource === 'bmclapi' ? 'bmclapi' : 'official',
    msClientId: (input.msClientId ?? '').trim(),
    javaPath: (input.javaPath ?? '').trim(),
    jvmArgs: input.jvmArgs ?? '',
    consoleAutoOpen: Boolean(input.consoleAutoOpen),
    versionIsolation: input.versionIsolation !== false,
    resourceAutoSlim: Boolean(input.resourceAutoSlim),
  }
}

export class SettingsStore extends EventEmitter {
  private value: Settings = defaults()
  private loaded = false

  load(): Settings {
    if (this.loaded) return this.value
    this.loaded = true
    try {
      ensureDir(path.dirname(settingsFile()))
      if (fs.existsSync(settingsFile())) {
        const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>
        this.value = sanitize({ ...defaults(), ...raw, theme: { ...defaults().theme, ...(raw.theme ?? {}) } })
      }
    } catch (err) {
      log.warn('failed to read settings, falling back to defaults', err)
    }
    ensureDir(this.value.gameDir)
    return this.value
  }

  get(): Settings {
    return this.load()
  }

  update(patch: DeepPartial<Settings>): Settings {
    const current = this.load()
    const merged: Settings = {
      ...current,
      ...(patch as Partial<Settings>),
      theme: { ...current.theme, ...((patch.theme ?? {}) as Partial<Settings['theme']>) },
    }
    this.value = sanitize(merged)
    ensureDir(this.value.gameDir)
    this.persist()
    this.emit('changed', this.value)
    return this.value
  }

  private persist(): void {
    const file = settingsFile()
    ensureDir(path.dirname(file))
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }
}

export const settingsStore = new SettingsStore()
