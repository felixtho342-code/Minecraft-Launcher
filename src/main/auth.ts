import { shell } from 'electron'
import type { WebContents } from 'electron'
import type { AccountProfile, LauncherStatus } from './types'
import { readStoredAuth, saveStoredAuth, clearStoredAuth } from './config'

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  error?: string
  error_description?: string
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
  message?: string
}

interface XboxTokenResponse {
  Token: string
  DisplayClaims: { xui: Array<{ uhs: string }> }
}

interface MinecraftTokenResponse {
  access_token: string
  expires_in: number
}

interface MinecraftProfileResponse {
  id: string
  name: string
}

async function readJson<T>(response: Response, service: string): Promise<T> {
  const body = await response.json() as T & { errorMessage?: string; error_description?: string; error?: string }
  if (!response.ok) {
    throw new Error(`${service}: ${(body as { errorMessage?: string; error?: string }).errorMessage
      ?? (body as { error_description?: string }).error_description
      ?? (body as { error?: string }).error ?? response.statusText}`)
  }
  return body
}

function reportAuth(contents: WebContents, status: LauncherStatus): void {
  if (!contents.isDestroyed()) contents.send('launcher:status', status)
}

function waitForPollInterval(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Microsoft-Anmeldung wurde abgebrochen.'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Microsoft-Anmeldung wurde abgebrochen.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function requestDeviceCode(clientId: string, signal: AbortSignal): Promise<DeviceCodeResponse> {
  const form = new URLSearchParams({
    client_id: clientId,
    scope: 'XboxLive.signin offline_access',
  })
  return readJson(await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal,
  }), 'Microsoft-Geräteanmeldung')
}

async function pollDeviceCode(
  clientId: string,
  device: DeviceCodeResponse,
  signal: AbortSignal,
  contents: WebContents,
): Promise<OAuthTokenResponse> {
  const deadline = Date.now() + device.expires_in * 1000
  let intervalSeconds = Math.max(1, device.interval ?? 5)

  while (Date.now() < deadline) {
    await waitForPollInterval(intervalSeconds * 1000, signal)
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: device.device_code,
    })
    const response = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal,
    })
    const body = await response.json() as OAuthTokenResponse & { error_description?: string }
    if (response.ok) return body

    switch (body.error) {
      case 'authorization_pending':
        reportAuth(contents, {
          kind: 'auth-progress',
          message: 'Warte auf deine Bestätigung im Microsoft-Browserfenster …',
        })
        break
      case 'slow_down':
        intervalSeconds += 5
        break
      case 'authorization_declined':
        throw new Error('Die Microsoft-Anmeldung wurde abgelehnt.')
      case 'expired_token':
      case 'bad_verification_code':
        throw new Error('Der Microsoft-Anmeldecode ist abgelaufen. Bitte starte die Anmeldung erneut.')
      default:
        throw new Error(`Microsoft-Anmeldung fehlgeschlagen: ${body.error_description ?? body.error ?? response.statusText}`)
    }
  }
  throw new Error('Der Microsoft-Anmeldecode ist abgelaufen. Bitte starte die Anmeldung erneut.')
}

async function refreshMicrosoftToken(clientId: string, refreshToken: string): Promise<OAuthTokenResponse> {
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'XboxLive.signin offline_access',
  })
  return readJson(await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  }), 'Microsoft-Token-Erneuerung')
}

async function getMinecraftAccessToken(microsoftAccessToken: string, signal?: AbortSignal): Promise<string> {
  const xbox = await readJson<XboxTokenResponse>(await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${microsoftAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
    signal,
  }), 'Xbox Live')

  const xsts = await readJson<XboxTokenResponse>(await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }),
    signal,
  }), 'Xbox XSTS')

  const userHash = xsts.DisplayClaims?.xui?.[0]?.uhs
  if (!userHash) throw new Error('Xbox XSTS hat keine Benutzer-ID zurückgegeben.')
  const minecraft = await readJson<MinecraftTokenResponse>(await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xsts.Token}` }),
    signal,
  }), 'Minecraft-Anmeldung')
  return minecraft.access_token
}

async function fetchProfile(minecraftAccessToken: string, signal?: AbortSignal): Promise<AccountProfile> {
  const entitlements = await readJson<{ items: Array<{ name: string }> }>(
    await fetch('https://api.minecraftservices.com/entitlements/minecraft', {
      headers: { Authorization: `Bearer ${minecraftAccessToken}` },
      signal,
    }),
    'Minecraft-Berechtigung',
  )
  if (!entitlements.items?.some(item => item.name === 'game_minecraft')) {
    throw new Error('Dieses Microsoft-Konto besitzt keine Minecraft-Java-Lizenz.')
  }

  return readJson<AccountProfile>(await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${minecraftAccessToken}` },
    signal,
  }), 'Minecraft-Profil')
}

