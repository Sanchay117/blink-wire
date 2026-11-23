import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

let cachedEnv: Record<string, string> | null = null

function loadDotEnvOnce(): Record<string, string> {
  if (cachedEnv) return cachedEnv
  const out: Record<string, string> = {}
  for (const name of ['.env.local', '.env']) {
    const file = resolve(process.cwd(), name)
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
      if (key && !(key in out)) out[key] = val
    }
  }
  cachedEnv = out
  return out
}

function env(key: string): string {
  const f = loadDotEnvOnce()
  return (process.env[key] || f[key] || '').trim()
}

function redactSecrets(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]').replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-[REDACTED]')
}

function resolveCorsOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin
  if (!origin) return null
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin
  const extra = env('ALLOWED_ORIGINS')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (extra.includes(origin)) return origin
  return null
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  const origin = resolveCorsOrigin(req)
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buf.byteLength
    if (total > maxBytes) throw Object.assign(new Error('Request body too large'), { status: 413 })
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 })
  }
}

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

interface TelegramUpdate {
  update_id: number
  message?: TelegramMsg
  edited_message?: TelegramMsg
  channel_post?: TelegramMsg
}

interface TelegramMsg {
  message_id: number
  date: number
  text?: string
  caption?: string
  voice?: { file_id: string; duration?: number }
  photo?: unknown[]
  document?: { file_name?: string }
  sticker?: { emoji?: string }
  from?: { first_name?: string; last_name?: string; username?: string; is_bot?: boolean }
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string }
}

interface ArmedSend {
  token: string
  kind: 'reply' | 'reaction'
  platform: 'telegram' | 'slack' | 'discord'
  chatId: string
  replyToMessageId?: string
  text?: string
  emoji?: string
  expiresAt: number
}

const telegramCache = new Map<
  string,
  {
    botUsername: string
    canReadAllGroups: boolean
    offset: number
    messages: WireMessage[]
    inFlight: Promise<{ botUsername: string; messages: WireMessage[]; webhookCleared?: boolean }> | null
  }
>()
const armedSends = new Map<string, ArmedSend>()
const sseClients = new Set<ServerResponse>()
let hnCache: { ts: number; items: WireMessage[] } | null = null

function pruneArmed(): void {
  const now = Date.now()
  for (const [k, v] of armedSends) {
    if (v.expiresAt <= now) armedSends.delete(k)
  }
}

function broadcastSse(event: string, data: unknown): void {
  if (sseClients.size === 0) return
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try {
      client.write(payload)
    } catch {
      sseClients.delete(client)
    }
  }
}

function classifyUrgency(text: string): 'URGENT' | 'ACTION' | 'FYI' {
  const lower = text.toLowerCase()
  if (/\b(urgent|asap|emergency|down|broken|outage|call me|now|deadline|blocked|critical)\b/.test(lower)) {
    return 'URGENT'
  }
  if (/\?|can you|could you|please|send|confirm|approve|review|check|meet|sync|eta/.test(lower)) {
    return 'ACTION'
  }
  return 'FYI'
}

function buildRuleDrafts(sender: string, text: string): string[] {
  const lower = text.toLowerCase()
  if (/\b(eta|where|when|late|omw|meet|sync|call)\b/.test(lower)) {
    return ['On my way - 10m', 'Can we push 15 min?', 'Free now, calling soon']
  }
  if (/\b(approve|confirm|ok|good|ship|merge|deploy|go ahead)\b/.test(lower)) {
    return ['Approved - go ahead', 'Hold on, checking now', 'Looks good to ship']
  }
  if (/\?/.test(text)) {
    return ['Yes, on it now', 'Checking - reply in 15m', `Got it ${sender.replace(/^@/, '').split(' ')[0]}, will follow up`]
  }
  return ['Got it, thanks!', 'On it - update soon', 'Acknowledged, talking later']
}

