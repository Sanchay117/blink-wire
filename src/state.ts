import type { WireMessage } from './client/api'
import type { HudFrame } from './g2/bridge'

export type Screen = 'inbox' | 'reply_pick' | 'voice_capture' | 'confirm_send' | 'receipt'
export type InboxFilter = 'all' | 'unread' | 'telegram'

export interface ReplyOption {
  kind: 'draft' | 'reaction' | 'voice' | 'back'
  label: string
  text?: string
  emoji?: string
}

export interface AuditEntry {
  time: string
  platform: string
  target: string
  text: string
  status: 'SENT' | 'ERROR'
  detail: string
}

export interface ArmedReplyState {
  target: WireMessage
  kind: 'reply' | 'reaction'
  text: string
  emoji?: string
  armToken: string
  expiresAt: number
}

export interface AppState {
  screen: Screen
  filter: InboxFilter
  messages: WireMessage[]
  selectedIdx: number
  activeMessage: WireMessage | null // locked target prevents wrong-recipient race
  drafts: string[]
  draftSource: 'ai' | 'rule' | 'loading'
  draftSummary: string
  optionIdx: number
  armed: ArmedReplyState | null
  voiceChunks: Uint8Array[]
  voiceStartedAt: number
  voiceRms: number
  receiptText: string
  botUsername: string
  errors: Record<string, string>
  repliedIds: string[]
  auditLog: AuditEntry[]
  lastPollAt: number
}

const AUDIT_KEY = 'blinkwire.audit.v2'
const REPLIED_KEY = 'blinkwire.replied.v2'

export function createInitialState(): AppState {
  let auditLog: AuditEntry[] = []
  let repliedIds: string[] = []
  try {
    const rawAudit = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]')
    const rawReplied = JSON.parse(localStorage.getItem(REPLIED_KEY) || '[]')
    auditLog = Array.isArray(rawAudit) ? (rawAudit as AuditEntry[]) : []
    repliedIds = Array.isArray(rawReplied) ? (rawReplied as string[]) : []
  } catch {
    auditLog = []
    repliedIds = []
  }
  return {
    screen: 'inbox',
    filter: 'all',
    messages: [],
    selectedIdx: 0,
    activeMessage: null,
    drafts: [],
    draftSource: 'rule',
    draftSummary: '',
    optionIdx: 0,
    armed: null,
    voiceChunks: [],
    voiceStartedAt: 0,
    voiceRms: 0,
    receiptText: '',
    botUsername: '',
    errors: {},
    repliedIds: repliedIds.slice(0, 100),
    auditLog: auditLog.slice(0, 50),
    lastPollAt: 0,
  }
}

export function persistTriageState(state: AppState): void {
  state.auditLog = state.auditLog.slice(0, 50)
  state.repliedIds = state.repliedIds.slice(0, 100)
  localStorage.setItem(AUDIT_KEY, JSON.stringify(state.auditLog))
  localStorage.setItem(REPLIED_KEY, JSON.stringify(state.repliedIds))
}

// Strips unsupported emojis/non-ASCII glyphs that render as LVGL placeholder boxes on G2
export function sanitizeForG2(raw: string): string {
  return raw
    .replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, ':$1:')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<@!?(\w+)>/g, '@$1')
    .replace(/[·•|]/g, '|')
    .replace(/…/g, '...')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0E\uFE0F]/gu, '')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function clip(text: string, max: number, fallback = ''): string {
  const clean = sanitizeForG2(text).replace(/\n+/g, ' ')
  const val = clean || fallback
  if (!val) return ''
  return val.length <= max ? val : `${val.slice(0, Math.max(1, max - 3))}...`
}

// Preserves explicit newlines and wraps long tokens without dropping trailing slices
export function wrapLines(text: string, lineWidth = 38, maxLines = 5): string {
  const cleaned = sanitizeForG2(text) || '[Media/Emoji]'
  const paragraphs = cleaned.split('\n')
  const out: string[] = []

  for (const para of paragraphs) {
    const rawWords = para.trim().split(/\s+/).filter(Boolean)
    if (rawWords.length === 0) {
      if (out.length < maxLines) out.push('')
      if (out.length >= maxLines) break
      continue
    }
    const tokens: string[] = []
    for (const w of rawWords) {
      if (w.length <= lineWidth) {
        tokens.push(w)
      } else {
        for (let k = 0; k < w.length; k += lineWidth) {
          tokens.push(w.slice(k, k + lineWidth))
        }
      }
    }
    let current = ''
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      const next = current ? `${current} ${t}` : t
      if (next.length <= lineWidth) {
        current = next
      } else {
        out.push(current)
        if (out.length >= maxLines) {
          const lastIdx = maxLines - 1
          out[lastIdx] = `${out[lastIdx].slice(0, Math.max(1, lineWidth - 3))}...`
          return out.join('\n')
        }
        current = t
      }
    }
    if (current) {
      out.push(current)
      if (out.length >= maxLines) {
        const hasMore = paragraphs.indexOf(para) < paragraphs.length - 1
        if (hasMore) {
          const lastIdx = maxLines - 1
          out[lastIdx] = `${out[lastIdx].slice(0, Math.max(1, lineWidth - 3))}...`
        }
        return out.slice(0, maxLines).join('\n')
      }
    }
  }
  return out.slice(0, maxLines).join('\n')
}

