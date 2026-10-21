#!/usr/bin/env node
/**
 * End-to-end smoke test. Drives the real Electron window over the Chrome
 * DevTools Protocol: installs a vanilla version, then launches it, capturing
 * screenshots along the way.
 *
 * Usage:
 *   node scripts/e2e.mjs                    # fresh data dir in .e2e-data
 *   BERRY_E2E_DATA=/tmp/foo node scripts/e2e.mjs
 *
 * Requires a graphical session (X11/XWayland) — it opens a real window.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const dataDir = process.env.BERRY_E2E_DATA ?? path.join(root, '.e2e-data')
const shotDir = path.join(root, '.shots')
const port = 9333
const MC_VERSION = process.env.BERRY_E2E_VERSION ?? '1.20.1'
const WITH_FORGE = process.env.BERRY_E2E_FORGE === '1'

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(shotDir, { recursive: true })

let cdp = null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...args) => console.log('[e2e]', ...args)

const child = spawn(
  electronPath,
  ['.', '--no-sandbox', '--ozone-platform=x11', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, '.chromium-e2e')}`],
  {
    cwd: root,
    env: {
      ...process.env,
      HOME: path.join(root, '.home'),
      XDG_CONFIG_HOME: path.join(root, '.home/.config'),
      XDG_CACHE_HOME: path.join(root, '.home/.cache'),
      BERRY_DATA_DIR: dataDir,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
child.stdout.on('data', (d) => process.env.BERRY_E2E_VERBOSE && process.stdout.write(d))
child.stderr.on('data', (d) => process.env.BERRY_E2E_VERBOSE && process.stderr.write(d))

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
        if (msg.method === 'Runtime.consoleAPICalled') {
          const args = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
          if (msg.params.type === 'error') console.log('[renderer:error]', args)
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          console.log('[renderer:exception]', msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
        }
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
}

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('CDP target not found')
}

const evaluate = async (expression) => {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'evaluate failed')
  }
  return res.result.value
}

const click = (selector, text) => {
  const expr = `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = ${text ? `nodes.find((n) => n.textContent && n.textContent.includes(${JSON.stringify(text)}))` : 'nodes[0]'};
    if (!node) throw new Error('not found: ${selector} ${text ?? ''}');
    node.click();
    return true;
  })()`
  return evaluate(expr)
}

const setInput = (selector, value) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('input not found: ${selector}');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`)

async function waitFor(expression, timeoutMs, label) {
  const started = Date.now()
  for (;;) {
    try {
      if (await evaluate(expression)) return true
    } catch {
      /* keep polling */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await sleep(700)
  }
}

async function screenshot(name) {
  await sleep(650)
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(shotDir, `e2e-${name}.png`)
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'))
  log('screenshot', file)
}

const bodyText = () => evaluate('document.body.innerText')

