import type { BerryAPI } from '@shared/types'

declare global {
  interface Window {
    berry?: BerryAPI
  }
}

function missingBridge(): BerryAPI {
  const fail = async (): Promise<never> => {
    throw new Error('启动器桥接未加载：请通过 BerryLauncher 桌面应用运行')
  }
  return new Proxy({} as BerryAPI, {
    get: () => new Proxy({}, { get: () => fail }),
  })
}

export const api: BerryAPI = window.berry ?? missingBridge()
export const bridgeReady = Boolean(window.berry)
