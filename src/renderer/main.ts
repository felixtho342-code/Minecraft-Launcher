import './style.css'
import type {
  AccountProfile,
  GameVersion,
  ModProfile,
  ModProvider,
  ModSearchResult,
  PublicLauncherConfig,
  SaveLauncherConfig,
  LauncherStatus,
} from '../main/types'

const $ = <T extends HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`UI-Element fehlt: ${selector}`)
  return element
}

const state: {
  config?: PublicLauncherConfig
  account?: AccountProfile
  versions: GameVersion[]
  installed: Set<string>
  modProfiles: ModProfile[]
  activeModProfileId?: string
  modSearchResults: ModSearchResult[]
  toastTimer?: number
} = { versions: [], installed: new Set(), modProfiles: [], modSearchResults: [] }

function notify(message: string, isError = false) {
  const toast = $('#toast')
  toast.textContent = message
  toast.classList.toggle('error', isError)
  toast.classList.add('visible')
  window.clearTimeout(state.toastTimer)
  state.toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 5200)
}

function selectedVersion() {
  return ($('#version-select') as HTMLSelectElement).value
}

function updateVersionControls() {
  const version = selectedVersion()
  const installed = state.installed.has(version)
  $('#version-state').textContent = installed ? 'Installiert und bereit' : 'Noch nicht installiert'
  $('#version-dot').classList.toggle('ready', installed)
  const playButton = $('#play-button') as HTMLButtonElement
  const installButton = $('#install-button') as HTMLButtonElement
  playButton.disabled = !state.account || !installed
  installButton.textContent = installed ? 'REPARIEREN' : 'INSTALLIEREN'
}

function setAccount(account?: AccountProfile) {
  state.account = account
  $('#account-name').textContent = account?.name ?? 'Nicht angemeldet'
  $('#player-name').textContent = account?.name ?? 'GAST'
  const skin = $('#player-skin') as HTMLImageElement
  const placeholder = $('#skin-placeholder')
  const uuid = account?.id.replace(/-/g, '')
  if (uuid && /^[0-9a-f]{32}$/i.test(uuid)) {
    skin.src = `https://crafatar.com/renders/body/${uuid}?overlay&scale=8`
    skin.hidden = false
    placeholder.toggleAttribute('hidden', true)
  } else {
    skin.removeAttribute('src')
    skin.hidden = true
    placeholder.toggleAttribute('hidden', false)
  }
  const button = $('#account-button')
  button.textContent = account ? 'Abmelden' : 'Microsoft-Konto verbinden'
  button.classList.toggle('connected', Boolean(account))
  updateVersionControls()
}

function renderVersions(versions: GameVersion[], selected?: string) {
  state.versions = versions
  const select = $('#version-select') as HTMLSelectElement
  select.replaceChildren(...versions.map(version => {
    const option = document.createElement('option')
    option.value = version.id
    option.textContent = `${version.id}${version.id === selected ? ' · NEUSTE' : ''}`
    return option
  }))
  if (selected && versions.some(version => version.id === selected)) select.value = selected
  updateVersionControls()
}

function setStatus(status: LauncherStatus) {
  if (status.kind === 'auth-device-code') {
    $('#auth-dialog').toggleAttribute('hidden', false)
    $('#device-code').textContent = status.authCode ?? '------'
    $('#verification-address').textContent = status.verificationUri ?? 'Microsoft-Anmeldeseite'
    $('#auth-instructions').textContent = status.message
    $('#auth-progress-message').textContent = 'Warte auf deine Bestätigung im Browser …'
    return
  }
  if (status.kind === 'auth-progress') {
    $('#auth-dialog').toggleAttribute('hidden', false)
    $('#auth-progress-message').textContent = status.message
    return
  }
  if (status.kind === 'update') {
    const banner = $('#update-banner')
    banner.toggleAttribute('hidden', false)
    $('#update-banner-message').textContent = status.message
    const progress = $('#update-progress-bar') as HTMLElement
    progress.style.width = `${Math.max(0, Math.min(100, status.percent ?? 0))}%`
    progress.classList.toggle('active', status.percent !== undefined && status.percent > 0 && status.percent < 100)
    $('#install-update-button').toggleAttribute('hidden', status.updateAction !== 'restart')
    return
  }
  $('#status-message').textContent = status.message
  $('#progress-wrap').toggleAttribute('hidden', false)
  $('#progress-bar').classList.toggle('indeterminate', status.kind === 'progress')
  if (status.percent !== undefined) {
    ($('#progress-bar') as HTMLElement).style.width = `${Math.max(0, Math.min(100, status.percent))}%`
    $('#progress-value').textContent = `${Math.round(status.percent)} %`
  } else {
    $('#progress-value').textContent = ''
  }
  if (status.kind === 'error') notify(status.message, true)
  if (status.kind === 'game-exit') void refreshInstalled()
}

