#!/usr/bin/env node
/**
 * Capture documentation screenshots from the real app.
 * Usage: node scripts/screenshots.mjs  (needs a graphical session)
 * Data dir: BERRY_SHOT_DATA, defaults to .e2e-data
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const dataDir = process.env.BERRY_SHOT_DATA ?? path.join(root, '.e2e-data')
const outDir = path.join(root, 'docs', 'screenshots')
const port = 9334

fs.mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(
  electronPath,
  ['.', '--no-sandbox', '--ozone-platform=x11', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, '.chromium-shots')}`],
  {
    cwd: root,
    env: {
      ...process.env,
      HOME: path.join(root, '.home'),
      XDG_CONFIG_HOME: path.join(root, '.home/.config'),
      XDG_CACHE_HOME: path.join(root, '.home/.cache'),
      BERRY_DATA_DIR: dataDir,
    },
    stdio: 'ignore',
  },
)

let id = 0
const pending = new Map()
let ws

function send(method, params = {}) {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method, params }))
  return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }))
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate failed')
  return res.result.value
}

async function click(selector, text) {
  await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = ${text ? `nodes.find((n) => n.textContent?.includes(${JSON.stringify(text)}))` : 'nodes[0]'};
    if (!node) throw new Error('not found: ${selector}');
    node.click();
  })()`)
}

async function waitFor(expression, timeout = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(expression).catch(() => false)) return
    await sleep(250)
  }
  throw new Error('timeout: ' + expression)
}

async function shot(name) {
  await sleep(800)
  const res = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outDir, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'))
  console.log('[shots]', file)
}

async function main() {
  let target
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`)
      target = (await res.json()).find((t) => t.type === 'page')
    } catch {
      /* wait */
    }
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('CDP target not found')

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
  await send('Page.enable')
  await send('Runtime.enable')

  await waitFor('!!document.querySelector(".hero")')
  await waitFor('document.querySelectorAll(".version-row").length > 0', 15000).catch(() => undefined)
  await shot('home')

  await click('.nav-item', '版本库')
  await waitFor('!!document.querySelector(".version-row")')
  await shot('browse')

  await evaluate(`(() => {
    const input = document.querySelector('.search input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '1.20.1');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await sleep(600)
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.version-row')].find((r) => r.querySelector('.version-id')?.textContent.trim() === '1.20.1');
    row.querySelector('button').click();
  })()`)
  await waitFor('!!document.querySelector(".loader-grid")')
  await shot('install')
  await click('.modal .modal-head .icon-btn')

  await click('.nav-item', '实例')
  await waitFor('!!document.querySelector(".instance-card")').catch(() => undefined)
  await shot('instances')

  await click('.nav-item', '下载')
  await sleep(500)
  await shot('downloads')

  await click('.nav-item', '设置')
  await waitFor('!!document.querySelector(".settings-section")')
  await shot('settings')

  await evaluate('window.berry.app.close()')
  ws.close()
}

main()
  .then(() => {
    child.kill('SIGTERM')
    process.exit(0)
  })
  .catch((err) => {
    console.error('[shots] failed:', err)
    child.kill('SIGTERM')
    process.exit(1)
  })
