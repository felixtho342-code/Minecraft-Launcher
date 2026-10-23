import { app } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { access, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Version, launch } from '@xmcl/core'
import type { ResolvedVersion } from '@xmcl/core'
import { getVersionList, install } from '@xmcl/installer'
import type { WebContents } from 'electron'
import type { LauncherConfig, LauncherStatus } from './types'
import { getAuthenticatedMinecraftToken } from './auth'

let operationInProgress = false
let gameProcess: ChildProcess | undefined

function report(contents: WebContents, message: string, kind: LauncherStatus['kind'] = 'status', percent?: number) {
  if (!contents.isDestroyed()) contents.send('launcher:status', { kind, message, percent } satisfies LauncherStatus)
}

export async function listVersions() {
  const manifest = await getVersionList()
  const releases = manifest.versions.filter(version => version.type === 'release')
  return { latestRelease: manifest.latest.release, versions: releases }
}

export async function installGameVersion(versionId: string, config: LauncherConfig, contents: WebContents) {
  if (operationInProgress) throw new Error('Eine Installation läuft bereits.')
  if (gameProcess && gameProcess.exitCode === null) throw new Error('Beende zuerst das laufende Spiel, bevor du installierst.')
  operationInProgress = true
  try {
    report(contents, `Minecraft ${versionId}: Mojang-Version wird vorbereitet …`, 'progress')
    const { versions } = await listVersions()
    const versionInfo = versions.find(version => version.id === versionId)
    if (!versionInfo) throw new Error('Die ausgewählte Version wurde nicht in Mojangs Versionsliste gefunden.')
    await mkdir(config.gameDirectory, { recursive: true })
    report(contents, `Minecraft ${versionId}: Spiel, Bibliotheken und Assets werden geladen …`, 'progress')
    await install(versionInfo, config.gameDirectory, {
      assetsDownloadConcurrency: 8,
      librariesDownloadConcurrency: 8,
    })
    report(contents, `Minecraft ${versionId} ist installiert.`, 'status')
  } finally {
    operationInProgress = false
  }
}

export async function launchGame(versionId: string, config: LauncherConfig, contents: WebContents) {
  if (!/^[A-Za-z0-9._-]+$/.test(versionId)) throw new Error('Ungültige Minecraft-Version.')
  const resolvedVersion = await Version.parse(config.gameDirectory, versionId)
  const auth = await getAuthenticatedMinecraftToken(config.clientId)
  await launchMinecraftProcess(config.gameDirectory, resolvedVersion, config, auth.accessToken, auth.profile, contents, `Minecraft ${versionId}`)
}

export async function launchMinecraftProcess(
  gamePath: string,
  version: ResolvedVersion,
  config: LauncherConfig,
  accessToken: string,
  profile: { id: string; name: string },
  contents: WebContents,
  label: string,
): Promise<void> {
  if (operationInProgress) throw new Error('Bitte warte, bis die laufende Installation abgeschlossen ist.')
  if (gameProcess && gameProcess.exitCode === null) throw new Error('Minecraft läuft bereits.')
  report(contents, `${label} wird gestartet …`, 'status')
  const proc = await launch({
    gamePath,
    javaPath: config.javaPath || 'java',
    version,
    accessToken,
    gameProfile: profile,
    maxMemory: config.maxMemoryMb,
    minMemory: 1024,
    launcherName: 'PrismClient',
    launcherBrand: 'PrismClient',
  })
  gameProcess = proc
  proc.once('spawn', () => report(contents, 'Minecraft läuft.', 'status'))
  proc.once('error', error => {
    if (gameProcess === proc) gameProcess = undefined
    report(contents, `Minecraft konnte nicht gestartet werden: ${error.message}`, 'error')
  })
  proc.once('exit', code => {
    if (gameProcess === proc) gameProcess = undefined
    report(contents, `Minecraft wurde beendet${code === null ? '.' : ` (Code ${code}).`}`, 'game-exit')
  })
}

export async function scanInstalledVersions(gameDirectory: string): Promise<string[]> {
  try {
    const directory = join(gameDirectory, 'versions')
    const entries = await readdir(directory, { withFileTypes: true })
    const installed: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue
      const base = join(directory, entry.name)
      try {
        await Promise.all([
          access(join(base, `${entry.name}.json`)),
          access(join(base, `${entry.name}.jar`)),
        ])
        installed.push(entry.name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return installed.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function defaultGameDirectory(): string {
  return join(app.getPath('appData'), '.minecraft')
}
