import fs from 'node:fs'
import path from 'node:path'
import type { InstanceSummary, PlaytimeSnapshot } from '../shared/types'
import { dataDir, ensureDir } from './paths'
import { readJsonFile, writeFileAtomic } from './net'
import { log } from './logger'

interface Session {
  start: number
  end: number
  seconds: number
}

interface PlaytimeEntry {
  id: string
  name: string
  mcVersion: string
  loader: string
  totalSeconds: number
  lastPlayedAt?: number
  sessions: Session[]
  deleted?: boolean
}

interface ActiveSession {
  startedAt: number
  lastHeartbeat: number
}

interface PlaytimeFile {
  version: 1
  entries: Record<string, PlaytimeEntry>
  active: Record<string, ActiveSession>
  migrated: string[]
}

const HEARTBEAT_MS = 20_000
const MAX_SESSIONS = 50

export class PlaytimeService {
  private data: PlaytimeFile = { version: 1, entries: {}, active: {}, migrated: [] }
  private loaded = false
  private timer: NodeJS.Timeout | null = null
  private knownInstances = new Set<string>()

  private filePath(): string {
    return path.join(dataDir(), 'playtime.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const file = readJsonFile<PlaytimeFile>(this.filePath())
    if (file && file.version === 1 && file.entries) {
      this.data = {
        version: 1,
        entries: file.entries,
        active: file.active ?? {},
        migrated: file.migrated ?? [],
      }
    }
  }

  private save(): void {
    ensureDir(dataDir())
    try {
      writeFileAtomic(this.filePath(), JSON.stringify(this.data, null, 2))
    } catch (err) {
      log.warn('failed to save playtime', err)
    }
  }

  /** Reconcile stale sessions and import legacy playTimeSec once. */
  init(instances: InstanceSummary[]): void {
    this.load()
    let changed = false
    for (const [id, active] of Object.entries(this.data.active)) {
      const seconds = Math.max(0, Math.round((active.lastHeartbeat - active.startedAt) / 1000))
      const entry = this.data.entries[id]
      if (entry && seconds > 0) {
        entry.totalSeconds += seconds
        entry.sessions.push({ start: active.startedAt, end: active.lastHeartbeat, seconds })
        entry.sessions = entry.sessions.slice(-MAX_SESSIONS)
        entry.lastPlayedAt = active.lastHeartbeat
      }
      delete this.data.active[id]
      changed = true
    }
    for (const instance of instances) {
      this.knownInstances.add(instance.id)
      if (!this.data.entries[instance.id]) {
        const migrate = !this.data.migrated.includes(instance.id)
        this.data.entries[instance.id] = {
          id: instance.id,
          name: instance.name,
          mcVersion: instance.mcVersion,
          loader: instance.loader,
          totalSeconds: migrate ? (instance.playTimeSec ?? 0) : 0,
          lastPlayedAt: instance.lastPlayedAt,
          sessions: [],
          deleted: false,
        }
        if (migrate) this.data.migrated.push(instance.id)
        changed = true
      } else {
        const entry = this.data.entries[instance.id]
        const next = {
          ...entry,
          name: instance.name,
          mcVersion: instance.mcVersion,
          loader: instance.loader,
          deleted: false,
        }
        if (JSON.stringify(next) !== JSON.stringify(entry)) {
          this.data.entries[instance.id] = next
          changed = true
        }
      }
    }
    for (const entry of Object.values(this.data.entries)) {
      if (!this.knownInstances.has(entry.id) && !entry.deleted) {
        entry.deleted = true
        changed = true
      }
    }
    if (changed) this.save()
  }

  /** Called once the Java process has actually been spawned. */
  start(instanceId: string, instance: Pick<InstanceSummary, 'name' | 'mcVersion' | 'loader'>): void {
    this.load()
    if (this.data.active[instanceId]) this.end(instanceId)
    this.data.entries[instanceId] = {
      ...(this.data.entries[instanceId] ?? {
        id: instanceId,
        name: instance.name,
        mcVersion: instance.mcVersion,
        loader: instance.loader,
        totalSeconds: 0,
        sessions: [],
      }),
      name: instance.name,
      mcVersion: instance.mcVersion,
      loader: instance.loader,
      deleted: false,
    }
    this.data.active[instanceId] = { startedAt: Date.now(), lastHeartbeat: Date.now() }
    this.save()
    if (!this.timer) {
      this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    }
  }

  end(instanceId: string): void {
    this.load()
    const active = this.data.active[instanceId]
    if (!active) return
    const endedAt = Date.now()
    const seconds = Math.max(0, Math.round((endedAt - active.startedAt) / 1000))
    const entry = this.data.entries[instanceId]
    if (entry) {
      entry.totalSeconds += seconds
      if (seconds > 0) {
        entry.sessions.push({ start: active.startedAt, end: endedAt, seconds })
        entry.sessions = entry.sessions.slice(-MAX_SESSIONS)
      }
      entry.lastPlayedAt = endedAt
      entry.deleted = false
    }
    delete this.data.active[instanceId]
    this.save()
    if (Object.keys(this.data.active).length === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private heartbeat(): void {
    if (Object.keys(this.data.active).length === 0) return
    const now = Date.now()
    for (const active of Object.values(this.data.active)) active.lastHeartbeat = now
    this.save()
  }

  snapshot(): PlaytimeSnapshot {
    this.load()
    const byInstance = Object.values(this.data.entries)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        mcVersion: entry.mcVersion,
        loader: entry.loader as InstanceSummary['loader'],
        seconds: entry.totalSeconds,
        lastPlayedAt: entry.lastPlayedAt,
        deleted: entry.deleted,
      }))
      .sort((a, b) => b.seconds - a.seconds)
    const grouped = new Map<string, { seconds: number; instances: number }>()
    for (const entry of byInstance) {
      const current = grouped.get(entry.mcVersion) ?? { seconds: 0, instances: 0 }
      current.seconds += entry.seconds
      current.instances += 1
      grouped.set(entry.mcVersion, current)
    }
    return {
      totalSeconds: byInstance.reduce((sum, entry) => sum + entry.seconds, 0),
      byInstance,
      byMcVersion: [...grouped.entries()]
        .map(([mcVersion, value]) => ({ mcVersion, ...value }))
        .sort((a, b) => b.seconds - a.seconds),
      active: Object.entries(this.data.active).map(([id, active]) => ({ id, startedAt: active.startedAt })),
    }
  }

  reset(): void {
    this.load()
    this.data = { version: 1, entries: {}, active: {}, migrated: this.data.migrated }
    this.save()
  }

  markDeleted(instanceId: string): void {
    this.load()
    const entry = this.data.entries[instanceId]
    if (entry) {
      entry.deleted = true
      this.save()
    }
  }

  /** Flush live sessions at app quit (they are re-opened on next launch). */
  shutdown(): void {
    if (!this.loaded) return
    for (const instanceId of Object.keys(this.data.active)) this.end(instanceId)
  }
}

export const playtime = new PlaytimeService()
