import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Version } from '@xmcl/core'
import {
  getLoaderArtifactListFor,
  getForgeVersionList,
  getVersionList,
  install,
  installDependencies,
  installFabric,
  installForge,
} from '@xmcl/installer'
import type { WebContents } from 'electron'
import type {
  CreateProfileRequest,
  InstalledMod,
  LauncherConfig,
  ModProfile,
  ModProvider,
  ModSearchResult,
} from './types'
import { launchMinecraftProcess } from './game'
import { getAuthenticatedMinecraftToken } from './auth'

const modrinthApi = 'https://api.modrinth.com/v2'
const curseForgeApi = 'https://api.curseforge.com/v1'
const modrinthUserAgent = 'PrismClient/1.0.4 (Windows desktop application)'
const profilesPath = () => join(app.getPath('userData'), 'mod-profiles.json')
let modOperationInProgress = false

interface ModrinthFile {
  filename: string
  url: string
  primary: boolean
  hashes: { sha1?: string; sha512?: string }
}

interface ModrinthVersion {
  id: string
  name: string
  files: ModrinthFile[]
  dependencies: Array<{
    version_id?: string
    project_id?: string
    dependency_type: string
  }>
}

interface CurseForgeModFile {
  id: number
  fileName: string
  downloadUrl: string | null
  dependencies: Array<{ modId: number; relationType: number }>
  hashes?: Array<{ value: string; algo: number }>
}

interface CurseForgeMod {
  id: number
  name: string
  slug: string
  summary: string
  downloadCount: number
  logo?: { url?: string }
  latestFilesIndexes?: Array<{ fileId: number; gameVersion: string; modLoader: number }>
}

function report(contents: WebContents, message: string) {
  if (!contents.isDestroyed()) contents.send('launcher:status', { kind: 'progress', message })
}

async function jsonResponse<T>(response: Response, service: string): Promise<T> {
  const text = await response.text()
  let payload: T & { error?: string; message?: string }
  try {
    payload = JSON.parse(text) as T & { error?: string; message?: string }
  } catch {
    throw new Error(`${service} lieferte eine ungültige Antwort (HTTP ${response.status}).`)
  }
  if (!response.ok) {
    throw new Error(`${service}: ${payload.message ?? payload.error ?? response.statusText} (HTTP ${response.status})`)
  }
  return payload
}

function safeName(value: string): string {
  const filename = basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  if (!filename || filename === '.' || filename === '..') throw new Error('Der Mod-Anbieter lieferte einen ungültigen Dateinamen.')
  return filename.endsWith('.jar') ? filename : `${filename}.jar`
}

function modFilePath(profile: ModProfile, fileName: string): string {
  const safeFileName = safeName(fileName)
  return join(profile.directory, 'mods', safeFileName)
}

