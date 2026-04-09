import path from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

import { SkillService } from './skill-service.js'

const DEV_SERVER_URL = 'http://127.0.0.1:5173'

let mainWindow: BrowserWindow | null = null

async function createMainWindow(): Promise<void> {
  const preloadPath = path.join(import.meta.dirname, 'preload.cjs')
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1160,
    minHeight: 720,
    backgroundColor: '#101317',
    title: 'Skills Switch',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (app.isPackaged) {
    await mainWindow.loadFile(path.resolve(import.meta.dirname, '..', '..', 'dist', 'index.html'))
  } else {
    await mainWindow.loadURL(DEV_SERVER_URL)
  }
}

app.whenReady().then(async () => {
  app.setName('Skills Switch')
  const skillService = new SkillService(app.getPath('userData'))

  ipcMain.handle('skills:getSnapshot', () => skillService.getSnapshot())
  ipcMain.handle('skills:toggleSkill', (_event, request) => skillService.toggleSkill(request))
  ipcMain.handle('skills:addCustomHost', (_event, request) => skillService.addCustomHost(request))
  ipcMain.handle('skills:removeCustomHost', (_event, hostId) => skillService.removeCustomHost(hostId))
  ipcMain.handle('skills:runMigration', () => skillService.runMigration())
  ipcMain.handle('app:chooseDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a skills host directory',
    })

    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('app:openPath', async (_event, targetPath) => {
    const error = await shell.openPath(targetPath)
    return {
      ok: error.length === 0,
      message: error.length === 0 ? `Opened ${targetPath}.` : error,
    }
  })

  await createMainWindow()

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
