// Dev orchestrator: starts Vite, compiles main/preload, then launches Electron.
// Deliberately dependency-free so `npm run dev` works on a fresh clone.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const viteBin = require.resolve('vite/bin/vite.js')
const tscBin = require.resolve('typescript/bin/tsc')

const DEV_URL = 'http://127.0.0.1:5173'
const children = new Set()

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
  children.add(child)
  child.on('exit', () => children.delete(child))
  return child
}

function shutdown(code = 0) {
  for (const c of children) {
    try { c.kill('SIGTERM') } catch { /* ignore */ }
  }
  process.exit(code)
}

async function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve(res.statusCode !== undefined && res.statusCode < 500)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(1500, () => { req.destroy(); resolve(false) })
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

const vite = run(process.execPath, [viteBin, '--port', '5173', '--strictPort'])
vite.on('exit', (code) => { if (code) shutdown(code) })

console.log('[dev] waiting for vite ...')
if (!(await waitForServer(DEV_URL))) {
  console.error('[dev] vite did not start in time')
  shutdown(1)
}

console.log('[dev] compiling main process ...')
const tsc = run(process.execPath, [tscBin, '-p', 'tsconfig.main.json'])
await new Promise((resolve) => tsc.on('exit', (code) => {
  if (code !== 0) { console.error('[dev] tsc failed'); shutdown(code ?? 1) }
  resolve()
}))

console.log('[dev] starting electron ...')
const electron = run(electronPath, ['.'], {
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL, NODE_ENV: 'development' },
})
electron.on('exit', (code) => shutdown(code ?? 0))

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
