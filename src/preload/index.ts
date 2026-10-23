import { contextBridge, ipcRenderer } from 'electron'
import type {
  AccountProfile,
  CreateProfileRequest,
  GameVersion,
  ModProfile,
  ModProvider,
  ModSearchResult,
  PublicLauncherConfig,
  SaveLauncherConfig,
  LauncherStatus,
} from '../main/types'

export interface LauncherApi {
  initialData(): Promise<{ config: PublicLauncherConfig; account?: AccountProfile; installedVersions: string[]; modProfiles: ModProfile[] }>
  saveConfig(config: SaveLauncherConfig): Promise<PublicLauncherConfig>
  clearCurseForgeApiKey(): Promise<void>
  chooseJava(): Promise<string | undefined>
  chooseGameDirectory(): Promise<string | undefined>
  signIn(): Promise<AccountProfile>
  cancelSignIn(): Promise<void>
  signOut(): Promise<void>
  versions(): Promise<{ latestRelease: string; versions: GameVersion[] }>
  installedVersions(): Promise<string[]>
  install(version: string): Promise<void>
  launch(version: string): Promise<void>
  modProfiles(): Promise<ModProfile[]>
  createModProfile(request: CreateProfileRequest): Promise<ModProfile>
  deleteModProfile(profileId: string): Promise<void>
  searchMods(provider: ModProvider, query: string, profileId: string): Promise<ModSearchResult[]>
  installMod(provider: ModProvider, projectId: string, profileId: string): Promise<ModProfile>
  removeMod(profileId: string, fileName: string): Promise<ModProfile>
  launchModProfile(profileId: string): Promise<void>
  checkUpdates(): Promise<void>
  installUpdate(): Promise<void>
  openFolder(folder: 'root' | 'screenshots' | 'saves'): Promise<void>
  onStatus(callback: (status: LauncherStatus) => void): () => void
}

const api: LauncherApi = {
  initialData: () => ipcRenderer.invoke('launcher:initial-data'),
  saveConfig: (config) => ipcRenderer.invoke('launcher:save-config', config),
  clearCurseForgeApiKey: () => ipcRenderer.invoke('launcher:clear-curseforge-key'),
  chooseJava: () => ipcRenderer.invoke('launcher:choose-java'),
  chooseGameDirectory: () => ipcRenderer.invoke('launcher:choose-game-directory'),
  signIn: () => ipcRenderer.invoke('launcher:sign-in'),
  cancelSignIn: () => ipcRenderer.invoke('launcher:cancel-sign-in'),
  signOut: () => ipcRenderer.invoke('launcher:sign-out'),
  versions: () => ipcRenderer.invoke('launcher:versions'),
  installedVersions: () => ipcRenderer.invoke('launcher:installed-versions'),
  install: (version) => ipcRenderer.invoke('launcher:install', version),
  launch: (version) => ipcRenderer.invoke('launcher:launch', version),
  modProfiles: () => ipcRenderer.invoke('launcher:mod-profiles'),
  createModProfile: (request) => ipcRenderer.invoke('launcher:create-mod-profile', request),
  deleteModProfile: (profileId) => ipcRenderer.invoke('launcher:delete-mod-profile', profileId),
  searchMods: (provider, query, profileId) => ipcRenderer.invoke('launcher:search-mods', provider, query, profileId),
  installMod: (provider, projectId, profileId) => ipcRenderer.invoke('launcher:install-mod', provider, projectId, profileId),
  removeMod: (profileId, fileName) => ipcRenderer.invoke('launcher:remove-mod', profileId, fileName),
  launchModProfile: (profileId) => ipcRenderer.invoke('launcher:launch-mod-profile', profileId),
  checkUpdates: () => ipcRenderer.invoke('launcher:check-updates'),
  installUpdate: () => ipcRenderer.invoke('launcher:install-update'),
  openFolder: (folder) => ipcRenderer.invoke('launcher:open-folder', folder),
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: LauncherStatus) => callback(status)
    ipcRenderer.on('launcher:status', listener)
    return () => ipcRenderer.removeListener('launcher:status', listener)
  },
}

contextBridge.exposeInMainWorld('launcher', api)