async function refreshInstalled() {
  state.installed = new Set(await window.launcher.installedVersions())
  updateVersionControls()
}

function showView(view: 'play' | 'mods' | 'settings') {
  $('#play-view').toggleAttribute('hidden', view !== 'play')
  $('#mods-view').toggleAttribute('hidden', view !== 'mods')
  $('#settings-view').toggleAttribute('hidden', view !== 'settings')
  $('#crumb').textContent = view === 'play' ? 'SPIELEN' : view === 'mods' ? 'MODS' : 'EINSTELLUNGEN'
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach(button => {
    button.classList.toggle('active', button.dataset.view === view)
  })
}

function fillSettings(config: PublicLauncherConfig) {
  const clientId = $('#client-id') as HTMLInputElement
  const gameDirectory = $('#game-directory') as HTMLInputElement
  const javaPath = $('#java-path') as HTMLInputElement
  const maxMemory = $('#max-memory') as HTMLSelectElement
  const updateFeed = $('#update-feed') as HTMLInputElement
  clientId.value = config.clientId
  gameDirectory.value = config.gameDirectory
  javaPath.value = config.javaPath
  maxMemory.value = String(config.maxMemoryMb)
  updateFeed.value = config.updateFeedUrl
  $('#game-directory-label').textContent = config.gameDirectory
  $('#curseforge-key-state').textContent = config.hasCurseForgeApiKey
    ? 'Ein Schlüssel ist verschlüsselt gespeichert. Leer lassen, um ihn beizubehalten.'
    : 'Der Schlüssel wird lokal mit Windows-Datenschutzspeicher verschlüsselt und nie an die Oberfläche zurückgegeben.'
  $('#clear-curseforge-key').toggleAttribute('hidden', !config.hasCurseForgeApiKey)
}

function setActiveModProfile(profileId: string) {
  state.activeModProfileId = profileId
  if (profileId) localStorage.setItem('activeModProfileId', profileId)
  const profile = state.modProfiles.find(item => item.id === profileId)
  const card = $('#active-profile-card')
  card.toggleAttribute('hidden', !profile)
  const select = $('#profile-select') as HTMLSelectElement
  if (profile) {
    select.value = profile.id
    $('#active-profile-name').textContent = profile.name
    $('#active-profile-info').textContent = `Minecraft ${profile.minecraftVersion} · ${profile.loader} ${profile.loaderVersion}`
    $('#installed-count').textContent = String(profile.mods.length)
    renderInstalledMods(profile)
  } else {
    $('#installed-count').textContent = '0'
    $('#installed-mods').replaceChildren()
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = 'Wähle oder erstelle ein Profil.'
    $('#installed-mods').append(empty)
  }
  renderSearchResults()
}

function renderInstalledMods(profile: ModProfile) {
  const container = $('#installed-mods')
  container.replaceChildren()
  if (!profile.mods.length) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = 'In diesem Profil sind noch keine Mods installiert.'
    container.append(empty)
    return
  }
  for (const mod of profile.mods) {
    const row = document.createElement('div')
    row.className = 'installed-mod-row'
    const details = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = mod.title
    const meta = document.createElement('small')
    meta.textContent = `${mod.provider === 'modrinth' ? 'Modrinth' : 'CurseForge'} · ${mod.fileName}`
    details.append(title, meta)
    const remove = document.createElement('button')
    remove.className = 'danger-button'
    remove.textContent = 'ENTFERNEN'
    remove.addEventListener('click', async () => {
      try {
        await window.launcher.removeMod(profile.id, mod.fileName)
        await refreshModProfiles(profile.id)
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), true)
      }
    })
    row.append(details, remove)
    container.append(row)
  }
}

function renderSearchResults() {
  const container = $('#mod-results')
  container.replaceChildren()
  const profile = state.modProfiles.find(item => item.id === state.activeModProfileId)
  if (!state.modSearchResults.length) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = profile ? 'Keine Suchergebnisse. Suche nach einem Mod-Namen.' : 'Wähle zuerst ein Mod-Profil.'
    container.append(empty)
    return
  }
  for (const mod of state.modSearchResults) {
    const card = document.createElement('article')
    card.className = 'mod-result'
    const details = document.createElement('div')
    details.className = 'mod-result-details'
    const title = document.createElement('strong')
    title.textContent = mod.title
    const description = document.createElement('p')
    description.textContent = mod.description
    const metadata = document.createElement('small')
    metadata.textContent = `${mod.provider === 'modrinth' ? 'Modrinth' : 'CurseForge'} · ${mod.downloads.toLocaleString('de-DE')} Downloads`
    details.append(title, description, metadata)
    const installButton = document.createElement('button')
    installButton.className = 'secondary-button'
    installButton.textContent = 'INSTALLIEREN'
    installButton.disabled = !profile || profile.mods.some(item => item.projectId === mod.id && item.provider === mod.provider)
    if (installButton.disabled && profile) installButton.textContent = 'INSTALLIERT'
    installButton.addEventListener('click', async () => {
      if (!profile) return
      installButton.disabled = true
      try {
        await window.launcher.installMod(mod.provider, mod.id, profile.id)
        await refreshModProfiles(profile.id)
        notify(`${mod.title} wurde installiert.`)
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), true)
        installButton.disabled = false
      }
    })
    card.append(details, installButton)
    container.append(card)
  }
}

