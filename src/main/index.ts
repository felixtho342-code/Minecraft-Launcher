import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { clearCurseForgeApiKey, readConfig, saveConfig } from './config'
import { cancelSignIn, getAccount, signIn, signOut } from './auth'
import { defaultGameDirectory, installGameVersion, launchGame, listVersions, scanInstalledVersions } from './game'
import {
  createModProfile,
  deleteModProfile,
  installMod,
  launchModProfile,
  listModProfiles,
  removeProfileMod,
  searchMods,
} from './mods'
import type { LauncherConfig, PublicLauncherConfig, SaveLauncherConfig } from './types'

let mainWindow: BrowserWindow | undefined
let updateCheckInProgress = false
let updaterConfigured = false

function sendUpdateStatus(message: string, percent?: number, updateAction?: 'check' | 'restart') {
  mainWindow?.webContents.send('launcher:status', { kind: 'update', message, percent, updateAction })
}

function configureUpdater(feedUrl: string) {
  updaterConfigured = false
  if (!app.isPackaged) return false
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  if (feedUrl) {
    const url = new URL(feedUrl)
    if (url.hostname === 'github.com') {
      const [owner, repo] = url.pathname.split('/').filter(Boolean)
      if (!owner || !repo) throw new Error('Die GitHub-Update-URL muss ein Repository angeben.')
      autoUpdater.setFeedURL({ provider: 'github', owner, repo: repo.replace(/\.git$/, '') })
    } else {
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
    }
  } else if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) {
    return false
  }
  updaterConfigured = true
  return true
}

async function checkForLauncherUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) throw new Error('Die Update-Prüfung ist nur in der installierten App verfügbar.')
    return
  }
  if (!updaterConfigured) {
    const error = new Error('Für diese Installation ist kein Update-Feed konfiguriert. Trage eine GitHub-Repository-URL oder einen HTTPS-Feed in den Einstellungen ein.')
    sendUpdateStatus(error.message, undefined, 'check')
    if (manual) throw error
    return
  }
  if (updateCheckInProgress) {
    if (manual) sendUpdateStatus('Die Update-Prüfung läuft bereits.')
    return
  }
  updateCheckInProgress = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    sendUpdateStatus(`Updateprüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`, undefined, 'check')
    if (manual) throw error
  } finally {
    updateCheckInProgress = false
  }
}

