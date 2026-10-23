import { app, safeStorage } from 'electron'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AccountProfile, LauncherConfig, SaveLauncherConfig } from './types'

interface StoredAuth {
  microsoftRefreshToken: string
  profile: AccountProfile
}

const defaultConfig = (): LauncherConfig => ({
  clientId: '',
  gameDirectory: join(app.getPath('appData'), '.minecraft'),
  javaPath: 'java',
  maxMemoryMb: 4096,
  updateFeedUrl: '',
  curseForgeApiKey: '',
})

const configPath = () => join(app.getPath('userData'), 'launcher-config.json')
const authPath = () => join(app.getPath('userData'), 'account.bin')
const curseForgeKeyPath = () => join(app.getPath('userData'), 'curseforge-key.bin')
let legacyDataMigration: Promise<void> | undefined

function migrateLegacyUserData(): Promise<void> {
  if (legacyDataMigration) return legacyDataMigration
  legacyDataMigration = (async () => {
    const userData = app.getPath('userData')
    const appData = app.getPath('appData')
    for (const legacyPath of [join(appData, 'minecraft-launcher'), join(appData, 'Minecraft Launcher')]) {
      if (legacyPath.toLowerCase() === userData.toLowerCase()) continue
      let entries: string[]
      try {
        entries = await readdir(legacyPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      await mkdir(userData, { recursive: true })
      for (const file of ['launcher-config.json', 'account.bin', 'curseforge-key.bin', 'mod-profiles.json']) {
        if (!entries.includes(file)) continue
        const destination = join(userData, file)
        try {
          await readFile(destination)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await copyFile(join(legacyPath, file), destination)
      }
    }
  })()
  return legacyDataMigration
}

export async function readConfig(): Promise<LauncherConfig> {
  await migrateLegacyUserData()
  try {
    const saved = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<LauncherConfig>
    const config = {
      ...defaultConfig(),
      ...saved,
      curseForgeApiKey: await readSecret(curseForgeKeyPath()),
    }
    if (!Number.isInteger(config.maxMemoryMb) || config.maxMemoryMb < 2048 || config.maxMemoryMb > 16384) {
      throw new Error('Die gespeicherte Minecraft-Arbeitsspeichereinstellung ist ungültig. Bitte korrigiere die Launcher-Einstellungen.')
    }
    return config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { ...defaultConfig(), curseForgeApiKey: await readSecret(curseForgeKeyPath()) }
  }
}

export async function saveConfig(config: SaveLauncherConfig): Promise<void> {
  if (!config || typeof config !== 'object'
    || typeof config.clientId !== 'string'
    || typeof config.gameDirectory !== 'string'
    || typeof config.javaPath !== 'string'
    || typeof config.maxMemoryMb !== 'number'
    || typeof config.updateFeedUrl !== 'string'
    || (config.curseForgeApiKey !== undefined && typeof config.curseForgeApiKey !== 'string')) {
    throw new Error('Ungültige Launcher-Einstellungen.')
  }
  const updateFeedUrl = config.updateFeedUrl.trim()
  if (updateFeedUrl) {
    const updateUrl = new URL(updateFeedUrl)
    if (updateUrl.protocol !== 'https:') {
      throw new Error('Der Update-Feed muss über HTTPS erreichbar sein.')
    }
    if (updateUrl.hostname === 'github.com' && updateUrl.pathname.split('/').filter(Boolean).length < 2) {
      throw new Error('Die GitHub-URL muss auf ein Repository zeigen, zum Beispiel https://github.com/OWNER/REPOSITORY.')
    }
  }
  const gameDirectory = config.gameDirectory.trim() || defaultConfig().gameDirectory
  if (!isAbsolute(gameDirectory)) throw new Error('Der Minecraft-Ordner muss ein absoluter Pfad sein.')
  if (!Number.isInteger(config.maxMemoryMb) || config.maxMemoryMb < 2048 || config.maxMemoryMb > 16384) {
    throw new Error('Der Minecraft-Arbeitsspeicher muss zwischen 2 und 16 GB liegen.')
  }
  const cleaned: LauncherConfig = {
    clientId: config.clientId.trim(),
    gameDirectory,
    javaPath: config.javaPath.trim() || 'java',
    maxMemoryMb: config.maxMemoryMb,
    updateFeedUrl,
    curseForgeApiKey: '',
  }
  if (config.curseForgeApiKey?.trim()) {
    await writeSecret(curseForgeKeyPath(), config.curseForgeApiKey.trim())
  }
  const path = configPath()
  await mkdir(app.getPath('userData'), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, JSON.stringify(cleaned, null, 2), 'utf8')
  await rename(temporaryPath, path)
}

async function readSecret(path: string): Promise<string> {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows-Datenschutzspeicher ist nicht verfügbar; CurseForge-Schlüssel kann nicht sicher geladen werden.')
    }
    return safeStorage.decryptString(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function writeSecret(path: string, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows-Datenschutzspeicher ist nicht verfügbar; CurseForge-Schlüssel wurde nicht gespeichert.')
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, safeStorage.encryptString(value))
  await rename(temporaryPath, path)
}

export async function readStoredAuth(): Promise<StoredAuth | undefined> {
  await migrateLegacyUserData()
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows-Datenschutzspeicher ist nicht verfügbar; das Konto kann nicht sicher geladen werden.')
    }
    const encrypted = await readFile(authPath())
    return JSON.parse(safeStorage.decryptString(encrypted)) as StoredAuth
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function saveStoredAuth(auth: StoredAuth): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows-Datenschutzspeicher ist nicht verfügbar; Anmeldung wurde nicht gespeichert.')
  }
  const path = authPath()
  await mkdir(app.getPath('userData'), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, safeStorage.encryptString(JSON.stringify(auth)))
  await rename(temporaryPath, path)
}

export async function clearStoredAuth(): Promise<void> {
  await rm(authPath(), { force: true })
}

export async function clearCurseForgeApiKey(): Promise<void> {
  await rm(curseForgeKeyPath(), { force: true })
}