async function transcribeAudioBytes(
  audioBytes: Buffer,
  filename: string,
  mimeType: string,
  groqKey: string,
  openAiKey: string,
): Promise<string> {
  const apiKey = groqKey || openAiKey
  if (!apiKey) throw new Error('Set GROQ_API_KEY or OPENAI_API_KEY for voice transcription.')

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audioBytes)], { type: mimeType }), filename)
  form.append('model', groqKey ? 'whisper-large-v3-turbo' : 'whisper-1')
  form.append('language', 'en')

  const endpoint = groqKey
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions'

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) {
    const err = await r.text()
    throw new Error(`STT ${r.status}: ${err.slice(0, 140)}`)
  }
  const j = (await r.json()) as { text?: string }
  return (j.text || '').trim()
}

async function transcribeTelegramVoice(
  tgToken: string,
  fileId: string,
  groqKey: string,
  openAiKey: string,
): Promise<string | null> {
  if (!groqKey && !openAiKey) return null
  try {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${tgToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(8000) },
    )
    const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path?: string; file_size?: number } }
    if (!meta.ok || !meta.result?.file_path) return null
    if ((meta.result.file_size || 0) > 2 * 1024 * 1024) return null

    const fileRes = await fetch(`https://api.telegram.org/file/bot${tgToken}/${meta.result.file_path}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!fileRes.ok) return null
    const buf = Buffer.from(await fileRes.arrayBuffer())
    return await transcribeAudioBytes(buf, 'voice.ogg', 'audio/ogg', groqKey, openAiKey)
  } catch {
    return null
  }
}

async function pollTelegram(
  token: string,
  groqKey: string,
  openAiKey: string,
): Promise<{ botUsername: string; messages: WireMessage[]; webhookCleared?: boolean }> {
  let state = telegramCache.get(token)
  if (!state) {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(8000),
    })
    const meJson = (await meRes.json()) as {
      ok: boolean
      description?: string
      result?: { username?: string; can_read_all_group_messages?: boolean }
    }
    if (!meJson.ok) {
      throw new Error(redactSecrets(meJson.description || 'Invalid Telegram bot token'))
    }
    state = {
      botUsername: meJson.result?.username || 'bot',
      canReadAllGroups: Boolean(meJson.result?.can_read_all_group_messages),
      offset: 0,
      messages: [],
      inFlight: null,
    }
    telegramCache.set(token, state)
  }

  // Single-flight mutex prevents overlapping getUpdates 409 conflicts
  if (state.inFlight) return state.inFlight

  const run = (async () => {
    let webhookCleared = false
    const callUpdates = async () => {
      const u = new URL(`https://api.telegram.org/bot${token}/getUpdates`)
      u.searchParams.set('limit', '25')
      u.searchParams.set('timeout', '0')
      if (state.offset > 0) u.searchParams.set('offset', String(state.offset))
      const res = await fetch(u, { signal: AbortSignal.timeout(8000) })
      return (await res.json()) as { ok: boolean; error_code?: number; description?: string; result?: TelegramUpdate[] }
    }

    let data = await callUpdates()
    if (!data.ok && (data.error_code === 409 || /webhook/i.test(data.description || ''))) {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, {
        signal: AbortSignal.timeout(8000),
      }).catch(() => {})
      webhookCleared = true
      data = await callUpdates()
    }
    if (!data.ok) {
      throw new Error(redactSecrets(data.description || 'Telegram getUpdates failed'))
    }

    const newArrivals: WireMessage[] = []
    for (const upd of data.result || []) {
      if (upd.update_id >= state.offset) state.offset = upd.update_id + 1
      const msg = upd.message || upd.edited_message || upd.channel_post
      if (!msg || msg.from?.is_bot) continue

      // Clean onboarding reply for /start or /ping so it doesn't clutter G2 HUD
      const rawText = (msg.text || msg.caption || '').trim()
      if (/^\/(start|ping)\b/i.test(rawText)) {
        void fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            text: `BlinkWire G2 connected! Chat ID: ${msg.chat.id}. Send any text or voice note here to see it live on Even G2.`,
          }),
          signal: AbortSignal.timeout(6000),
        }).catch(() => {})
        continue
      }

      let bodyText = rawText
      let isVoiceNote = false
      if (!bodyText && msg.voice) {
        isVoiceNote = true
        const transcript = await transcribeTelegramVoice(token, msg.voice.file_id, groqKey, openAiKey)
        const dur = msg.voice.duration ? `${msg.voice.duration}s` : ''
        bodyText = transcript
          ? `[VOICE ${dur}]: ${transcript}`
          : `[VOICE ${dur}] Add GROQ_API_KEY or OPENAI_API_KEY to auto-transcribe on speakerless G2.`
      } else if (!bodyText && msg.photo) {
        bodyText = '[Photo attachment]'
      } else if (!bodyText && msg.document) {
        bodyText = `[File: ${msg.document.file_name || 'document'}]`
      } else if (!bodyText && msg.sticker) {
        bodyText = `[Sticker ${msg.sticker.emoji || ''}]`.trim()
      }
      if (!bodyText) continue

      const sender = msg.from?.username
        ? `@${msg.from.username}`
        : [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Unknown'
      const chatLabel =
        msg.chat.type === 'private'
          ? sender
          : msg.chat.title || (msg.chat.username ? `@${msg.chat.username}` : `Chat ${msg.chat.id}`)

      const item: WireMessage = {
        id: `tg:${msg.chat.id}:${msg.message_id}`,
        messageId: String(msg.message_id),
        platform: 'telegram',
        chatId: String(msg.chat.id),
        chatLabel,
        sender,
        text: bodyText,
        timestamp: msg.date * 1000,
        urgency: classifyUrgency(bodyText),
        replyable: true,
        isVoiceNote,
      }
      if (!state.messages.some(m => m.id === item.id)) {
        state.messages.unshift(item)
        newArrivals.push(item)
      }
    }

    state.messages = state.messages.slice(0, 25)
    if (newArrivals.length > 0) {
      broadcastSse('messages', { botUsername: state.botUsername, items: newArrivals })
    }
    return { botUsername: state.botUsername, messages: state.messages, webhookCleared }
  })()

  state.inFlight = run
  try {
    return await run
  } finally {
    state.inFlight = null
  }
}

