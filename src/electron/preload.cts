const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

type BasicResponse = import('../shared/models.js').BasicResponse
type RunMigrationRequest = import('../shared/models.js').RunMigrationRequest
type ToggleSkillRequest = import('../shared/models.js').ToggleSkillRequest
type UiApi = import('../shared/models.js').UiApi

const api: UiApi = {
  getSnapshot: () => ipcRenderer.invoke('skills:getSnapshot'),
  toggleSkill: (request: ToggleSkillRequest) => ipcRenderer.invoke('skills:toggleSkill', request),
  runMigration: (request?: RunMigrationRequest) => ipcRenderer.invoke('skills:runMigration', request),
  openPath: (targetPath: string): Promise<BasicResponse> => ipcRenderer.invoke('app:openPath', targetPath),
}

contextBridge.exposeInMainWorld('skillsSwitch', api)
