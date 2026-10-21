import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Account, AccountsState, DeviceCodeInfo } from '../shared/types'
import { accountsFile, ensureDir } from './paths'
import { readJsonFile, writeFileAtomic } from './net'
import type { SettingsStore } from './settings'
import { log } from './logger'

interface StoredAccount extends Account {
  accessToken?: string
  refreshToken?: string
}

interface StoreFile {
  accounts: StoredAccount[]
  activeId: string | null
}

const CONSUMERS = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const XBL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE = 'https://api.minecraftservices.com/minecraft/profile'
const SCOPE = 'XboxLive.signin offline_access'

export function offlineUuid(name: string): string {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

class AuthError extends Error {}

async function postForm<T>(url: string, form: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'BerryLauncher/0.1.0',
    },
    body: new URLSearchParams(form).toString(),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const code = String(data.error ?? res.status)
    const description = String(data.error_description ?? data.error ?? '')
    throw Object.assign(new AuthError(description || `认证失败 (${code})`), { code, status: res.status })
  }
  return data as T
}

async function postJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'BerryLauncher/0.1.0',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new AuthError(String(data.errorMessage ?? data.error ?? `请求失败 (${res.status})`))
  return data as T
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

interface XblResponse {
  Token: string
  DisplayClaims: { xui: { uhs: string }[] }
}

interface MinecraftProfile {
  id: string
  name: string
  skins?: { url: string }[]
}

export class AccountService {
  private state: StoreFile = { accounts: [], activeId: null }
  private loaded = false
  private readonly polls = new Map<string, { clientId: string; interval: number; expiresAt: number }>()
  private onChange: (state: AccountsState) => void = () => {}
  private microsoftInFlight: Promise<DeviceCodeInfo> | null = null

  constructor(private readonly settings: SettingsStore) {}

  setChangeListener(listener: (state: AccountsState) => void): void {
    this.onChange = listener
  }

  private load(): StoreFile {
    if (this.loaded) return this.state
    this.loaded = true
    const file = readJsonFile<StoreFile>(accountsFile())
    if (file && Array.isArray(file.accounts)) this.state = file
    return this.state
  }