async function pollSlack(token: string, channelId: string): Promise<WireMessage[]> {
  const url = new URL('https://slack.com/api/conversations.history')
  url.searchParams.set('channel', channelId)
  url.searchParams.set('limit', '10')
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  })
  const data = (await res.json()) as {
    ok: boolean
    error?: string
    messages?: Array<{ ts: string; text?: string; user?: string; bot_id?: string }>
  }
  if (!data.ok) throw new Error(`Slack error: ${data.error || 'unknown'}`)
  return (data.messages || [])
    .filter(m => m.text && !m.bot_id)
    .map(m => ({
      id: `sl:${channelId}:${m.ts}`,
      messageId: m.ts,
      platform: 'slack' as const,
      chatId: channelId,
      chatLabel: `#${channelId}`,
      sender: m.user ? `U:${m.user.slice(-5)}` : 'Slack',
      text: (m.text || '').trim(),
      timestamp: Math.round(Number(m.ts) * 1000),
      urgency: classifyUrgency(m.text || ''),
      replyable: true,
    }))
}

async function pollDiscord(token: string, channelId: string): Promise<WireMessage[]> {
  const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=10`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Discord ${res.status}: ${errText.slice(0, 120)}`)
  }
  const rows = (await res.json()) as Array<{
    id: string
    content: string
    timestamp: string
    author?: { username?: string; bot?: boolean }
  }>
  return rows
    .filter(r => r.content && !r.author?.bot)
    .map(r => ({
      id: `dc:${channelId}:${r.id}`,
      messageId: r.id,
      platform: 'discord' as const,
      chatId: channelId,
      chatLabel: `DC:${channelId.slice(-5)}`,
      sender: r.author?.username ? `@${r.author.username}` : 'Discord',
      text: r.content.trim(),
      timestamp: Date.parse(r.timestamp) || Date.now(),
      urgency: classifyUrgency(r.content),
      replyable: true,
    }))
}

