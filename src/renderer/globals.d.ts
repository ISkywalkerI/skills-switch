import type { UiApi } from '../shared/models'

declare global {
  interface Window {
    skillsSwitch: UiApi
  }
}

export {}
