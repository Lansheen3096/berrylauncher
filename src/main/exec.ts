import { spawn } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  onLine?: (line: string) => void
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/**
 * Run a child process, streaming both stdout and stderr line by line.
 * Rejects when the process cannot be started or the timeout fires.
 */
export function runCommand(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let buffer = ''
    let stderrBuffer = ''

    const emitLines = (chunk: string, which: 'out' | 'err') => {
      const target = which === 'out' ? 'out' : 'err'
      let buf = target === 'out' ? buffer : stderrBuffer
      buf += chunk
      const parts = buf.split(/\r?\n/)
      buf = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        if (which === 'out') stdout += `${line}\n`
        else stderr += `${line}\n`
        opts.onLine?.(line)
      }
      if (target === 'out') buffer = buf
      else stderrBuffer = buf
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => emitLines(chunk, 'out'))
    child.stderr?.on('data', (chunk: string) => emitLines(chunk, 'err'))

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGKILL')
          reject(new Error('进程执行超时'))
        }, opts.timeoutMs)
      : null

    const onAbort = () => {
      if (settled) return
      child.kill('SIGTERM')
    }
    opts.signal?.addEventListener('abort', onAbort)

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code, signal) => {
      if (buffer.trim()) opts.onLine?.(buffer.trim())
      if (stderrBuffer.trim()) stderr += stderrBuffer
      finish(() => resolve({ code, signal, stdout, stderr }))
    })
  })
}
