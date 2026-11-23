import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['.env.local', '.env']) {
    const file = resolve(process.cwd(), name)
    if (!existsSync(file)) continue
    const raw = readFileSync(file, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
      if (key && !(key in out)) out[key] = val
    }
  }
  return out
}

function env(key: string): string {
  const fileEnv = loadDotEnv()
  return (process.env[key] || fileEnv[key] || '').trim()
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text) as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.end(JSON.stringify(payload))
}

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

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    date: number
    text?: string
    caption?: string
    from?: { first_name?: string; last_name?: string; username?: string }
    chat: { id: number; type: string; title?: string; username?: string; first_name?: string }
  }
}

const telegramCache = new Map<string, { botUsername: string; offset: number; messages: WireMessage[] }>()

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
    return ['On my way — 10m', 'Can we push 15 min?', 'Free now, calling soon']
  }
  if (/\b(approve|confirm|ok|good|ship|merge|deploy|go ahead)\b/.test(lower)) {
    return ['Approved — go ahead', 'Hold on, checking now', 'Looks good to ship']
  }
  if (/\?/.test(text)) {
    return ['Yes, on it now', 'Checking — reply in 15m', `Got it ${sender.split(' ')[0]}, will follow up`]
  }
  return ['Got it, thanks!', 'On it — update soon', 'Acknowledged, talking later']
}

async function pollTelegram(token: string): Promise<{ botUsername: string; messages: WireMessage[] }> {
  let state = telegramCache.get(token)
  if (!state) {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const meJson = (await meRes.json()) as { ok: boolean; description?: string; result?: { username?: string } }
    if (!meJson.ok) {
      throw new Error(meJson.description || 'Invalid Telegram bot token')
    }
    state = {
      botUsername: meJson.result?.username || 'bot',
      offset: 0,
      messages: [],
    }
    telegramCache.set(token, state)
  }

  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`)
  url.searchParams.set('limit', '25')
  url.searchParams.set('timeout', '0')
  if (state.offset > 0) {
    url.searchParams.set('offset', String(state.offset))
  }

  const res = await fetch(url)
  const data = (await res.json()) as { ok: boolean; description?: string; result?: TelegramUpdate[] }
  if (!data.ok) {
    throw new Error(data.description || 'Telegram getUpdates failed')
  }

  for (const upd of data.result || []) {
    if (upd.update_id >= state.offset) {
      state.offset = upd.update_id + 1
    }
    const msg = upd.message
    if (!msg) continue
    const body = (msg.text || msg.caption || '').trim()
    if (!body) continue
    const sender =
      msg.from?.username
        ? `@${msg.from.username}`
        : [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Unknown'
    const chatLabel =
      msg.chat.type === 'private'
        ? sender
        : msg.chat.title || (msg.chat.username ? `@${msg.chat.username}` : `Chat ${msg.chat.id}`)
    const item: WireMessage = {
      id: `tg:${msg.chat.id}:${msg.message_id}`,
      platform: 'telegram',
      chatId: String(msg.chat.id),
      chatLabel,
      sender,
      text: body,
      timestamp: msg.date * 1000,
      urgency: classifyUrgency(body),
      replyable: true,
    }
    if (!state.messages.some(m => m.id === item.id)) {
      state.messages.unshift(item)
    }
  }
  state.messages = state.messages.slice(0, 20)
  return { botUsername: state.botUsername, messages: state.messages }
}

async function pollSlack(token: string, channelId: string): Promise<WireMessage[]> {
  const url = new URL('https://slack.com/api/conversations.history')
  url.searchParams.set('channel', channelId)
  url.searchParams.set('limit', '10')
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = (await res.json()) as {
    ok: boolean
    error?: string
    messages?: Array<{ ts: string; text?: string; user?: string; bot_id?: string }>
  }
  if (!data.ok) {
    throw new Error(`Slack error: ${data.error || 'unknown'}`)
  }
  return (data.messages || [])
    .filter(m => m.text && !m.bot_id)
    .map(m => ({
      id: `sl:${channelId}:${m.ts}`,
      platform: 'slack' as const,
      chatId: channelId,
      chatLabel: `#${channelId}`,
      sender: m.user ? `U:${m.user.slice(-5)}` : 'Slack User',
      text: (m.text || '').trim(),
      timestamp: Math.round(Number(m.ts) * 1000),
      urgency: classifyUrgency(m.text || ''),
      replyable: true,
    }))
}

