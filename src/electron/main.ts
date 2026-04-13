import path from 'node:path'
import { promises as fs } from 'node:fs'

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'

import { SkillService } from './skill-service.js'

const DEV_SERVER_URL = 'http://127.0.0.1:5173'
const PORTABLE_ENV_KEYS = ['PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME'] as const

let mainWindow: BrowserWindow | null = null
let startupLogPath: string | null = null
const clearedPortableEnvKeys = PORTABLE_ENV_KEYS.filter((key) => Boolean(process.env[key]))
const isWindows = process.platform === 'win32'
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.disableHardwareAcceleration()
for (const key of PORTABLE_ENV_KEYS) {
  delete process.env[key]
}

async function logStartup(message: string): Promise<void> {
  if (!startupLogPath) {
    return
  }

  await fs.appendFile(startupLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8').catch(() => undefined)
}

async function createMainWindow(): Promise<void> {
  const preloadPath = path.join(import.meta.dirname, 'preload.cjs')
  const iconPath = app.isPackaged
    ? path.join(app.getAppPath(), 'assets', 'icons', 'icon.png')
    : path.join(process.cwd(), 'assets', 'icons', 'icon.png')
  await logStartup(`createMainWindow preload=${preloadPath}`)
  await logStartup(`createMainWindow icon=${iconPath}`)

  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1160,
    minHeight: 720,
    backgroundColor: '#101317',
    title: 'Skills Switch',
    icon: iconPath,
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    void logStartup(`did-fail-load code=${errorCode} description=${errorDescription} url=${validatedUrl}`)
  })

  if (app.isPackaged) {
    const appPath = app.getAppPath()
    const indexHtmlPath = path.join(appPath, 'dist', 'index.html')
    await logStartup(`packaged appPath=${appPath}`)
    await logStartup(`packaged indexHtmlPath=${indexHtmlPath}`)
    await mainWindow.loadFile(indexHtmlPath)
  } else {
    await logStartup(`dev url=${DEV_SERVER_URL}`)
    await mainWindow.loadURL(DEV_SERVER_URL)
  }
}

app.whenReady().then(async () => {
  app.setName('Skills Switch')
  if (isWindows) {
    Menu.setApplicationMenu(null)
  }
  startupLogPath = path.join(app.getPath('userData'), 'startup.log')
  await fs.mkdir(path.dirname(startupLogPath), { recursive: true })
  await fs.writeFile(startupLogPath, '', 'utf8')
  await logStartup(`ready packaged=${app.isPackaged} resourcesPath=${process.resourcesPath}`)
  if (clearedPortableEnvKeys.length > 0) {
    await logStartup(`cleared portable env keys=${clearedPortableEnvKeys.join(',')}`)
  }
  const skillService = new SkillService(app.getPath('userData'))

  ipcMain.handle('skills:getSnapshot', () => skillService.getSnapshot())
  ipcMain.handle('skills:toggleSkill', (_event, request) => skillService.toggleSkill(request))
  ipcMain.handle('skills:runMigration', (_event, request) => skillService.runMigration(request))
  ipcMain.handle('app:openPath', async (_event, targetPath) => {
    const error = await shell.openPath(targetPath)
    return {
      ok: error.length === 0,
      message: error.length === 0 ? `Opened ${targetPath}.` : error,
    }
  })
  ipcMain.handle('window:minimize', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    senderWindow?.minimize()
  })
  ipcMain.handle('window:toggleMaximize', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (!senderWindow) {
      return false
    }

    if (senderWindow.isMaximized()) {
      senderWindow.unmaximize()
      return false
    }

    senderWindow.maximize()
    return true
  })
  ipcMain.handle('window:close', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    senderWindow?.close()
  })
  ipcMain.handle('window:isMaximized', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    return senderWindow?.isMaximized() ?? false
  })

  try {
    await createMainWindow()
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    await dialog.showErrorBox('Skills Switch failed to start', message)
    throw error
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