  private persist(): void {
    ensureDir(path.dirname(accountsFile()))
    const tmp = `${accountsFile()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, accountsFile())
    try {
      fs.chmodSync(accountsFile(), 0o600)
    } catch {
      /* best effort */
    }
    this.onChange(this.publicState())
  }

  publicAccount(account: StoredAccount): Account {
    return {
      id: account.id,
      type: account.type,
      name: account.name,
      uuid: account.uuid,
      expiresAt: account.expiresAt,
      skinUrl: account.skinUrl,
    }
  }

  publicState(): AccountsState {
    const state = this.load()
    return {
      accounts: state.accounts.map((a) => this.publicAccount(a)),
      activeId: state.activeId,
    }
  }

  addOffline(name: string): Account {
    const trimmed = name.trim()
    if (!/^[A-Za-z0-9_]{3,16}$/.test(trimmed)) {
      throw new Error('玩家名需为 3-16 位字母、数字或下划线')
    }
    const state = this.load()
    if (state.accounts.some((a) => a.type === 'offline' && a.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error('已存在同名离线账户')
    }
    const account: StoredAccount = {
      id: offlineUuid(trimmed),
      type: 'offline',
      name: trimmed,
      uuid: offlineUuid(trimmed),
    }
    state.accounts.push(account)
    state.activeId = account.id
    this.persist()
    return this.publicAccount(account)
  }

  remove(id: string): void {
    const state = this.load()
    state.accounts = state.accounts.filter((a) => a.id !== id)
    if (state.activeId === id) state.activeId = state.accounts[0]?.id ?? null
    this.persist()
  }

  setActive(id: string): void {
    const state = this.load()
    if (!state.accounts.some((a) => a.id === id)) throw new Error('账户不存在')
    state.activeId = id
    this.persist()
  }

  async startMicrosoft(): Promise<DeviceCodeInfo> {
    if (this.microsoftInFlight) return this.microsoftInFlight
    this.microsoftInFlight = this.doStartMicrosoft().finally(() => {
      this.microsoftInFlight = null
    })
    return this.microsoftInFlight
  }

  private async doStartMicrosoft(): Promise<DeviceCodeInfo> {
    const clientId = this.settings.get().msClientId
    if (!clientId) {
      throw new Error(
        '尚未配置微软登录的 Client ID。请到设置 → 账户填写 Azure 应用的客户端 ID（公开客户端，无需密钥）。',
      )
    }
    const data = await postForm<{
      device_code: string
      user_code: string
      verification_uri: string
      expires_in: number
      interval: number
      message: string
    }>(`${CONSUMERS}/devicecode`, { client_id: clientId, scope: SCOPE })

    this.polls.set(data.device_code, {
      clientId,
      interval: Math.max(3, data.interval || 5),
      expiresAt: Date.now() + data.expires_in * 1000,
    })
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      message: data.message,
    }
  }

  async pollMicrosoft(deviceCode: string): Promise<Account | null> {
    const poll = this.polls.get(deviceCode)
    if (!poll) throw new Error('登录会话不存在或已过期，请重新发起登录')
    if (Date.now() > poll.expiresAt) {
      this.polls.delete(deviceCode)
      throw new Error('登录码已过期，请重新发起登录')
    }
    try {
      const token = await postForm<TokenResponse>(`${CONSUMERS}/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: poll.clientId,
        device_code: deviceCode,
      })
      const account = await this.completeMicrosoftLogin(token.access_token, token.refresh_token)
      this.polls.delete(deviceCode)
      return account
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'authorization_pending' || code === 'slow_down') return null
      this.polls.delete(deviceCode)
      throw new Error((err as Error).message)
    }
  }

  private async completeMicrosoftLogin(msToken: string, refreshToken?: string): Promise<Account> {
    const xbl = await postJson<XblResponse>(XBL, {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    })

    let xsts: XblResponse
    try {
      xsts = await postJson<XblResponse>(XSTS, {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      })
    } catch (err) {
      const xerr = (err as { message?: string }).message ?? ''
      if (xerr.includes('2148916233')) throw new Error('该微软账户还没有 Xbox 账号，请先创建 Xbox 档案')
      if (xerr.includes('2148916238')) throw new Error('该账户属于未成年人，需要家长同意后才能登录')
      if (xerr.includes('2148916235')) throw new Error('该账户所在地区不支持 Xbox Live')
      throw err
    }

    const uhs = xbl.DisplayClaims.xui[0]?.uhs
    if (!uhs) throw new Error('Xbox 认证返回数据异常')

    const mc = await postJson<{ access_token: string; expires_in: number }>(MC_LOGIN, {
      identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
    })

    const res = await fetch(MC_PROFILE, {
      headers: { Authorization: `Bearer ${mc.access_token}`, 'User-Agent': 'BerryLauncher/0.1.0' },
    })
    if (res.status === 404) throw new Error('该账户没有 Minecraft: Java Edition 的所有权')
    if (!res.ok) throw new Error(`获取 Minecraft 档案失败 (${res.status})`)
    const profile = (await res.json()) as MinecraftProfile

    const account: StoredAccount = {
      id: profile.id,
      type: 'microsoft',
      name: profile.name,
      uuid: profile.id,
      skinUrl: profile.skins?.[0]?.url,
      expiresAt: Date.now() + mc.expires_in * 1000,
      accessToken: mc.access_token,
      refreshToken,
    }

    const state = this.load()
    const existing = state.accounts.findIndex((a) => a.id === account.id && a.type === 'microsoft')
    if (existing >= 0) {
      account.refreshToken = refreshToken ?? state.accounts[existing].refreshToken
      state.accounts[existing] = account
    } else {
      state.accounts.push(account)
    }
    state.activeId = account.id
    this.persist()
    log.info('microsoft login ok', account.name)
    return this.publicAccount(account)
  }

  /** Returns a usable session, refreshing the Microsoft token when needed. */
  async ensureSession(accountId?: string): Promise<{
    account: Account
    accessToken: string
    userType: 'msa' | 'legacy'
  }> {
    const state = this.load()
    const id = accountId ?? state.activeId
    const account = state.accounts.find((a) => a.id === id) ?? state.accounts[0]
    if (!account) throw new Error('请先添加一个账户')

    if (account.type === 'offline') {
      return { account: this.publicAccount(account), accessToken: '0', userType: 'legacy' }
    }

    const stillValid = account.accessToken && account.expiresAt && account.expiresAt - 120_000 > Date.now()
    if (stillValid) {
      return { account: this.publicAccount(account), accessToken: account.accessToken!, userType: 'msa' }
    }

    if (!account.refreshToken) throw new Error('微软登录已过期，请重新登录')
    const clientId = this.settings.get().msClientId
    if (!clientId) throw new Error('缺少 Client ID，无法刷新微软登录')

    try {
      const token = await postForm<TokenResponse>(`${CONSUMERS}/token`, {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: account.refreshToken,
        scope: SCOPE,
      })
      const refreshed = await this.completeMicrosoftLogin(token.access_token, token.refresh_token ?? account.refreshToken)
      const stored = this.load().accounts.find((a) => a.id === refreshed.id)
      return {
        account: refreshed,
        accessToken: stored?.accessToken ?? '',
        userType: 'msa',
      }
    } catch (err) {
      log.warn('token refresh failed', err)
      throw new Error('微软登录已失效，请重新登录账户')
    }
  }
}