async function pollDiscord(token: string, channelId: string): Promise<WireMessage[]> {
  const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=10`, {
    headers: { Authorization: `Bot ${token}` },
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
  const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')
  if (!idsRes.ok) throw new Error(`HN feed returned ${idsRes.status}`)
  const ids = ((await idsRes.json()) as number[]).slice(0, 8)
  const items = await Promise.all(
    ids.map(async id => {
      const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
      return (await r.json()) as {
        id: number
        title?: string
        by?: string
        score?: number
        time?: number
        url?: string
      }
    }),
  )
  return items
    .filter(it => it && it.title)
    .map(it => ({
      id: `hn:${it.id}`,
      platform: 'news' as const,
      chatId: String(it.id),
      chatLabel: `HN · ${it.score ?? 0} pts`,
      sender: it.by ? `@${it.by}` : 'HN',
      text: it.title || '',
      timestamp: (it.time || Math.floor(Date.now() / 1000)) * 1000,
      urgency: (it.score ?? 0) >= 250 ? ('URGENT' as const) : ('FYI' as const),
      replyable: false,
      url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
    }))
}

async function generateAiDrafts(
  sender: string,
  text: string,
  platform: string,
  openRouterKey: string,
  openAiKey: string,
  model: string,
): Promise<{ source: 'ai' | 'rule'; summary: string; urgency: 'URGENT' | 'ACTION' | 'FYI'; drafts: string[] }> {
  const fallback = {
    source: 'rule' as const,
    summary: text.slice(0, 96),
    urgency: classifyUrgency(text),
    drafts: buildRuleDrafts(sender, text),
  }

  const useOpenRouter = Boolean(openRouterKey)
  const apiKey = useOpenRouter ? openRouterKey : openAiKey
  if (!apiKey) return fallback

  const endpoint = useOpenRouter
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions'
  const chosenModel = useOpenRouter ? model || 'openai/gpt-4o-mini' : 'gpt-4o-mini'

  const prompt = [
    `You are drafting glanceable smart-glasses quick replies for Even Realities G2 (576x288 monochrome display).`,
    `Incoming ${platform} message from ${sender}: "${text}"`,
    `Return strict JSON with keys: "summary" (<=80 chars), "urgency" ("URGENT"|"ACTION"|"FYI"), "drafts" (array of exactly 3 concise actionable replies, each <=38 chars, natural human tone).`,
  ].join('\n')

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: chosenModel,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Output only valid JSON matching the requested schema.' },
        { role: 'user', content: prompt },
      ],
    }),
  })

  if (!res.ok) return fallback
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const raw = data.choices?.[0]?.message?.content || ''
  try {
    const parsed = JSON.parse(raw) as { summary?: string; urgency?: string; drafts?: string[] }
    const drafts = Array.isArray(parsed.drafts)
      ? parsed.drafts.map(d => String(d).trim().slice(0, 44)).filter(Boolean).slice(0, 3)
      : []
    if (drafts.length < 3) return fallback
    const urgency =
      parsed.urgency === 'URGENT' || parsed.urgency === 'ACTION' || parsed.urgency === 'FYI'
        ? parsed.urgency
        : fallback.urgency
    return {
      source: 'ai',
      summary: (parsed.summary || fallback.summary).slice(0, 96),
      urgency,
      drafts,
    }
  } catch {
    return fallback
  }
}

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {})
    return
  }

  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
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

    if (pathname === '/api/inbox/poll' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const tgToken = String(body.telegramToken || env('TELEGRAM_BOT_TOKEN')).trim()
      const slackToken = String(body.slackToken || env('SLACK_BOT_TOKEN')).trim()
      const slackChannel = String(body.slackChannelId || env('SLACK_CHANNEL_ID')).trim()
      const discordToken = String(body.discordToken || env('DISCORD_BOT_TOKEN')).trim()
      const discordChannel = String(body.discordChannelId || env('DISCORD_CHANNEL_ID')).trim()
      const includeNews = body.includeNews !== false

      const messages: WireMessage[] = []
      const errors: Record<string, string> = {}
      let botUsername = ''

      const tasks: Promise<void>[] = []

      if (tgToken) {
        tasks.push(
          pollTelegram(tgToken)
            .then(r => {
              botUsername = r.botUsername
              messages.push(...r.messages)
            })
            .catch(err => {
              errors.telegram = err instanceof Error ? err.message : String(err)
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

      sendJson(res, 200, {
        ok: true,
        botUsername,
        messages,
        errors,
        polledAt: Date.now(),
      })
      return
    }

    if (pathname === '/api/ai/drafts' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const sender = String(body.sender || 'Contact')
      const text = String(body.text || '')
      const platform = String(body.platform || 'telegram')
      const openRouterKey = String(body.openRouterKey || env('OPENROUTER_API_KEY')).trim()
      const openAiKey = String(body.openAiKey || env('OPENAI_API_KEY')).trim()
      const model = String(body.model || env('OPENROUTER_MODEL') || 'openai/gpt-4o-mini').trim()

      const result = await generateAiDrafts(sender, text, platform, openRouterKey, openAiKey, model)
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (pathname === '/api/reply/send' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body.confirmed !== true) {
        sendJson(res, 400, { ok: false, error: '2-tap confirmation required before sending.' })
        return
      }
      const platform = String(body.platform || '')
      const chatId = String(body.chatId || '').trim()
      const text = String(body.text || '').trim()
      if (!chatId || !text) {
        sendJson(res, 400, { ok: false, error: 'chatId and text are required.' })
        return
      }

      if (platform === 'telegram') {
        const tgToken = String(body.telegramToken || env('TELEGRAM_BOT_TOKEN')).trim()
        if (!tgToken) {
          sendJson(res, 400, { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured.' })
          return
        }
        const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        })
        const j = (await r.json()) as { ok: boolean; description?: string; result?: { message_id: number } }
        if (!j.ok) {
          sendJson(res, 502, { ok: false, error: j.description || 'Telegram sendMessage failed' })
          return
        }
        sendJson(res, 200, { ok: true, platform: 'telegram', messageId: String(j.result?.message_id ?? '') })
        return
      }

      if (platform === 'slack') {
        const slackToken = String(body.slackToken || env('SLACK_BOT_TOKEN')).trim()
        if (!slackToken) {
          sendJson(res, 400, { ok: false, error: 'SLACK_BOT_TOKEN is not configured.' })
          return
        }
        const r = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${slackToken}`,
          },
          body: JSON.stringify({ channel: chatId, text }),
        })
        const j = (await r.json()) as { ok: boolean; error?: string; ts?: string }
        if (!j.ok) {
          sendJson(res, 502, { ok: false, error: `Slack send failed: ${j.error || 'unknown'}` })
          return
        }
        sendJson(res, 200, { ok: true, platform: 'slack', messageId: j.ts || '' })
        return
      }

      if (platform === 'discord') {
        const discordToken = String(body.discordToken || env('DISCORD_BOT_TOKEN')).trim()
        if (!discordToken) {
          sendJson(res, 400, { ok: false, error: 'DISCORD_BOT_TOKEN is not configured.' })
          return
        }
        const r = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(chatId)}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${discordToken}`,
          },
          body: JSON.stringify({ content: text }),
        })
        if (!r.ok) {
          const err = await r.text()
          sendJson(res, 502, { ok: false, error: `Discord send ${r.status}: ${err.slice(0, 120)}` })
          return
        }
        const j = (await r.json()) as { id?: string }
        sendJson(res, 200, { ok: true, platform: 'discord', messageId: j.id || '' })
        return
      }

      sendJson(res, 400, { ok: false, error: `Unsupported platform: ${platform}` })
      return
    }

    if (pathname === '/api/voice/transcribe' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const wavBase64 = String(body.wavBase64 || '')
      if (!wavBase64) {
        sendJson(res, 400, { ok: false, error: 'wavBase64 is required.' })
        return
      }
      const groqKey = String(body.groqKey || env('GROQ_API_KEY')).trim()
      const openAiKey = String(body.openAiKey || env('OPENAI_API_KEY')).trim()
      const apiKey = groqKey || openAiKey
      if (!apiKey) {
        sendJson(res, 400, {
          ok: false,
          error: 'Set GROQ_API_KEY or OPENAI_API_KEY for G2 voice transcription.',
        })
        return
      }

      const wavBytes = Buffer.from(wavBase64, 'base64')
      const form = new FormData()
      form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'g2-voice.wav')
      form.append('model', groqKey ? 'whisper-large-v3-turbo' : 'whisper-1')
      form.append('language', 'en')

      const endpoint = groqKey
        ? 'https://api.groq.com/openai/v1/audio/transcriptions'
        : 'https://api.openai.com/v1/audio/transcriptions'

      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      })
      if (!r.ok) {
        const err = await r.text()
        sendJson(res, 502, { ok: false, error: `STT ${r.status}: ${err.slice(0, 140)}` })
        return
      }
      const j = (await r.json()) as { text?: string }
      sendJson(res, 200, { ok: true, text: (j.text || '').trim() })
      return
    }

    sendJson(res, 404, { ok: false, error: `Unknown route: ${pathname}` })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