function uniqueModFileName(provider: ModProvider, projectId: string, fileName: string): string {
  const clean = safeName(fileName)
  return `${provider}-${projectId}-${clean}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
}

function allowedDownloadUrl(rawUrl: string, provider: ModProvider): URL {
  const url = new URL(rawUrl)
  const validHost = provider === 'modrinth'
    ? url.hostname === 'modrinth.com' || url.hostname.endsWith('.modrinth.com')
    : url.hostname === 'curseforge.com' || url.hostname.endsWith('.curseforge.com')
      || url.hostname.endsWith('.forgecdn.net')
  if (url.protocol !== 'https:' || !validHost) {
    throw new Error(`Der Mod-Anbieter lieferte eine nicht erlaubte Download-Adresse: ${url.hostname}`)
  }
  return url
}

async function downloadModFile(
  url: string,
  provider: ModProvider,
  expectedHashes: Record<string, string | undefined>,
  destination: string,
): Promise<void> {
  const response = await fetch(allowedDownloadUrl(url, provider), { redirect: 'follow' })
  if (!response.ok) throw new Error(`Mod-Download fehlgeschlagen (HTTP ${response.status}).`)
  allowedDownloadUrl(response.url, provider)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  const maxDownloadSize = 300 * 1024 * 1024
  if (contentLength > maxDownloadSize) throw new Error('Die Mod-Datei überschreitet das Größenlimit von 300 MB.')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > maxDownloadSize) throw new Error('Die Mod-Datei überschreitet das Größenlimit von 300 MB.')

  for (const algorithm of ['sha512', 'sha1', 'md5'] as const) {
    const expected = expectedHashes[algorithm]
    if (expected && createHash(algorithm).update(bytes).digest('hex').toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Die Prüfsumme der Mod-Datei stimmt nicht (${algorithm}).`)
    }
  }

  await mkdir(join(destination, '..'), { recursive: true })
  const temporaryPath = `${destination}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, bytes, { flag: 'wx' })
  await rename(temporaryPath, destination)
}

async function readProfiles(): Promise<ModProfile[]> {
  try {
    const profiles = JSON.parse(await readFile(profilesPath(), 'utf8')) as ModProfile[]
    if (!Array.isArray(profiles)) throw new Error('Die Profildatei enthält kein gültiges Profil-Array.')
    return profiles
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeProfiles(profiles: ModProfile[]): Promise<void> {
  const path = profilesPath()
  await mkdir(app.getPath('userData'), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, JSON.stringify(profiles, null, 2), 'utf8')
  await rename(temporaryPath, path)
}

export async function listModProfiles(): Promise<ModProfile[]> {
  const profiles = await readProfiles()
  return Promise.all(profiles.map(async profile => {
    const modsDirectory = join(profile.directory, 'mods')
    try {
      const files = await readdir(modsDirectory)
      const installed = new Set(files.filter(file => file.toLowerCase().endsWith('.jar')))
      return { ...profile, mods: profile.mods.filter(mod => installed.has(mod.fileName)) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...profile, mods: [] }
      throw error
    }
  }))
}

async function getProfile(profileId: string): Promise<ModProfile> {
  if (!/^[a-f0-9-]{36}$/i.test(profileId)) throw new Error('Ungültige Mod-Profil-ID.')
  const profile = (await readProfiles()).find(item => item.id === profileId)
  if (!profile) throw new Error('Das Mod-Profil wurde nicht gefunden.')
  if (!isAbsolute(profile.directory)
    || basename(profile.directory) !== profile.id
    || basename(dirname(profile.directory)) !== 'launcher-instances') {
    throw new Error('Der Profilordner ist ungültig; aus Sicherheitsgründen wurde der Vorgang abgebrochen.')
  }
  return profile
}

export async function createModProfile(
  request: CreateProfileRequest,
  config: LauncherConfig,
  contents: WebContents,
): Promise<ModProfile> {
  if (modOperationInProgress) throw new Error('Ein Mod-Vorgang läuft bereits.')
  if (!request || typeof request.name !== 'string' || !['fabric', 'forge'].includes(request.loader)) {
    throw new Error('Ungültige Mod-Profil-Einstellungen.')
  }
  const name = request.name.trim()
  if (name.length < 1 || name.length > 40) throw new Error('Der Profilname muss zwischen 1 und 40 Zeichen lang sein.')
  const { versions, latest } = await getVersionList()
  const minecraftVersion = request.minecraftVersion || latest.release
  const version = versions.find(item => item.id === minecraftVersion && item.type === 'release')
  if (!version) throw new Error('Die ausgewählte Minecraft-Version ist keine verfügbare Release-Version.')

  modOperationInProgress = true
  const id = randomUUID()
  const directory = join(config.gameDirectory, 'launcher-instances', id)
  try {
    await mkdir(directory, { recursive: true })
    report(contents, `Minecraft ${minecraftVersion} für „${name}“ wird installiert …`)
    await install(version, directory, { assetsDownloadConcurrency: 8, librariesDownloadConcurrency: 8 })

    let loaderVersion: string
    let gameVersionId: string
    if (request.loader === 'fabric') {
      report(contents, 'Fabric-Loader wird installiert …')
      const loaders = await getLoaderArtifactListFor(minecraftVersion)
      const selected = loaders.find(item => item.loader.stable) ?? loaders[0]
      if (!selected) throw new Error(`Für Minecraft ${minecraftVersion} wurde keine Fabric-Version gefunden.`)
      loaderVersion = selected.loader.version
      gameVersionId = await installFabric(selected, directory, { side: 'client' })
    } else {
      report(contents, 'Forge-Loader wird installiert …')
      const forge = await getForgeVersionList({ minecraft: minecraftVersion })
      const selected = forge.versions.find(item => item.type === 'recommended')
        ?? forge.versions.find(item => item.type === 'latest')
        ?? forge.versions[0]
      if (!selected) throw new Error(`Für Minecraft ${minecraftVersion} wurde keine Forge-Version gefunden.`)
      loaderVersion = selected.version
      gameVersionId = await installForge({
        mcversion: minecraftVersion,
        version: selected.version,
        installer: selected.installer,
      }, directory, { java: config.javaPath || 'java', side: 'client' })
    }

    const resolved = await Version.parse(directory, gameVersionId)
    await installDependencies(resolved, { assetsDownloadConcurrency: 8, librariesDownloadConcurrency: 8 })
    const profile: ModProfile = {
      id,
      name,
      minecraftVersion,
      loader: request.loader,
      loaderVersion,
      gameVersionId,
      directory,
      mods: [],
    }
    await writeProfiles([...(await readProfiles()), profile])
    return profile
  } finally {
    modOperationInProgress = false
  }
}

async function searchModrinth(query: string, profile: ModProfile): Promise<ModSearchResult[]> {
  const params = new URLSearchParams({
    query,
    facets: JSON.stringify([
      ['project_type:mod'],
      [`versions:${profile.minecraftVersion}`],
      [`categories:${profile.loader}`],
    ]),
    limit: '20',
    index: 'downloads',
  })
  const response = await fetch(`${modrinthApi}/search?${params}`, {
    headers: { 'User-Agent': modrinthUserAgent },
  })
  const result = await jsonResponse<{ hits: Array<{
    project_id: string
    slug: string
    title: string
    description: string
    downloads: number
    icon_url?: string
    latest_version?: string
  }> }>(response, 'Modrinth')
  return result.hits.map(hit => ({
    provider: 'modrinth',
    id: hit.project_id,
    title: hit.title,
    description: hit.description,
    downloads: hit.downloads,
    iconUrl: hit.icon_url,
    projectUrl: `https://modrinth.com/mod/${hit.slug}`,
    latestVersion: hit.latest_version,
  }))
}

