export interface WireMessage {
  id: string
  messageId: string
  platform: 'telegram' | 'slack' | 'discord' | 'news'
  chatId: string
  chatLabel: string
  sender: string
  text: string
  timestamp: number
  urgency: 'URGENT' | 'ACTION' | 'FYI'
  replyable: boolean
  isVoiceNote?: boolean
  url?: string
}

export interface WireConfig {
  relayUrl: string
  telegramToken: string
  slackToken: string
  slackChannelId: string
  discordToken: string
  discordChannelId: string
  openRouterKey: string
  openRouterModel: string
  openAiKey: string
  groqKey: string
  includeNews: boolean
}

export interface HealthInfo {
  ok: boolean
  envConfigured: {
    telegram: boolean
    slack: boolean
    discord: boolean
    ai: boolean
    stt: boolean
  }
}

const PREF_KEY = 'blinkwire.prefs.v2'
const SECRET_KEY = 'blinkwire.secrets.v2'

export function loadConfig(): WireConfig {
  const defaults: WireConfig = {
    relayUrl: '',
    telegramToken: '',
    slackToken: '',
    slackChannelId: '',
    discordToken: '',
    discordChannelId: '',
    openRouterKey: '',
    openRouterModel: 'openai/gpt-4o-mini',
    openAiKey: '',
    groqKey: '',
    includeNews: true,
  }
  try {
    const prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') as Partial<WireConfig>
    const secrets = JSON.parse(sessionStorage.getItem(SECRET_KEY) || '{}') as Partial<WireConfig>
    return { ...defaults, ...prefs, ...secrets }
  } catch {
    return defaults
  }
}

export function saveConfig(cfg: WireConfig): void {
  localStorage.setItem(
    PREF_KEY,
    JSON.stringify({
      relayUrl: cfg.relayUrl,
      slackChannelId: cfg.slackChannelId,
      discordChannelId: cfg.discordChannelId,
      openRouterModel: cfg.openRouterModel,
      includeNews: cfg.includeNews,
    }),
  )
  sessionStorage.setItem(
    SECRET_KEY,
    JSON.stringify({
      telegramToken: cfg.telegramToken,
      slackToken: cfg.slackToken,
      discordToken: cfg.discordToken,
      openRouterKey: cfg.openRouterKey,
      openAiKey: cfg.openAiKey,
      groqKey: cfg.groqKey,
    }),
  )
}

export function clearSessionSecrets(): void {
  sessionStorage.removeItem(SECRET_KEY)
}

export function apiBase(cfg: WireConfig): string {
  return cfg.relayUrl.trim().replace(/\/+$/, '')
}

async function reqJson<T>(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Relay returned non-JSON (${res.status})`)
  }
  return data as T
}

export async function fetchHealth(cfg: WireConfig): Promise<HealthInfo> {
  return reqJson<HealthInfo>(`${apiBase(cfg)}/api/health`, undefined, 5000)
}

export async function verifyTelegramBot(
  cfg: WireConfig,
  clearWebhook = false,
): Promise<{
  ok: boolean
  username?: string
  firstName?: string
  canReadAllGroups?: boolean
  webhookUrl?: string
  pendingUpdates?: number
  error?: string
}> {
  return reqJson(`${apiBase(cfg)}/api/telegram/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegramToken: cfg.telegramToken, clearWebhook }),
  })
}

export function sendTelegramPresence(cfg: WireConfig, chatId: string, action: 'typing' | 'record_voice'): void {
  void fetch(`${apiBase(cfg)}/api/telegram/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegramToken: cfg.telegramToken, chatId, action }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
}

export async function pollInbox(cfg: WireConfig): Promise<{
  ok: boolean
  botUsername: string
  messages: WireMessage[]
  errors: Record<string, string>
  polledAt: number
}> {
  return reqJson(`${apiBase(cfg)}/api/inbox/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telegramToken: cfg.telegramToken,
      slackToken: cfg.slackToken,
      slackChannelId: cfg.slackChannelId,
      discordToken: cfg.discordToken,
      discordChannelId: cfg.discordChannelId,
      groqKey: cfg.groqKey,
      openAiKey: cfg.openAiKey,
      includeNews: cfg.includeNews,
    }),
  })
}

export async function fetchDrafts(
  cfg: WireConfig,
  msg: WireMessage,
  recentThread: Array<{ sender: string; text: string }>,
): Promise<{ ok: boolean; source: 'ai' | 'rule'; summary: string; urgency: string; drafts: string[] }> {
  return reqJson(
    `${apiBase(cfg)}/api/ai/drafts`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: msg.sender,
        text: msg.text,
        platform: msg.platform,
        recentThread,
        openRouterKey: cfg.openRouterKey,
        openAiKey: cfg.openAiKey,
        model: cfg.openRouterModel,
      }),
    },
    11_000,
  )
}

export async function armReplyOnServer(
  cfg: WireConfig,
  msg: WireMessage,
  payload: { kind: 'reply'; text: string } | { kind: 'reaction'; emoji: string },
): Promise<{ ok: boolean; armToken?: string; expiresAt?: number; error?: string }> {
  return reqJson(`${apiBase(cfg)}/api/reply/arm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: msg.platform,
      chatId: msg.chatId,
      replyToMessageId: msg.messageId,
      ...payload,
    }),
  })
}

export async function sendArmedReply(
  cfg: WireConfig,
  armToken: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  return reqJson(`${apiBase(cfg)}/api/reply/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      armToken,
      telegramToken: cfg.telegramToken,
      slackToken: cfg.slackToken,
      discordToken: cfg.discordToken,
    }),
  })
}

export async function transcribeVoice(
  cfg: WireConfig,
  wavBase64: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  return reqJson(
    `${apiBase(cfg)}/api/voice/transcribe`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wavBase64,
        groqKey: cfg.groqKey,
        openAiKey: cfg.openAiKey,
      }),
    },
    16_000,
  )
}
