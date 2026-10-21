import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { TaskKind, TaskStatus, TaskUpdate } from '../shared/types'

export class TaskCancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'TaskCancelledError'
  }
}

export interface Reporter {
  readonly signal: AbortSignal
  set(patch: Partial<TaskUpdate>): void
  throwIfCancelled(): void
}

export class TaskReporter implements Reporter {
  constructor(
    private readonly manager: TaskManager,
    readonly id: string,
    private readonly controller: AbortController,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal
  }

  set(patch: Partial<TaskUpdate>): void {
    this.manager.patch(this.id, patch)
  }

  throwIfCancelled(): void {
    if (this.controller.signal.aborted) throw new TaskCancelledError()
  }
}

interface TaskRecord {
  update: TaskUpdate
  controller: AbortController
  lastSampleAt: number
  lastSampleReceived: number
  lastBroadcast: number
}

export class TaskManager extends EventEmitter {
  private readonly records = new Map<string, TaskRecord>()

  create(kind: TaskKind, title: string, detail = ''): TaskReporter {
    const id = randomUUID()
    const controller = new AbortController()
    const update: TaskUpdate = {
      id,
      kind,
      title,
      detail,
      progress: 0,
      received: 0,
      total: 0,
      speed: 0,
      status: 'running',
      startedAt: Date.now(),
    }
    this.records.set(id, {
      update,
      controller,
      lastSampleAt: Date.now(),
      lastSampleReceived: 0,
      lastBroadcast: 0,
    })
    this.emitUpdate(id, true)
    return new TaskReporter(this, id, controller)
  }

  patch(id: string, patch: Partial<TaskUpdate>): void {
    const record = this.records.get(id)
    if (!record) return
    const before = record.update
    record.update = { ...before, ...patch }

    if (patch.received !== undefined) {
      const now = Date.now()
      const dt = (now - record.lastSampleAt) / 1000
      if (dt >= 0.4) {
        const delta = Math.max(0, record.update.received - record.lastSampleReceived)
        const instant = delta / dt
        record.update.speed = record.update.speed > 0 ? record.update.speed * 0.6 + instant * 0.4 : instant
        record.lastSampleAt = now
        record.lastSampleReceived = record.update.received
      }
    }
    if (record.update.status !== 'running') record.update.speed = 0
    this.emitUpdate(id, false)
  }

  finish(id: string, status: TaskStatus, patch: Partial<TaskUpdate> = {}): void {
    const record = this.records.get(id)
    if (!record) return
    record.update = {
      ...record.update,
      ...patch,
      status,
      speed: 0,
      finishedAt: Date.now(),
      progress: status === 'completed' ? 1 : record.update.progress,
    }
    this.emitUpdate(id, true)
  }

  cancel(id: string): void {
    const record = this.records.get(id)
    if (!record) return
    record.controller.abort()
    if (record.update.status === 'running') {
      record.update = { ...record.update, status: 'cancelled', speed: 0, finishedAt: Date.now() }
      this.emitUpdate(id, true)
    }
  }

  list(): TaskUpdate[] {
    return [...this.records.values()]
      .map((r) => r.update)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  private emitUpdate(id: string, force: boolean): void {
    const record = this.records.get(id)
    if (!record) return
    const now = Date.now()
    if (!force && now - record.lastBroadcast < 120) return
    record.lastBroadcast = now
    this.emit('update', { ...record.update })
  }
}

export const taskManager = new TaskManager()