async function searchCurseForge(query: string, profile: ModProfile, apiKey: string): Promise<ModSearchResult[]> {
  if (!apiKey) throw new Error('Für CurseForge ist ein persönlicher API-Schlüssel nötig. Hinterlege ihn in den Einstellungen.')
  const modLoaderType = profile.loader === 'fabric' ? 4 : 1
  const params = new URLSearchParams({
    gameId: '432',
    classId: '6',
    searchFilter: query,
    gameVersion: profile.minecraftVersion,
    modLoaderType: String(modLoaderType),
    pageSize: '20',
    sortField: '2',
    sortOrder: 'desc',
  })
  const result = await jsonResponse<{ data: CurseForgeMod[] }>(await fetch(`${curseForgeApi}/mods/search?${params}`, {
    headers: { 'x-api-key': apiKey },
  }), 'CurseForge')
  return result.data.map(mod => ({
    provider: 'curseforge',
    id: String(mod.id),
    title: mod.name,
    description: mod.summary,
    downloads: mod.downloadCount,
    iconUrl: mod.logo?.url,
    projectUrl: `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`,
    latestVersion: mod.latestFilesIndexes?.find(file => file.modLoader === modLoaderType && file.gameVersion === profile.minecraftVersion)
      ? 'Kompatible Version verfügbar'
      : undefined,
  }))
}

export async function searchMods(
  provider: ModProvider,
  query: string,
  profileId: string,
  apiKey: string,
): Promise<ModSearchResult[]> {
  const profile = await getProfile(profileId)
  const search = query.trim()
  if (search.length < 2 || search.length > 100) throw new Error('Die Suche muss zwischen 2 und 100 Zeichen lang sein.')
  if (provider === 'modrinth') return searchModrinth(search, profile)
  if (provider === 'curseforge') return searchCurseForge(search, profile, apiKey)
  throw new Error('Unbekannter Mod-Anbieter.')
}

async function modrinthVersions(profile: ModProfile, projectId: string): Promise<ModrinthVersion[]> {
  const params = new URLSearchParams({
    game_versions: JSON.stringify([profile.minecraftVersion]),
    loaders: JSON.stringify([profile.loader]),
  })
  return jsonResponse<ModrinthVersion[]>(await fetch(`${modrinthApi}/project/${encodeURIComponent(projectId)}/version?${params}`, {
    headers: { 'User-Agent': modrinthUserAgent },
  }), 'Modrinth')
}