async function fetchLiveNews(): Promise<WireMessage[]> {
  if (hnCache && Date.now() - hnCache.ts < 90_000) return hnCache.items
  const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
    signal: AbortSignal.timeout(6000),
  })
  if (!idsRes.ok) throw new Error(`HN feed returned ${idsRes.status}`)
  const ids = ((await idsRes.json()) as number[]).slice(0, 8)
  const settled = await Promise.allSettled(
    ids.map(async id => {
      const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        signal: AbortSignal.timeout(5000),
      })
      return (await r.json()) as { id: number; title?: string; by?: string; score?: number; time?: number; url?: string }
    }),
  )
  const items = settled
    .filter((s): s is PromiseFulfilledResult<{ id: number; title?: string; by?: string; score?: number; time?: number; url?: string }> => s.status === 'fulfilled' && Boolean(s.value?.title))
    .map(s => {
      const it = s.value
      return {
        id: `hn:${it.id}`,
        messageId: String(it.id),
        platform: 'news' as const,
        chatId: String(it.id),
        chatLabel: `HN ${it.score ?? 0}pts`,
        sender: it.by ? `@${it.by}` : 'HN',
        text: it.title || '',
        timestamp: (it.time || Math.floor(Date.now() / 1000)) * 1000,
        urgency: (it.score ?? 0) >= 250 ? ('URGENT' as const) : ('FYI' as const),
        replyable: false,
        url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
      }
    })
  hnCache = { ts: Date.now(), items }
  return items
}

