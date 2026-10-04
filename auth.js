'use strict'

// Same chain as https://github.com/ravioli-a/refresh-token-authentication :
// Microsoft refresh token -> Xbox Live -> XSTS -> Minecraft access token -> profile.

const LIVE_TOKEN_URL = 'https://login.live.com/oauth20_token.srf'
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/license?requestId=auth'

const CLIENT_ID = '00000000402b5328'
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf'
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL'

const OWNERSHIP_SOURCES = new Set(['GAMEPASS', 'PURCHASE', 'MC_PURCHASE'])

const XSTS_ERRORS = {
  2148916227: 'The account is banned from Xbox',
  2148916233: "The account doesn't have an Xbox account (never signed in)",
  2148916235: 'The account is from a country where Xbox Live is not available',
  2148916236: 'The account needs adult verification on the Xbox page (South Korea)',
  2148916237: 'The account needs adult verification on the Xbox page (South Korea)',
  2148916238: 'The account is a child and must be added to a Family by an adult',
  2148916262: 'Unknown Xbox error'
}

class AuthError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AuthError'
  }
}

async function request (url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, { method, headers, body, redirect: 'manual' })
  if (response.status === 429) {
    throw new AuthError('You are rate limited, try again in a moment')
  }
  const text = await response.text()
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: response.status, json }
}

async function refreshMicrosoftToken (refreshToken) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    redirect_uri: REDIRECT_URI,
    refresh_token: refreshToken,
    scope: SCOPE
  })

  const { status, json } = await request(LIVE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  if (status >= 500) throw new AuthError('Microsoft services are unavailable')
  if (!json) throw new AuthError(`Received no response when trying to refresh oauth tokens (code ${status})`)
  if (json.error) {
    const detail = json.error_description || json.description
    throw new AuthError(detail ? `${json.error} (${detail})` : `Received an error while refreshing oauth tokens: ${json.error}`)
  }
  if (!json.access_token || !json.refresh_token) {
    throw new AuthError('Received invalid JSON object while trying to refresh oauth tokens')
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in
  }
}

async function getXboxLiveToken (msaAccessToken) {
  const { status, json } = await request(XBL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `t=${msaAccessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    })
  })

  if (status >= 500) throw new AuthError('Xbox services are unavailable (XBL)')
  if (status === 401) throw new AuthError('OAuth access token is invalid')
  if (!json?.Token || !json?.DisplayClaims?.xui?.[0]?.uhs) {
    throw new AuthError('Missing Token or DisplayClaims when trying to get Xbox live token')
  }

  return { token: json.Token, userHash: json.DisplayClaims.xui[0].uhs }
}

async function getXstsToken (xblToken) {
  const { status, json } = await request(XSTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xblToken]
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  })

  if (status >= 500) throw new AuthError('Xbox services are unavailable (XSTS)')
  if (!json) throw new AuthError('XSTS token not found')
  if (json.XErr != null) {
    const code = Number(json.XErr)
    throw new AuthError(`Received an error while getting XSTS Token: ${XSTS_ERRORS[code] || 'Unknown error'} (${code})`)
  }
  if (!json.Token) throw new AuthError('XSTS token not found')
  return json.Token
}

async function getMinecraftAccessToken (xstsToken, userHash) {
  const { status, json } = await request(MC_LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xstsToken}` })
  })

  if (status >= 500) throw new AuthError('Xbox services are unavailable (login_with_xbox)')
  if (!json) throw new AuthError('No Minecraft access token found')
  if (json.path || json.error) {
    const reason = json.error || json.details?.reason || 'You are being rate limited, try again in a moment'
    throw new AuthError(`Received an error while trying to get Minecraft access token: ${reason}`)
  }
  if (!json.access_token) throw new AuthError('No Minecraft access token found')

  return { accessToken: json.access_token, expiresIn: json.expires_in }
}

async function assertOwnsMinecraft (accessToken) {
  const { status, json } = await request(MC_ENTITLEMENTS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })

  if (status >= 500) throw new AuthError('Minecraft services are unavailable')
  if (status !== 200) throw new AuthError(`Received code ${status} when trying to check game ownership`)
  if (!json?.items) throw new AuthError("Couldn't receive entitlements")

  const owns = json.items.some(item =>
    typeof item.name === 'string' &&
    item.name.includes('minecraft') &&
    OWNERSHIP_SOURCES.has(item.source)
  )
  if (!owns) throw new AuthError("Account doesn't own Minecraft")
}

async function getMinecraftProfile (accessToken) {
  const { status, json } = await request(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })

  if (status === 404 || status === 400) {
    throw new AuthError('Profile not found (the username is most likely unset)')
  }
  if (status >= 500) throw new AuthError('Minecraft services are unavailable')
  if (status !== 200 || !json?.name || !json?.id) {
    throw new AuthError(`Invalid response from Minecraft services (code: ${status})`)
  }

  return { username: json.name, uuid: json.id }
}

async function sessionFromAccessToken (accessToken) {
  await assertOwnsMinecraft(accessToken)
  const profile = await getMinecraftProfile(accessToken)
  return { accessToken, profile }
}

async function sessionFromRefreshToken (refreshToken) {
  const microsoft = await refreshMicrosoftToken(refreshToken)
  const xbox = await getXboxLiveToken(microsoft.accessToken)
  const xsts = await getXstsToken(xbox.token)
  const minecraft = await getMinecraftAccessToken(xsts, xbox.userHash)
  const session = await sessionFromAccessToken(minecraft.accessToken)
  return { ...session, refreshToken: microsoft.refreshToken, expiresIn: minecraft.expiresIn }
}

module.exports = {
  AuthError,
  sessionFromAccessToken,
  sessionFromRefreshToken
}