async function authenticateWithDeviceCode(
  clientId: string,
  contents: WebContents,
  signal: AbortSignal,
): Promise<OAuthTokenResponse> {
  const device = await requestDeviceCode(clientId, signal)
  if (!device.device_code || !device.user_code || !device.verification_uri || !device.expires_in) {
    throw new Error('Microsoft hat keine gültigen Geräteanmeldedaten zurückgegeben.')
  }
  const verificationUrl = device.verification_uri_complete ?? device.verification_uri
  const verification = new URL(verificationUrl)
  if (verification.protocol !== 'https:'
    || !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com'].includes(verification.hostname)) {
    throw new Error('Microsoft hat eine ungültige Anmeldeseite zurückgegeben.')
  }
  reportAuth(contents, {
    kind: 'auth-device-code',
    message: 'Gib diesen Code auf der Microsoft-Seite ein und melde dich dort mit E-Mail und Passkey oder Passwort an.',
    authCode: device.user_code,
    verificationUri: device.verification_uri,
  })
  if (signal.aborted) throw new Error('Microsoft-Anmeldung wurde abgebrochen.')
  await shell.openExternal(verificationUrl)
  return pollDeviceCode(clientId, device, signal, contents)
}

const pendingSignIns = new Map<number, AbortController>()

export async function signIn(clientId: string, contents: WebContents): Promise<AccountProfile> {
  if (!clientId.trim()) throw new Error('Bitte trage zuerst die Microsoft-OAuth-Client-ID in den Einstellungen ein.')
  if (pendingSignIns.has(contents.id)) throw new Error('Eine Microsoft-Anmeldung läuft bereits.')
  const controller = new AbortController()
  pendingSignIns.set(contents.id, controller)
  const abortWhenDestroyed = () => controller.abort()
  contents.once('destroyed', abortWhenDestroyed)
  try {
    const microsoft = await authenticateWithDeviceCode(clientId, contents, controller.signal)
    if (!microsoft.refresh_token) throw new Error('Microsoft hat keinen Refresh-Token geliefert. Prüfe die OAuth-App-Einstellungen.')
    reportAuth(contents, { kind: 'auth-progress', message: 'Microsoft bestätigt. Minecraft-Konto wird geprüft …' })
    const minecraftAccessToken = await getMinecraftAccessToken(microsoft.access_token, controller.signal)
    const profile = await fetchProfile(minecraftAccessToken, controller.signal)
    if (controller.signal.aborted) throw new Error('Microsoft-Anmeldung wurde abgebrochen.')
    await saveStoredAuth({ microsoftRefreshToken: microsoft.refresh_token, profile })
    reportAuth(contents, { kind: 'status', message: 'Microsoft-Konto erfolgreich verbunden.' })
    return profile
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Microsoft-Anmeldung wurde abgebrochen.')
    throw error
  } finally {
    contents.removeListener('destroyed', abortWhenDestroyed)
    pendingSignIns.delete(contents.id)
  }
}

export function cancelSignIn(contents: WebContents): void {
  pendingSignIns.get(contents.id)?.abort()
}

export async function getAuthenticatedMinecraftToken(clientId: string): Promise<{ accessToken: string; profile: AccountProfile }> {
  const stored = await readStoredAuth()
  if (!stored) throw new Error('Bitte melde dich zuerst mit deinem Microsoft-Konto an.')
  const microsoft = await refreshMicrosoftToken(clientId, stored.microsoftRefreshToken)
  const accessToken = await getMinecraftAccessToken(microsoft.access_token)
  const profile = await fetchProfile(accessToken)
  if (microsoft.refresh_token) {
    await saveStoredAuth({ microsoftRefreshToken: microsoft.refresh_token, profile })
  }
  return { accessToken, profile }
}

export async function getAccount(): Promise<AccountProfile | undefined> {
  return (await readStoredAuth())?.profile
}

export async function signOut(): Promise<void> {
  await clearStoredAuth()
}
