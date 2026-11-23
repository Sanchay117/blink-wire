import type { WireMessage } from './client/api'
import type { HudFrame } from './g2/bridge'

export type Screen = 'inbox' | 'reply_pick' | 'voice_capture' | 'confirm_send' | 'receipt'

export interface AuditEntry {
  time: string
  platform: string
  target: string
  text: string
  status: 'SENT' | 'ERROR'
  detail: string
}

export interface AppState {
  screen: Screen
  messages: WireMessage[]
  selectedIdx: number
  drafts: string[]
  draftSource: 'ai' | 'rule' | 'loading'
  draftSummary: string
  optionIdx: number // 0..2 = drafts, 3 = voice reply, 4 = back
  pendingReplyText: string
  armExpiresAt: number
  voiceChunks: Uint8Array[]
  voiceStartedAt: number
  receiptText: string
  botUsername: string
  errors: Record<string, string>
  auditLog: AuditEntry[]
  lastPollAt: number
}

export function createInitialState(): AppState {
  return {
    screen: 'inbox',
    messages: [],
    selectedIdx: 0,
    drafts: [],
    draftSource: 'rule',
    draftSummary: '',
    optionIdx: 0,
    pendingReplyText: '',
    armExpiresAt: 0,
    voiceChunks: [],
    voiceStartedAt: 0,
    receiptText: '',
    botUsername: '',
    errors: {},
    auditLog: [],
    lastPollAt: 0,
  }
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

function wrapLines(text: string, lineWidth = 44, maxLines = 4): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    const next = current ? `${current} ${w}` : w
    if (next.length <= lineWidth) {
      current = next
    } else {
      if (current) lines.push(current)
      current = w.slice(0, lineWidth)
      if (lines.length === maxLines - 1) break
    }
  }
  if (current && lines.length < maxLines) lines.push(current)
  return lines.join('\n')
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

export function renderHud(state: AppState): HudFrame {
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const current = state.messages[state.selectedIdx]

  if (state.screen === 'inbox') {
    if (!current) {
      return {
        header: `BLINKWIRE  ·  LIVE TRIAGE              ${clock}`,
        body: [
          'NO LIVE MESSAGES YET',
          '',
          state.botUsername
            ? `Telegram connected: @${state.botUsername}`
            : 'Add TELEGRAM_BOT_TOKEN in Companion panel',
          'Send a message to your bot — appears here live.',
        ].join('\n'),
        footer: 'TAP: refresh  ·  2xTAP: exit',
      }
    }

    const header = `BLINKWIRE [${platformTag(current.platform)}] ${state.selectedIdx + 1}/${state.messages.length}  ${current.urgency}   ${clock}`
    const body = [
      `${clip(current.chatLabel, 28)}  (${ageLabel(current.timestamp)} ago)`,
      `From: ${clip(current.sender, 36)}`,
      '--------------------------------------------',
      wrapLines(current.text, 44, 4),
    ].join('\n')

    const footer = current.replyable
      ? 'SWIPE: next/prev  ·  TAP: quick reply  ·  2xTAP: exit'
      : 'SWIPE: next/prev  ·  TAP: refresh  ·  2xTAP: exit'

    return { header, body, footer }
  }

  if (state.screen === 'reply_pick' && current) {
    const tag = state.draftSource === 'loading' ? 'DRAFTING…' : state.draftSource === 'ai' ? 'AI DRAFTS' : 'QUICK REPLIES'
    const options = [
      ...(state.drafts.length ? state.drafts : ['Loading drafts…']),
      '🎙 Voice reply (G2 mic)',
      '← Back to inbox',
    ]
    const lines = options.map((opt, idx) => {
      const marker = idx === state.optionIdx ? '▶' : ' '
      return `${marker} ${clip(opt, 41)}`
    })

    return {
      header: `REPLY → ${clip(current.chatLabel, 20)} [${tag}]  ${clock}`,
      body: [clip(state.draftSummary || current.text, 44), '--------------------------------------------', ...lines].join('\n'),
      footer: 'SWIPE: pick  ·  TAP: arm/select  ·  2xTAP: exit',
    }
  }

  if (state.screen === 'voice_capture' && current) {
    const secs = Math.max(0, Math.floor((Date.now() - state.voiceStartedAt) / 1000))
    const kb = Math.round(state.voiceChunks.reduce((sum, c) => sum + c.byteLength, 0) / 1024)
    return {
      header: `🎙 RECORDING VOICE REPLY   ${secs}s  (${kb}KB)`,
      body: [
        `To: ${clip(current.chatLabel, 36)}`,
        '',
        'Speak a short reply now…',
        'Audio streams live from G2 16kHz mic.',
      ].join('\n'),
      footer: 'TAP: stop & transcribe  ·  SWIPE: cancel',
    }
  }

  if (state.screen === 'confirm_send' && current) {
    const remain = Math.max(0, Math.ceil((state.armExpiresAt - Date.now()) / 1000))
    return {
      header: `⚠ CONFIRM SEND (${remain}s)  [${platformTag(current.platform)}]`,
      body: [
        `TO: ${clip(current.chatLabel, 38)}`,
        '--------------------------------------------',
        wrapLines(`"${state.pendingReplyText}"`, 44, 3),
        '',
        '2-TAP SAFETY GUARD: Prevents accidental sends.',
      ].join('\n'),
      footer: 'TAP NOW: send live  ·  SWIPE: cancel',
    }
  }

  return {
    header: `BLINKWIRE  ·  DELIVERY RECEIPT         ${clock}`,
    body: wrapLines(state.receiptText || 'Done.', 44, 5),
    footer: 'TAP: return to inbox  ·  2xTAP: exit',
  }
}
