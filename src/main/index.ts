import { app, BrowserWindow, Menu, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { registerIpc } from './ipc'
import { settingsStore } from './settings'
import { log } from './logger'

const isDev = !app.isPackaged
const devServerUrl = process.env.VITE_DEV_SERVER_URL

app.setAppUserModelId('club.ustl.berrylauncher')
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  const createWindow = async () => {
    mainWindow = new BrowserWindow({
      width: 1220,
      height: 800,
      minWidth: 1000,
      minHeight: 660,
      show: true,
      frame: false,
      backgroundColor: '#08120d',
      title: 'BerryLauncher',
      icon: path.join(app.getAppPath(), 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    })

    mainWindow.once('ready-to-show', () => mainWindow?.show())

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
      return { action: 'deny' }
    })

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      log.error('renderer process gone', details)
    })

    mainWindow.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) log.info('navigation started', url)
    })

    mainWindow.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) log.warn('renderer console', level, message)
    })

    mainWindow.webContents.on('will-navigate', (event, url) => {
      const target = devServerUrl ?? `file://${path.join(__dirname, '../renderer/index.html')}`
      if (!url.startsWith(target) && !url.startsWith('http://127.0.0.1:5173')) {
        event.preventDefault()
        if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
      }
    })

    if (devServerUrl) {
      await mainWindow.loadURL(devServerUrl)
    } else {
      await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
    }

    // Dev/CI helper: render the window to a PNG and exit, without needing a
    // desktop screenshot tool. Used by scripts/screenshot.mjs.
    const shotPath = process.env.BERRY_SCREENSHOT
    if (shotPath) {
      setTimeout(async () => {
        try {
          const info = await mainWindow!.webContents.executeJavaScript(
            'document.title + " | nodes=" + document.querySelectorAll(".app *").length',
          )
          log.info('screenshot: dom check', info)
          const image = await mainWindow!.webContents.capturePage()
          fs.mkdirSync(path.dirname(shotPath), { recursive: true })
          fs.writeFileSync(shotPath, image.toPNG())
          log.info('screenshot: written', image.getSize())
        } catch (err) {
          log.error('screenshot failed', err)
        } finally {
          app.quit()
        }
      }, Number(process.env.BERRY_SCREENSHOT_DELAY ?? 2200))
    }

    mainWindow.on('closed', () => {
      mainWindow = null
    })

  }

  app.whenReady().then(async () => {
    settingsStore.load()
    Menu.setApplicationMenu(null)
    registerIpc()
    await createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', err)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason)
  })
}