function toPublicConfig(config: LauncherConfig): PublicLauncherConfig {
  const { curseForgeApiKey, ...publicConfig } = config
  return { ...publicConfig, hasCurseForgeApiKey: Boolean(curseForgeApiKey) }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0b0b12',
    title: 'PrismClient',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.setMenuBarVisibility(false)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  mainWindow.on('closed', () => { mainWindow = undefined })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('Suche nach Updates …'))
  autoUpdater.on('update-available', info => {
    sendUpdateStatus(`Version ${info.version} verfügbar. Download wird gestartet …`)
  })
  autoUpdater.on('update-not-available', () => sendUpdateStatus(`Launcher ${app.getVersion()} ist aktuell.`))
  autoUpdater.on('download-progress', progress => {
    sendUpdateStatus(`Update wird geladen: ${Math.round(progress.percent)} %`, progress.percent)
  })
  autoUpdater.on('update-downloaded', info => {
    sendUpdateStatus(`Version ${info.version} ist bereit. Jetzt neu starten und Update installieren.`, 100, 'restart')
  })
  autoUpdater.on('error', error => sendUpdateStatus(`Update fehlgeschlagen: ${error.message}`, undefined, 'check'))

  ipcMain.handle('launcher:initial-data', async () => {
    const config = await readConfig()
    if (configureUpdater(config.updateFeedUrl)) {
      setTimeout(() => void checkForLauncherUpdates(), 1500)
    }
    return {
      config: toPublicConfig(config),
      account: await getAccount(),
      gameDirectory: config.gameDirectory || defaultGameDirectory(),
      installedVersions: await scanInstalledVersions(config.gameDirectory),
      modProfiles: await listModProfiles(),
    }
  })
  ipcMain.handle('launcher:save-config', async (_event, config: SaveLauncherConfig) => {
    await saveConfig(config)
    const saved = await readConfig()
    const hasUpdateFeed = configureUpdater(saved.updateFeedUrl)
    if (hasUpdateFeed) void checkForLauncherUpdates()
    return toPublicConfig(saved)
  })
  ipcMain.handle('launcher:clear-curseforge-key', async () => clearCurseForgeApiKey())
  ipcMain.handle('launcher:choose-java', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Java-Programm auswählen',
      properties: ['openFile'],
      filters: [{ name: 'Java', extensions: ['exe'] }],
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  ipcMain.handle('launcher:choose-game-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Minecraft-Ordner auswählen',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  ipcMain.handle('launcher:sign-in', async (event) => signIn((await readConfig()).clientId, event.sender))
  ipcMain.handle('launcher:cancel-sign-in', async (event) => cancelSignIn(event.sender))
  ipcMain.handle('launcher:sign-out', async () => signOut())
  ipcMain.handle('launcher:versions', async () => listVersions())
  ipcMain.handle('launcher:installed-versions', async () => scanInstalledVersions((await readConfig()).gameDirectory))
  ipcMain.handle('launcher:install', async (event, version: string) => {
    await installGameVersion(version, await readConfig(), event.sender)
  })
  ipcMain.handle('launcher:launch', async (event, version: string) => {
    await launchGame(version, await readConfig(), event.sender)
  })
  ipcMain.handle('launcher:mod-profiles', async () => listModProfiles())
  ipcMain.handle('launcher:create-mod-profile', async (event, request) => {
    return createModProfile(request, await readConfig(), event.sender)
  })
  ipcMain.handle('launcher:delete-mod-profile', async (_event, profileId: string) => deleteModProfile(profileId))
  ipcMain.handle('launcher:search-mods', async (_event, provider: 'modrinth' | 'curseforge', query: string, profileId: string) => {
    const config = await readConfig()
    return searchMods(provider, query, profileId, config.curseForgeApiKey)
  })
  ipcMain.handle('launcher:install-mod', async (event, provider: 'modrinth' | 'curseforge', projectId: string, profileId: string) => {
    const config = await readConfig()
    return installMod(provider, projectId, profileId, config.curseForgeApiKey, event.sender)
  })
  ipcMain.handle('launcher:remove-mod', async (_event, profileId: string, fileName: string) => {
    return removeProfileMod(profileId, fileName)
  })
  ipcMain.handle('launcher:launch-mod-profile', async (event, profileId: string) => {
    await launchModProfile(profileId, await readConfig(), event.sender)
  })
  ipcMain.handle('launcher:check-updates', async () => {
    const config = await readConfig()
    if (!configureUpdater(config.updateFeedUrl)) {
      throw new Error('Für diese Installation ist kein Update-Feed konfiguriert. Trage eine GitHub-Repository-URL oder einen HTTPS-Feed in den Einstellungen ein.')
    }
    await checkForLauncherUpdates(true)
  })
  ipcMain.handle('launcher:install-update', async () => {
    if (!app.isPackaged) throw new Error('Updates können nur in der installierten App installiert werden.')
    autoUpdater.quitAndInstall(false, true)
  })
  ipcMain.handle('launcher:open-folder', async (_event, folder: unknown) => {
    if (folder !== 'root' && folder !== 'screenshots' && folder !== 'saves') {
      throw new Error('Ungültiger Ordner.')
    }
    const gameDirectory = (await readConfig()).gameDirectory
    const path = folder === 'screenshots' ? join(gameDirectory, 'screenshots')
      : folder === 'saves' ? join(gameDirectory, 'saves') : gameDirectory
    if (folder !== 'root') {
      await mkdir(path, { recursive: true })
    }
    const error = await shell.openPath(path)
    if (error) throw new Error(`Ordner konnte nicht geöffnet werden: ${error}`)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch(error => {
  dialog.showErrorBox('PrismClient konnte nicht gestartet werden', error instanceof Error ? error.message : String(error))
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