async function refreshModProfiles(selectedId = state.activeModProfileId) {
  state.modProfiles = await window.launcher.modProfiles()
  const select = $('#profile-select') as HTMLSelectElement
  select.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = state.modProfiles.length ? 'Profil auswählen …' : 'Noch keine Profile'
  select.append(placeholder)
  for (const profile of state.modProfiles) {
    const option = document.createElement('option')
    option.value = profile.id
    option.textContent = `${profile.name} · ${profile.loader}`
    select.append(option)
  }
  const nextId = state.modProfiles.some(profile => profile.id === selectedId)
    ? selectedId!
    : state.modProfiles[0]?.id ?? ''
  setActiveModProfile(nextId)
}

async function init() {
  window.launcher.onStatus(setStatus)
  const initial = await window.launcher.initialData()
  state.config = initial.config
  state.installed = new Set(initial.installedVersions)
  fillSettings(initial.config)
  state.modProfiles = initial.modProfiles
  setAccount(initial.account)
  const manifest = await window.launcher.versions()
  renderVersions(manifest.versions, manifest.latestRelease)
  const profileVersion = $('#profile-version') as HTMLSelectElement
  for (const version of manifest.versions) {
    const option = document.createElement('option')
    option.value = version.id
    option.textContent = version.id
    profileVersion.append(option)
  }
  profileVersion.value = manifest.latestRelease
  await refreshModProfiles(localStorage.getItem('activeModProfileId') ?? undefined)
  $('#version-select').addEventListener('change', updateVersionControls)

  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach(button => {
    button.addEventListener('click', () => showView(button.dataset.view as 'play' | 'mods' | 'settings'))
  })
  $('#account-button').addEventListener('click', async () => {
    try {
      if (state.account) {
        await window.launcher.signOut()
        setAccount(undefined)
        notify('Du wurdest abgemeldet.')
      } else {
        const accountButton = $('#account-button') as HTMLButtonElement
        accountButton.disabled = true
        setStatus({ kind: 'auth-progress', message: 'Microsoft-Anmeldung wird vorbereitet …' })
        try {
          setAccount(await window.launcher.signIn())
          $('#auth-dialog').toggleAttribute('hidden', true)
          notify('Microsoft-Konto erfolgreich verbunden.')
        } finally {
          accountButton.disabled = false
        }
      }
    } catch (error) {
      $('#auth-dialog').toggleAttribute('hidden', true)
      notify(error instanceof Error ? error.message : String(error), true)
    }
  })
  $('#install-button').addEventListener('click', async () => {
    try {
      const button = $('#install-button') as HTMLButtonElement
      button.disabled = true
      await window.launcher.install(selectedVersion())
      await refreshInstalled()
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    } finally {
      ($('#install-button') as HTMLButtonElement).disabled = false
    }
  })
  $('#play-button').addEventListener('click', async () => {
    try {
      ($('#play-button') as HTMLButtonElement).disabled = true
      await window.launcher.launch(selectedVersion())
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    } finally {
      updateVersionControls()
    }
  })
  $('#settings-form').addEventListener('submit', async event => {
    event.preventDefault()
    const config: SaveLauncherConfig = {
      clientId: ($('#client-id') as HTMLInputElement).value,
      gameDirectory: ($('#game-directory') as HTMLInputElement).value,
      javaPath: ($('#java-path') as HTMLInputElement).value,
      maxMemoryMb: Number(($('#max-memory') as HTMLSelectElement).value),
      updateFeedUrl: ($('#update-feed') as HTMLInputElement).value,
      curseForgeApiKey: ($('#curseforge-key') as HTMLInputElement).value || undefined,
    }
    try {
      state.config = await window.launcher.saveConfig(config)
      fillSettings(state.config)
      const curseForgeKey = $('#curseforge-key') as HTMLInputElement
      curseForgeKey.value = ''
      await refreshInstalled()
      $('#save-state').textContent = 'Gespeichert'
      window.setTimeout(() => { $('#save-state').textContent = '' }, 2500)
      notify('Einstellungen gespeichert.')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    }
  })
  $('#browse-java').addEventListener('click', async () => {
    const path = await window.launcher.chooseJava()
    if (path) ($('#java-path') as HTMLInputElement).value = path
  })
  $('#browse-directory').addEventListener('click', async () => {
    const path = await window.launcher.chooseGameDirectory()
    if (path) ($('#game-directory') as HTMLInputElement).value = path
  })
  $('#folder-button').addEventListener('click', () => void window.launcher.openFolder('root'))
  $('#screenshots-button').addEventListener('click', () => void window.launcher.openFolder('screenshots')
    .catch(error => notify(error instanceof Error ? error.message : String(error), true)))
  $('#saves-button').addEventListener('click', () => void window.launcher.openFolder('saves')
    .catch(error => notify(error instanceof Error ? error.message : String(error), true)))
  $('#update-button').addEventListener('click', async () => {
    try {
      await window.launcher.checkUpdates()
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    }
  })
  $('#install-update-button').addEventListener('click', async () => {
    try {
      await window.launcher.installUpdate()
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    }
  })
  $('#dismiss-update-button').addEventListener('click', () => {
    $('#update-banner').toggleAttribute('hidden', true)
  })
  $('#player-skin').addEventListener('error', () => {
    const skin = $('#player-skin') as HTMLImageElement
    skin.hidden = true
    skin.removeAttribute('src')
    $('#skin-placeholder').toggleAttribute('hidden', false)
  })
  $('#copy-device-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#device-code').textContent ?? '')
      notify('Anmeldecode wurde kopiert.')
    } catch {
      notify('Code konnte nicht kopiert werden. Bitte markiere ihn und kopiere ihn manuell.', true)
    }
  })
  $('#cancel-sign-in').addEventListener('click', async () => {
    await window.launcher.cancelSignIn()
    $('#auth-dialog').toggleAttribute('hidden', true)
  })
  $('#clear-curseforge-key').addEventListener('click', async () => {
    try {
      await window.launcher.clearCurseForgeApiKey()
      if (state.config) state.config.hasCurseForgeApiKey = false
      if (state.config) fillSettings(state.config)
      notify('CurseForge-API-Schlüssel wurde gelöscht.')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    }
  })
  $('#profile-select').addEventListener('change', event => {
    setActiveModProfile((event.target as HTMLSelectElement).value)
  })
  $('#profile-form').addEventListener('submit', async event => {
    event.preventDefault()
    const button = event.submitter as HTMLButtonElement | null
    if (button) button.disabled = true
    try {
      const profileName = $('#profile-name') as HTMLInputElement
      const profileVersion = $('#profile-version') as HTMLSelectElement
      const profileLoader = $('#profile-loader') as HTMLSelectElement
      const profile = await window.launcher.createModProfile({
        name: profileName.value,
        minecraftVersion: profileVersion.value,
        loader: profileLoader.value as 'fabric' | 'forge',
      })
      profileName.value = ''
      await refreshModProfiles(profile.id)
      notify(`Profil „${profile.name}“ wurde erstellt.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    } finally {
      if (button) button.disabled = false
    }
  })
  $('#launch-profile').addEventListener('click', async () => {
    const profile = state.modProfiles.find(item => item.id === state.activeModProfileId)
    if (!profile) return
    try {
      await window.launcher.launchModProfile(profile.id)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    }
  })
  $('#delete-profile').addEventListener('click', async () => {
    const profile = state.modProfiles.find(item => item.id === state.activeModProfileId)
    if (!profile || !window.confirm(`Profil „${profile.name}“ und dessen Spieldateien wirklich löschen?`)) return
    try {
      await window.launcher.deleteModProfile(profile.id)
      await refreshModProfiles('')
      notify(`Profil „${profile.name}“ wurde gelöscht.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    }
  })
  $('#mod-search-form').addEventListener('submit', async event => {
    event.preventDefault()
    const profile = state.modProfiles.find(item => item.id === state.activeModProfileId)
    if (!profile) {
      notify('Erstelle oder wähle zuerst ein Mod-Profil.', true)
      return
    }
    const button = (event.submitter as HTMLButtonElement | null)
    if (button) button.disabled = true
    try {
      const provider = ($('#mod-provider') as HTMLSelectElement).value as ModProvider
      state.modSearchResults = await window.launcher.searchMods(
        provider,
        ($('#mod-query') as HTMLInputElement).value,
        profile.id,
      )
      renderSearchResults()
      if (!state.modSearchResults.length) notify('Keine passenden Mods gefunden.')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    } finally {
      if (button) button.disabled = false
    }
  })
}

void init().catch(error => notify(error instanceof Error ? error.message : String(error), true))
