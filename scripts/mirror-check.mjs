#!/usr/bin/env node
/** Diagnostic: download a Mojang Java runtime through the configured mirror. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const dataDir = path.join(root, '.mirror-data')
const port = 9335
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify({ downloadSource: 'bmclapi', gameDir: path.join(dataDir, 'minecraft'), concurrency: 16, memoryMB: 2048 }),
)

const child = spawn(
  electronPath,
  ['.', '--no-sandbox', '--ozone-platform=x11', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, '.chromium-mirror')}`],
  {
    cwd: root,
    env: {
      ...process.env,
      HOME: path.join(root, '.home-mirror'),
      XDG_CONFIG_HOME: path.join(root, '.home-mirror/.config'),
      BERRY_DATA_DIR: dataDir,
    },
    stdio: 'ignore',
  },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
let id = 0
const pending = new Map()
const send = (method, params = {}) => {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method, params }))
  return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }))
}

async function main() {
  let target
  for (let i = 0; i < 100 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
    } catch {}
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('no CDP target')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  await send('Runtime.enable')
  const res = await send('Runtime.evaluate', {
    expression: `window.berry.java.download('jre-legacy').then((r) => 'OK ' + JSON.stringify(r)).catch((e) => 'ERR ' + e.message)`,
    awaitPromise: true,
    returnByValue: true,
  })
  console.log(res.result?.value ?? res)
  const detected = await send('Runtime.evaluate', {
    expression: `window.berry.java.detect().then((r) => JSON.stringify(r))`,
    awaitPromise: true,
    returnByValue: true,
  })
  console.log('detect', detected.result?.value)
  await send('Runtime.evaluate', { expression: 'window.berry.app.close()' })
  ws.close()
}

main()
  .then(() => { child.kill('SIGTERM'); process.exit(0) })
  .catch((err) => { console.error(err); child.kill('SIGTERM'); process.exit(1) })