async function main() {
  const target = await waitForTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  await waitFor('!!document.querySelector(".hero")', 20000, 'home page')
  await sleep(1200)
  await screenshot('01-home')

  // account (idempotent for reused data dirs)
  const accountState = await evaluate('window.berry.accounts.state()')
  if (accountState.accounts.length === 0) {
    await click('.account-card')
    await waitFor('!!document.querySelector(".modal")', 5000, 'account modal')
    await setInput('.modal input.input', 'BerryTester')
    await sleep(200)
    await click('.modal .btn-primary', '添加离线账户')
    await waitFor('!document.querySelector(".modal")', 5000, 'account modal closed')
    log('offline account added')
  } else {
    log('reusing account', accountState.accounts[0].name)
  }

  // browse
  await click('.nav-item', '版本库')
  await waitFor('!!document.querySelector(".version-row")', 20000, 'version list')
  await screenshot('02-browse')

  await setInput('.search input', MC_VERSION)
  await sleep(600)
  const rowExpr = `(() => {
    const row = [...document.querySelectorAll('.version-row')].find((r) => r.querySelector('.version-id')?.textContent.trim() === ${JSON.stringify(MC_VERSION)});
    if (!row) return false;
    row.querySelector('button').click();
    return true;
  })()`
  if (!(await evaluate(rowExpr))) throw new Error('version row not found: ' + MC_VERSION)
  await waitFor('!!document.querySelector(".loader-grid")', 5000, 'install dialog')
  await sleep(500)
  await screenshot('03-install-dialog')
  await click('.install-foot-actions .btn-primary')
  await waitFor('!!document.querySelector(".download-card")', 10000, 'download task')
  log('install started')
  await screenshot('04-downloads')
  await evaluate('window.__e2eMarker = Date.now()')

  const started = Date.now()
  let lastShot = 0
  for (;;) {
    const alive = await evaluate('Boolean(window.__e2eMarker)')
    if (!alive) {
      log('!! renderer reloaded during install — page state was reset')
      await evaluate('window.__e2eMarker = Date.now()')
    }
    const tasks = await evaluate('window.berry.tasks.list()')
    const install = tasks.filter((t) => t.kind === 'install')[0]
    if (install?.status === 'failed') {
      log('install failed:', install.error)
      await screenshot('04-install-failed')
      throw new Error('install failed: ' + install.error)
    }
    if (install?.status === 'completed') break
    if (Date.now() - started > 20 * 60 * 1000) throw new Error('install timed out')
    if (Date.now() - lastShot > 30000) {
      lastShot = Date.now()
      log('installing…', install?.progress, install?.detail, install?.status)
    }
    await sleep(2000)
  }
  log('install finished in', Math.round((Date.now() - started) / 1000), 's')
  await screenshot('05-downloads-done')

  // instances
  await click('.nav-item', '实例')
  await waitFor('!!document.querySelector(".instance-card")', 5000, 'instance list')
  await sleep(600)
  await screenshot('06-instances')

  if (WITH_FORGE) {
    log('installing Forge on top of', MC_VERSION)
    await click('.nav-item', '版本库')
    await waitFor('!!document.querySelector(".version-row")', 10000, 'version list')
    await setInput('.search input', MC_VERSION)
    await sleep(500)
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.version-row')].find((r) => r.querySelector('.version-id')?.textContent.trim() === ${JSON.stringify(MC_VERSION)});
      row.querySelector('button').click();
    })()`)
    await waitFor('!!document.querySelector(".loader-grid")', 5000, 'install dialog')
    await click('.loader-card', 'Forge')
    await waitFor('!!document.querySelector(".install-options select")', 15000, 'forge versions')
    await click('.install-foot-actions .btn-primary')
    const forgeStarted = Date.now()
    for (;;) {
      const tasks = await evaluate('window.berry.tasks.list()')
      const install = tasks.filter((t) => t.kind === 'install')[0]
      if (install?.status === 'failed') throw new Error('forge install failed: ' + install.error)
      if (install?.status === 'completed') break
      if (Date.now() - forgeStarted > 20 * 60 * 1000) throw new Error('forge install timeout')
      await sleep(3000)
    }
    log('forge install done')
    await click('.nav-item', '实例')
    await waitFor('document.querySelectorAll(".instance-card").length >= 2', 5000, 'two instances')
    await sleep(600)
    await screenshot('07-instances-with-forge')
  }

  // launch the Forge instance when testing it, otherwise the first card
  if (WITH_FORGE) {
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.instance-card')].find((c) => c.textContent.includes('Forge'));
      if (!card) throw new Error('Forge instance not found');
      card.querySelector('.btn-primary').click();
    })()`)
  } else {
    await click('.instance-card .btn-primary', '启动')
  }
  await waitFor('!!document.querySelector(".console-drawer")', 10000, 'console drawer')
  log('launching…')
  const launchStarted = Date.now()
  let gameReady = false
  while (Date.now() - launchStarted < 180000) {
    const text = await evaluate('document.querySelector(".console-body")?.innerText ?? ""')
    if (/Sound engine started|OpenAL initialized|Stopping!/.test(text)) {
      gameReady = true
      break
    }
    if ((await evaluate('document.querySelector(".console-status")?.textContent ?? ""')).includes('启动失败')) break
    await sleep(2000)
  }
  await screenshot('08-console')
  log(gameReady ? 'game reached menu (log markers found)' : 'game markers not found, inspect screenshot')
  const drawer = await evaluate('document.querySelector(".console-body")?.innerText.slice(-1500) ?? ""')
  log('--- console tail ---\n' + drawer)

  await evaluate('window.berry.app.close()').catch(() => undefined)
  ws.close()
}

main()
  .then(() => {
    log('done')
    setTimeout(() => {
      child.kill('SIGTERM')
      process.exit(0)
    }, 500)
  })
  .catch(async (err) => {
    console.error('[e2e] failed:', err)
    try {
      await screenshot('99-failure')
    } catch {
      /* ignore */
    }
    child.kill('SIGTERM')
    setTimeout(() => process.exit(1), 500)
  })