export function visibleMessages(state: AppState): WireMessage[] {
  if (state.filter === 'telegram') return state.messages.filter(m => m.platform === 'telegram')
  if (state.filter === 'unread') return state.messages.filter(m => m.replyable && !state.repliedIds.includes(m.id))
  return state.messages
}

export function unreadCount(state: AppState): number {
  return state.messages.filter(m => m.replyable && !state.repliedIds.includes(m.id)).length
}

export function getReplyOptions(state: AppState): ReplyOption[] {
  const target = state.activeMessage
  const opts: ReplyOption[] = state.drafts.map(d => ({
    kind: 'draft' as const,
    label: clip(d, 34),
    text: d,
  }))
  if (target?.platform === 'telegram') {
    opts.push({ kind: 'reaction', label: '[ACK] Send Thumbs-Up Reaction', emoji: '👍' })
  }
  opts.push({ kind: 'voice', label: '[MIC] Voice Reply (G2 Mic)' })
  opts.push({ kind: 'back', label: '<- Back to Inbox' })
  return opts
}

function ageLabel(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h`
}

function platformTag(p: WireMessage['platform']): string {
  if (p === 'telegram') return 'TG'
  if (p === 'slack') return 'SLK'
  if (p === 'discord') return 'DSC'
  return 'NEWS'
}

function vuBar(rms: number, width = 10): string {
  const filled = Math.min(width, Math.max(0, Math.round(rms * width)))
  return `[${'|'.repeat(filled)}${'.'.repeat(width - filled)}]`
}

export function renderHud(state: AppState): HudFrame {
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

  if (state.screen === 'inbox') {
    const list = visibleMessages(state)
    const current = list[state.selectedIdx]
    const unread = unreadCount(state)

    if (!current) {
      return {
        header: `BLINKWIRE | UNREAD:${unread} | ${clock}`,
        body: [
          state.filter === 'all' ? 'NO LIVE MESSAGES YET' : `NO ${state.filter.toUpperCase()} MESSAGES`,
          state.botUsername
            ? `Telegram live: @${clip(state.botUsername, 22, 'bot')}`
            : 'Add TELEGRAM_BOT_TOKEN in Companion',
          'Send a text or voice note to your bot.',
        ].join('\n'),
        footer: 'TAP:refresh | 2x:exit',
      }
    }

    const doneTag = state.repliedIds.includes(current.id) ? ' [DONE]' : ''
    const header = `[${platformTag(current.platform)}] ${state.selectedIdx + 1}/${list.length} ${current.urgency} U:${unread} ${clock}`
    const body = [
      `${clip(current.chatLabel, 20, 'Chat')} (${ageLabel(current.timestamp)})${doneTag}`,
      `From: ${clip(current.sender, 30, 'Contact')}`,
      wrapLines(current.text, 38, 4),
    ].join('\n')

    const footer = current.replyable ? 'SWIPE:msg | TAP:reply | 2x:exit' : 'SWIPE:msg | TAP:sync | 2x:exit'
    return { header, body, footer }
  }

  if (state.screen === 'reply_pick' && state.activeMessage) {
    const target = state.activeMessage
    const tag = state.draftSource === 'ai' ? 'AI' : state.draftSource === 'loading' ? 'AI...' : 'QUICK'
    const opts = getReplyOptions(state)
    const maxVisible = 5
    const start = Math.max(0, Math.min(state.optionIdx - 2, Math.max(0, opts.length - maxVisible)))
    const rows = opts.slice(start, start + maxVisible).map((o, offset) => {
      const idx = start + offset
      return `${idx === state.optionIdx ? '>' : ' '} ${o.label}`
    })

    return {
      header: `REPLY [${tag}] ${clip(target.chatLabel, 14, 'Chat')} ${clock}`,
      body: [clip(state.draftSummary || target.text, 38, '[Media/Emoji]'), ...rows].join('\n'),
      footer: 'SWIPE:pick | TAP:arm | 2x:back',
    }
  }

  if (state.screen === 'voice_capture' && state.activeMessage) {
    const secs = Math.min(15, Math.max(0, Math.floor((Date.now() - state.voiceStartedAt) / 1000)))
    return {
      header: `[MIC] REC ${secs}s/15s ${vuBar(state.voiceRms)}`,
      body: [
        `To: ${clip(state.activeMessage.chatLabel, 32, 'Contact')}`,
        'Speak short reply now...',
        '16kHz PCM -> Whisper -> 2-Tap Confirm',
      ].join('\n'),
      footer: 'TAP:stop & arm | SWIPE:cancel',
    }
  }

  if (state.screen === 'confirm_send' && state.armed) {
    const remain = Math.max(0, Math.ceil((state.armed.expiresAt - Date.now()) / 1000))
    const target = state.armed.target
    const preview =
      state.armed.kind === 'reaction'
        ? 'Send Telegram Thumbs-Up reaction'
        : `"${state.armed.text}"`
    return {
      header: `[!] CONFIRM (${remain}s) [${platformTag(target.platform)}]`,
      body: [
        `TO: ${clip(target.chatLabel, 33, 'Contact')}`,
        wrapLines(preview, 38, 3),
        '2-tap guard active (server armToken).',
      ].join('\n'),
      footer: 'TAP:send live | SWIPE:cancel',
    }
  }

  return {
    header: `BLINKWIRE RECEIPT | ${clock}`,
    body: wrapLines(state.receiptText || 'Done.', 38, 5),
    footer: 'TAP:inbox | 2x:back',
  }
}
