export interface LauncherConfig {
  clientId: string
  gameDirectory: string
  javaPath: string
  maxMemoryMb: number
  updateFeedUrl: string
  curseForgeApiKey: string
}

export type PublicLauncherConfig = Omit<LauncherConfig, 'curseForgeApiKey'> & {
  hasCurseForgeApiKey: boolean
}

export type SaveLauncherConfig = Omit<LauncherConfig, 'curseForgeApiKey'> & {
  curseForgeApiKey?: string
}

export type ModProvider = 'modrinth' | 'curseforge'
export type ModLoader = 'fabric' | 'forge'

export interface ModProfile {
  id: string
  name: string
  minecraftVersion: string
  loader: ModLoader
  loaderVersion: string
  gameVersionId: string
  directory: string
  mods: InstalledMod[]
}

export interface ModSearchResult {
  provider: ModProvider
  id: string
  title: string
  description: string
  downloads: number
  iconUrl?: string
  projectUrl: string
  latestVersion?: string
}

export interface InstalledMod {
  provider: ModProvider
  projectId: string
  title: string
  fileName: string
}

export interface CreateProfileRequest {
  name: string
  minecraftVersion: string
  loader: ModLoader
}

export interface AccountProfile {
  id: string
  name: string
}

export interface GameVersion {
  id: string
  type: string
  releaseTime: string
}

export interface LauncherStatus {
  kind: 'status' | 'progress' | 'error' | 'game-exit' | 'update' | 'auth-device-code' | 'auth-progress'
  message: string
  percent?: number
  updateAction?: 'check' | 'restart'
  authCode?: string
  verificationUri?: string
}
