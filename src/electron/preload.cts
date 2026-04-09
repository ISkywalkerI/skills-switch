const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

type AddCustomHostRequest = import('../shared/models.js').AddCustomHostRequest
type BasicResponse = import('../shared/models.js').BasicResponse
type ToggleSkillRequest = import('../shared/models.js').ToggleSkillRequest
type UiApi = import('../shared/models.js').UiApi

const api: UiApi = {
  getSnapshot: () => ipcRenderer.invoke('skills:getSnapshot'),
  toggleSkill: (request: ToggleSkillRequest) => ipcRenderer.invoke('skills:toggleSkill', request),
  addCustomHost: (request: AddCustomHostRequest) => ipcRenderer.invoke('skills:addCustomHost', request),
  removeCustomHost: (hostId: string) => ipcRenderer.invoke('skills:removeCustomHost', hostId),
  runMigration: () => ipcRenderer.invoke('skills:runMigration'),
  chooseDirectory: () => ipcRenderer.invoke('app:chooseDirectory'),
  openPath: (targetPath: string): Promise<BasicResponse> => ipcRenderer.invoke('app:openPath', targetPath),
}

contextBridge.exposeInMainWorld('skillsSwitch', api)