async function installModrinthProject(
  profile: ModProfile,
  projectId: string,
  exactVersionId: string | undefined,
  visited: Set<string>,
  installed: InstalledMod[],
  contents: WebContents,
): Promise<void> {
  if (visited.has(projectId)) return
  visited.add(projectId)
  const existing = profile.mods.find(mod => mod.provider === 'modrinth' && mod.projectId === projectId)
  if (existing) {
    try {
      await access(modFilePath(profile, existing.fileName))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const version = exactVersionId
    ? await jsonResponse<ModrinthVersion>(
      await fetch(`${modrinthApi}/version/${encodeURIComponent(exactVersionId)}`, {
        headers: { 'User-Agent': modrinthUserAgent },
      }),
      'Modrinth',
    )
    : (await modrinthVersions(profile, projectId))[0]
  if (!version) throw new Error(`Für Mod ${projectId} gibt es keine Version für ${profile.minecraftVersion} (${profile.loader}).`)
  for (const dependency of version.dependencies.filter(item => item.dependency_type === 'required')) {
    if (dependency.project_id) {
      await installModrinthProject(profile, dependency.project_id, dependency.version_id, visited, installed, contents)
    } else if (dependency.version_id) {
      const dependencyVersion = await jsonResponse<ModrinthVersion>(
        await fetch(`${modrinthApi}/version/${encodeURIComponent(dependency.version_id)}`, {
          headers: { 'User-Agent': modrinthUserAgent },
        }),
        'Modrinth',
      )
      const dependencyProject = (dependencyVersion as ModrinthVersion & { project_id?: string }).project_id
      if (dependencyProject) {
        await installModrinthProject(profile, dependencyProject, dependency.version_id, visited, installed, contents)
      }
    }
  }
  const file = version.files.find(item => item.primary) ?? version.files[0]
  if (!file) throw new Error(`Modrinth-Version „${version.name}“ enthält keine Datei.`)
  const fileName = uniqueModFileName('modrinth', projectId, file.filename)
  const destination = modFilePath(profile, fileName)
  report(contents, `Lade ${version.name} von Modrinth …`)
  await downloadModFile(file.url, 'modrinth', file.hashes, destination)
  installed.push({ provider: 'modrinth', projectId, title: version.name, fileName })
}

async function curseForgeModFile(
  modId: number,
  profile: ModProfile,
  apiKey: string,
): Promise<CurseForgeModFile> {
  const modLoaderType = profile.loader === 'fabric' ? 4 : 1
  const params = new URLSearchParams({
    gameVersion: profile.minecraftVersion,
    modLoaderType: String(modLoaderType),
    pageSize: '50',
    index: '0',
    sortField: '3',
    sortOrder: 'desc',
  })
  const result = await jsonResponse<{ data: CurseForgeModFile[] }>(await fetch(
    `${curseForgeApi}/mods/${modId}/files?${params}`,
    { headers: { 'x-api-key': apiKey } },
  ), 'CurseForge')
  const file = result.data[0]
  if (!file) throw new Error(`Für CurseForge-Mod ${modId} gibt es keine Datei für ${profile.minecraftVersion} (${profile.loader}).`)
  if (!file.downloadUrl) {
    const detail = await jsonResponse<{ data: CurseForgeModFile }>(await fetch(
      `${curseForgeApi}/mods/${modId}/files/${file.id}`,
      { headers: { 'x-api-key': apiKey } },
    ), 'CurseForge')
    return detail.data
  }
  return file
}

async function installCurseForgeProject(
  profile: ModProfile,
  modId: number,
  apiKey: string,
  visited: Set<number>,
  installed: InstalledMod[],
  contents: WebContents,
): Promise<void> {
  if (visited.has(modId)) return
  visited.add(modId)
  const existing = profile.mods.find(mod => mod.provider === 'curseforge' && mod.projectId === String(modId))
  if (existing) {
    try {
      await access(modFilePath(profile, existing.fileName))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const file = await curseForgeModFile(modId, profile, apiKey)
  if (!file.downloadUrl) throw new Error(`CurseForge hat keinen Download-Link für ${file.fileName} bereitgestellt.`)
  for (const dependency of file.dependencies.filter(item => item.relationType === 3)) {
    await installCurseForgeProject(profile, dependency.modId, apiKey, visited, installed, contents)
  }
  const fileName = uniqueModFileName('curseforge', String(modId), file.fileName)
  const destination = modFilePath(profile, fileName)
  report(contents, `Lade ${file.fileName} von CurseForge …`)
  const hashes = Object.fromEntries((file.hashes ?? [])
    .filter(hash => hash.algo === 1 || hash.algo === 2)
    .map(hash => [hash.algo === 1 ? 'sha1' : 'md5', hash.value]))
  await downloadModFile(file.downloadUrl, 'curseforge', hashes, destination)
  installed.push({ provider: 'curseforge', projectId: String(modId), title: file.fileName, fileName })
}

export async function installMod(
  provider: ModProvider,
  projectId: string,
  profileId: string,
  apiKey: string,
  contents: WebContents,
): Promise<ModProfile> {
  if (modOperationInProgress) throw new Error('Ein Mod-Vorgang läuft bereits.')
  const profile = await getProfile(profileId)
  modOperationInProgress = true
  const newlyInstalled: InstalledMod[] = []
  try {
    if (provider === 'modrinth') {
      if (!/^[A-Za-z0-9]{5,12}$/.test(projectId)) throw new Error('Ungültige Modrinth-Projekt-ID.')
      await installModrinthProject(profile, projectId, undefined, new Set(), newlyInstalled, contents)
    } else if (provider === 'curseforge') {
      if (!apiKey) throw new Error('Für CurseForge ist ein API-Schlüssel nötig.')
      const id = Number(projectId)
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('Ungültige CurseForge-Projekt-ID.')
      await installCurseForgeProject(profile, id, apiKey, new Set(), newlyInstalled, contents)
    } else {
      throw new Error('Unbekannter Mod-Anbieter.')
    }
    const profiles = await readProfiles()
    const updated = profiles.map(item => item.id === profile.id
      ? { ...item, mods: [...item.mods.filter(existing => !newlyInstalled.some(mod => mod.fileName === existing.fileName)), ...newlyInstalled] }
      : item)
    await writeProfiles(updated)
    report(contents, `${newlyInstalled.length} Mod-Datei(en) wurden installiert.`)
    return updated.find(item => item.id === profile.id)!
  } catch (error) {
    await Promise.all(newlyInstalled.map(mod => rm(modFilePath(profile, mod.fileName), { force: true })))
    throw error
  } finally {
    modOperationInProgress = false
  }
}

export async function removeProfileMod(profileId: string, fileName: string): Promise<ModProfile> {
  if (modOperationInProgress) throw new Error('Ein Mod-Vorgang läuft bereits.')
  const profile = await getProfile(profileId)
  const mod = profile.mods.find(item => item.fileName === fileName)
  if (!mod) throw new Error('Die Mod-Datei wurde nicht in diesem Profil gefunden.')
  const path = modFilePath(profile, mod.fileName)
  await access(path)
  await rm(path)
  const profiles = await readProfiles()
  const updated = profiles.map(item => item.id === profile.id
    ? { ...item, mods: item.mods.filter(existing => existing.fileName !== fileName) }
    : item)
  await writeProfiles(updated)
  return updated.find(item => item.id === profile.id)!
}

export async function launchModProfile(profileId: string, config: LauncherConfig, contents: WebContents): Promise<void> {
  if (modOperationInProgress) throw new Error('Warte, bis die Mod-Installation abgeschlossen ist.')
  const profile = await getProfile(profileId)
  const resolved = await Version.parse(profile.directory, profile.gameVersionId)
  const auth = await getAuthenticatedMinecraftToken(config.clientId)
  await launchMinecraftProcess(profile.directory, resolved, config, auth.accessToken, auth.profile, contents, `Mod-Profil „${profile.name}“`)
}

export async function deleteModProfile(profileId: string): Promise<void> {
  if (modOperationInProgress) throw new Error('Ein Mod-Vorgang läuft bereits.')
  const profile = await getProfile(profileId)
  await rm(profile.directory, { recursive: true, force: true })
  await writeProfiles((await readProfiles()).filter(item => item.id !== profile.id))
}
