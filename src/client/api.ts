export interface WireMessage {
  id: string
  platform: 'telegram' | 'slack' | 'discord' | 'news'
  chatId: string
  chatLabel: string
  sender: string
  text: string
  timestamp: number
  urgency: 'URGENT' | 'ACTION' | 'FYI'
  replyable: boolean
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

const STORAGE_KEY = 'blinkwire.config.v1'

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
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    return { ...defaults, ...(JSON.parse(raw) as Partial<WireConfig>) }
  } catch {
    return defaults
  }
}

export function saveConfig(cfg: WireConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}

function apiBase(cfg: WireConfig): string {
  return cfg.relayUrl.trim().replace(/\/+$/, '')
}

export async function pollInbox(cfg: WireConfig): Promise<{
  ok: boolean
  botUsername: string
  messages: WireMessage[]
  errors: Record<string, string>
  polledAt: number
}> {
  const res = await fetch(`${apiBase(cfg)}/api/inbox/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telegramToken: cfg.telegramToken,
      slackToken: cfg.slackToken,
      slackChannelId: cfg.slackChannelId,
      discordToken: cfg.discordToken,
      discordChannelId: cfg.discordChannelId,
      includeNews: cfg.includeNews,
    }),
  })
  return (await res.json()) as {
    ok: boolean
    botUsername: string
    messages: WireMessage[]
    errors: Record<string, string>
    polledAt: number
  }
}

export async function fetchDrafts(
  cfg: WireConfig,
  msg: WireMessage,
): Promise<{ ok: boolean; source: 'ai' | 'rule'; summary: string; urgency: string; drafts: string[] }> {
  const res = await fetch(`${apiBase(cfg)}/api/ai/drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: msg.sender,
      text: msg.text,
      platform: msg.platform,
      openRouterKey: cfg.openRouterKey,
      openAiKey: cfg.openAiKey,
      model: cfg.openRouterModel,
    }),
  })
  return (await res.json()) as {
    ok: boolean
    source: 'ai' | 'rule'
    summary: string
    urgency: string
    drafts: string[]
  }
}

export async function sendConfirmedReply(
  cfg: WireConfig,
  msg: WireMessage,
  text: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const res = await fetch(`${apiBase(cfg)}/api/reply/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      confirmed: true,
      platform: msg.platform,
      chatId: msg.chatId,
      text,
      telegramToken: cfg.telegramToken,
      slackToken: cfg.slackToken,
      discordToken: cfg.discordToken,
    }),
  })
  return (await res.json()) as { ok: boolean; messageId?: string; error?: string }
}

export async function transcribeVoice(
  cfg: WireConfig,
  wavBase64: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const res = await fetch(`${apiBase(cfg)}/api/voice/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wavBase64,
      groqKey: cfg.groqKey,
      openAiKey: cfg.openAiKey,
    }),
  })
  return (await res.json()) as { ok: boolean; text?: string; error?: string }
}