async function generateAiDrafts(opts: {
  sender: string
  text: string
  platform: string
  recentThread: Array<{ sender: string; text: string }>
  openRouterKey: string
  openAiKey: string
  model: string
}): Promise<{ source: 'ai' | 'rule'; summary: string; urgency: 'URGENT' | 'ACTION' | 'FYI'; drafts: string[] }> {
  const fallback = {
    source: 'rule' as const,
    summary: opts.text.slice(0, 80),
    urgency: classifyUrgency(opts.text),
    drafts: buildRuleDrafts(opts.sender, opts.text),
  }

  const providers: Array<{ url: string; key: string; model: string; extraHeaders?: Record<string, string> }> = []
  if (opts.openRouterKey) {
    providers.push({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: opts.openRouterKey,
      model: opts.model || 'openai/gpt-4o-mini',
      extraHeaders: { 'HTTP-Referer': 'http://localhost:5173', 'X-Title': 'BlinkWire G2' },
    })
  }
  if (opts.openAiKey) {
    providers.push({
      url: 'https://api.openai.com/v1/chat/completions',
      key: opts.openAiKey,
      model: 'gpt-4o-mini',
    })
  }
  if (providers.length === 0) return fallback

  const contextBlock =
    opts.recentThread.length > 0
      ? `Recent chat context:\n${opts.recentThread.map(m => `- ${m.sender}: ${m.text.slice(0, 120)}`).join('\n')}\n`
      : ''

  const prompt = [
    `Draft smart-glasses quick replies for Even Realities G2 (576x288 monochrome display).`,
    contextBlock,
    `Latest ${opts.platform} message from ${opts.sender}: "${opts.text}"`,
    `Return strict JSON: {"summary": "<=70 chars plain ASCII", "urgency": "URGENT"|"ACTION"|"FYI", "drafts": [3 distinct natural replies, each <=34 chars plain ASCII]}.`,
  ].join('\n')

  for (const p of providers) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${p.key}`,
          ...(p.extraHeaders || {}),
        },
        body: JSON.stringify({
          model: p.model,
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Output only valid JSON matching the requested schema. Plain ASCII only.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) continue
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const raw = data.choices?.[0]?.message?.content || ''
      const parsed = JSON.parse(raw) as { summary?: string; urgency?: string; drafts?: string[] }
      const drafts = Array.isArray(parsed.drafts)
        ? parsed.drafts.map(d => String(d).trim().slice(0, 38)).filter(Boolean).slice(0, 3)
        : []
      if (drafts.length >= 3) {
        const urgency =
          parsed.urgency === 'URGENT' || parsed.urgency === 'ACTION' || parsed.urgency === 'FYI'
            ? parsed.urgency
            : fallback.urgency
        return {
          source: 'ai',
          summary: (parsed.summary || fallback.summary).slice(0, 80),
          urgency,
          drafts,
        }
      }
    } catch {
      continue
    }
  }
  return fallback
}

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    sendJson(req, res, 204, {})
    return
  }

  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname

  try {
    pruneArmed()

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(req, res, 200, {
        ok: true,
        envConfigured: {
          telegram: Boolean(env('TELEGRAM_BOT_TOKEN')),
          slack: Boolean(env('SLACK_BOT_TOKEN') && env('SLACK_CHANNEL_ID')),
          discord: Boolean(env('DISCORD_BOT_TOKEN') && env('DISCORD_CHANNEL_ID')),
          ai: Boolean(env('OPENROUTER_API_KEY') || env('OPENAI_API_KEY')),
          stt: Boolean(env('GROQ_API_KEY') || env('OPENAI_API_KEY')),
        },
      })
      return
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      const origin = resolveCorsOrigin(req)
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
      res.write(`event: ready\ndata: {"ok":true}\n\n`)
      sseClients.add(res)
      const hb = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(hb)
          sseClients.delete(res)
        }
      }, 20_000)
      req.on('close', () => {
        clearInterval(hb)
        sseClients.delete(res)
      })
      return
    }

    if (pathname === '/api/telegram/verify' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const tgToken = String(body.telegramToken || env('TELEGRAM_BOT_TOKEN')).trim()
      if (!tgToken) {
        sendJson(req, res, 400, { ok: false, error: 'No Telegram Bot Token provided.' })
        return
      }
      if (body.clearWebhook === true) {
        await fetch(`https://api.telegram.org/bot${tgToken}/deleteWebhook?drop_pending_updates=false`, {
          signal: AbortSignal.timeout(8000),
        })
      }
      const [meR, whR] = await Promise.all([
        fetch(`https://api.telegram.org/bot${tgToken}/getMe`, { signal: AbortSignal.timeout(8000) }),
        fetch(`https://api.telegram.org/bot${tgToken}/getWebhookInfo`, { signal: AbortSignal.timeout(8000) }),
      ])
      const me = (await meR.json()) as {
        ok: boolean
        description?: string
        result?: { username?: string; first_name?: string; can_read_all_group_messages?: boolean }
      }
      const wh = (await whR.json()) as { ok: boolean; result?: { url?: string; pending_update_count?: number } }
      if (!me.ok) {
        sendJson(req, res, 400, { ok: false, error: redactSecrets(me.description || 'Invalid bot token') })
        return
      }
      sendJson(req, res, 200, {
        ok: true,
        username: me.result?.username || '',
        firstName: me.result?.first_name || '',
        canReadAllGroups: Boolean(me.result?.can_read_all_group_messages),
        webhookUrl: wh.result?.url || '',
        pendingUpdates: wh.result?.pending_update_count || 0,
      })
      return
    }

    if (pathname === '/api/telegram/action' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const tgToken = String(body.telegramToken || env('TELEGRAM_BOT_TOKEN')).trim()
      const chatId = String(body.chatId || '').trim()
      const action = body.action === 'record_voice' ? 'record_voice' : 'typing'
      if (tgToken && chatId) {
        await fetch(`https://api.telegram.org/bot${tgToken}/sendChatAction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, action }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {})
      }
      sendJson(req, res, 200, { ok: true })
      return
    }

    if (pathname === '/api/inbox/poll' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const tgToken = String(body.telegramToken || env('TELEGRAM_BOT_TOKEN')).trim()
      const slackToken = String(body.slackToken || env('SLACK_BOT_TOKEN')).trim()
      const slackChannel = String(body.slackChannelId || env('SLACK_CHANNEL_ID')).trim()
      const discordToken = String(body.discordToken || env('DISCORD_BOT_TOKEN')).trim()
      const discordChannel = String(body.discordChannelId || env('DISCORD_CHANNEL_ID')).trim()
      const groqKey = String(body.groqKey || env('GROQ_API_KEY')).trim()
      const openAiKey = String(body.openAiKey || env('OPENAI_API_KEY')).trim()
      const includeNews = body.includeNews !== false

      const messages: WireMessage[] = []
      const errors: Record<string, string> = {}
      let botUsername = ''

      const tasks: Promise<void>[] = []
      if (tgToken) {
        tasks.push(
          pollTelegram(tgToken, groqKey, openAiKey)
            .then(r => {
              botUsername = r.botUsername
              messages.push(...r.messages)
            })
            .catch(err => {
              errors.telegram = redactSecrets(err instanceof Error ? err.message : String(err))
            }),
        )
      }
      if (slackToken && slackChannel) {
        tasks.push(
          pollSlack(slackToken, slackChannel)
            .then(rows => {
              messages.push(...rows)
            })
            .catch(err => {
              errors.slack = err instanceof Error ? err.message : String(err)
            }),
        )
      }
      if (discordToken && discordChannel) {
        tasks.push(
          pollDiscord(discordToken, discordChannel)
            .then(rows => {
              messages.push(...rows)
            })
            .catch(err => {
              errors.discord = err instanceof Error ? err.message : String(err)
            }),
        )
      }
      if (includeNews) {
        tasks.push(
          fetchLiveNews()
            .then(rows => {
              messages.push(...rows)
            })
            .catch(err => {
              errors.news = err instanceof Error ? err.message : String(err)
            }),
        )
      }

      await Promise.all(tasks)
      messages.sort((a, b) => {
        if (a.replyable !== b.replyable) return a.replyable ? -1 : 1
        return b.timestamp - a.timestamp
      })

      sendJson(req, res, 200, { ok: true, botUsername, messages, errors, polledAt: Date.now() })
      return
    }

    if (pathname === '/api/ai/drafts' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const recentThread = Array.isArray(body.recentThread)
        ? (body.recentThread as Array<{ sender?: string; text?: string }>)
            .slice(0, 4)
            .map(m => ({ sender: String(m.sender || 'User'), text: String(m.text || '') }))
        : []
      const result = await generateAiDrafts({
        sender: String(body.sender || 'Contact'),
        text: String(body.text || ''),
        platform: String(body.platform || 'telegram'),
        recentThread,
        openRouterKey: String(body.openRouterKey || env('OPENROUTER_API_KEY')).trim(),
        openAiKey: String(body.openAiKey || env('OPENAI_API_KEY')).trim(),
        model: String(body.model || env('OPENROUTER_MODEL') || 'openai/gpt-4o-mini').trim(),
      })
      sendJson(req, res, 200, { ok: true, ...result })
      return
    }

    if (pathname === '/api/reply/arm' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const platform = body.platform === 'slack' ? 'slack' : body.platform === 'discord' ? 'discord' : 'telegram'
      const kind = body.kind === 'reaction' ? 'reaction' : 'reply'
      const chatId = String(body.chatId || '').trim()
      const replyToMessageId = String(body.replyToMessageId || '').trim() || undefined
      const text = String(body.text || '').trim()
      const emoji = String(body.emoji || '👍').trim()

      if (!chatId || (kind === 'reply' && !text)) {
        sendJson(req, res, 400, { ok: false, error: 'chatId and reply text are required.' })
        return
      }
      const token = randomBytes(16).toString('hex')
      const expiresAt = Date.now() + 8000
      armedSends.set(token, { token, kind, platform, chatId, replyToMessageId, text, emoji, expiresAt })
      sendJson(req, res, 200, { ok: true, armToken: token, expiresAt })
      return
    }

    if (pathname === '/api/reply/send' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const armToken = String(body.armToken || '').trim()
      const armed = armedSends.get(armToken)
      if (!armed || armed.expiresAt <= Date.now()) {
        armedSends.delete(armToken)
        sendJson(req, res, 400, { ok: false, error: 'Missing or expired 2-tap armToken. Re-arm on G2.' })
        return
      }
      armedSends.delete(armToken)

      if (armed.platform === 'telegram') {
        const tgToken = String(body.telegramToken || env('TELEGRAM_BOT_TOKEN')).trim()
        if (!tgToken) {
          sendJson(req, res, 400, { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured.' })
          return
        }

        if (armed.kind === 'reaction' && armed.replyToMessageId) {
          const r = await fetch(`https://api.telegram.org/bot${tgToken}/setMessageReaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: armed.chatId,
              message_id: Number(armed.replyToMessageId),
              reaction: [{ type: 'emoji', emoji: armed.emoji || '👍' }],
            }),
            signal: AbortSignal.timeout(8000),
          })
          const j = (await r.json()) as { ok: boolean; description?: string }
          if (!j.ok) {
            sendJson(req, res, 502, { ok: false, error: redactSecrets(j.description || 'Reaction failed') })
            return
          }
          sendJson(req, res, 200, { ok: true, platform: 'telegram', messageId: `react:${armed.replyToMessageId}` })
          return
        }

        const payload: Record<string, unknown> = { chat_id: armed.chatId, text: armed.text }
        if (armed.replyToMessageId && /^\d+$/.test(armed.replyToMessageId)) {
          payload.reply_parameters = {
            message_id: Number(armed.replyToMessageId),
            allow_sending_without_reply: true,
          }
        }
        const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000),
        })
        const j = (await r.json()) as { ok: boolean; description?: string; result?: { message_id: number } }
        if (!j.ok) {
          sendJson(req, res, 502, { ok: false, error: redactSecrets(j.description || 'Telegram send failed') })
          return
        }
        sendJson(req, res, 200, { ok: true, platform: 'telegram', messageId: String(j.result?.message_id ?? '') })
        return
      }

      if (armed.platform === 'slack') {
        const slackToken = String(body.slackToken || env('SLACK_BOT_TOKEN')).trim()
        if (!slackToken) {
          sendJson(req, res, 400, { ok: false, error: 'SLACK_BOT_TOKEN is not configured.' })
          return
        }
        const r = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${slackToken}` },
          body: JSON.stringify({
            channel: armed.chatId,
            text: armed.text,
            thread_ts: armed.replyToMessageId || undefined,
          }),
          signal: AbortSignal.timeout(8000),
        })
        const j = (await r.json()) as { ok: boolean; error?: string; ts?: string }
        if (!j.ok) {
          sendJson(req, res, 502, { ok: false, error: `Slack send failed: ${j.error || 'unknown'}` })
          return
        }
        sendJson(req, res, 200, { ok: true, platform: 'slack', messageId: j.ts || '' })
        return
      }

      if (armed.platform === 'discord') {
        const discordToken = String(body.discordToken || env('DISCORD_BOT_TOKEN')).trim()
        if (!discordToken) {
          sendJson(req, res, 400, { ok: false, error: 'DISCORD_BOT_TOKEN is not configured.' })
          return
        }
        const payload: Record<string, unknown> = { content: armed.text }
        if (armed.replyToMessageId) {
          payload.message_reference = { message_id: armed.replyToMessageId }
        }
        const r = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(armed.chatId)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bot ${discordToken}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000),
        })
        if (!r.ok) {
          const err = await r.text()
          sendJson(req, res, 502, { ok: false, error: `Discord send ${r.status}: ${err.slice(0, 120)}` })
          return
        }
        const j = (await r.json()) as { id?: string }
        sendJson(req, res, 200, { ok: true, platform: 'discord', messageId: j.id || '' })
        return
      }

      sendJson(req, res, 400, { ok: false, error: 'Unsupported platform.' })
      return
    }

    if (pathname === '/api/voice/transcribe' && req.method === 'POST') {
      const body = await readJsonBody(req, 2.5 * 1024 * 1024)
      const wavBase64 = String(body.wavBase64 || '')
      if (!wavBase64) {
        sendJson(req, res, 400, { ok: false, error: 'wavBase64 is required.' })
        return
      }
      const groqKey = String(body.groqKey || env('GROQ_API_KEY')).trim()
      const openAiKey = String(body.openAiKey || env('OPENAI_API_KEY')).trim()
      const text = await transcribeAudioBytes(
        Buffer.from(wavBase64, 'base64'),
        'g2-voice.wav',
        'audio/wav',
        groqKey,
        openAiKey,
      )
      sendJson(req, res, 200, { ok: true, text })
      return
    }

    sendJson(req, res, 404, { ok: false, error: `Unknown route: ${pathname}` })
  } catch (err) {
    const status = (err as { status?: number })?.status || 500
    sendJson(req, res, status, { ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) })
  }
}
