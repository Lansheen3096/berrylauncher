import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, logDir } from './paths'

let stream: fs.WriteStream | null = null

function writer(): fs.WriteStream {
  if (!stream) {
    ensureDir(logDir())
    const file = path.join(logDir(), 'launcher.log')
    stream = fs.createWriteStream(file, { flags: 'a' })
  }
  return stream
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a)))
    .join(' ')
}

function write(level: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${fmt(args)}\n`
  if (process.env.NODE_ENV !== 'production') process.stdout.write(line)
  writer().write(line)
}

export const log = {
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
  debug: (...args: unknown[]) => write('debug', args),
}
