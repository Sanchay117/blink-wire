import type { WireConfig } from './client/api'
import type { G2Gesture, HudFrame } from './g2/bridge'
import type { AuditEntry } from './state'

export interface CompanionHandlers {
  onSaveConfig: (cfg: WireConfig) => void
  onPollNow: () => void
  onGesture: (g: G2Gesture) => void
  onSimulateVoiceText: (text: string) => void
}

let hudHeaderEl: HTMLElement
let hudBodyEl: HTMLElement
let hudFooterEl: HTMLElement
let statusChipEl: HTMLElement
let auditListEl: HTMLElement
let errorBannerEl: HTMLElement

export function mountCompanionUi(
  initialConfig: WireConfig,
  mode: 'glasses' | 'browser-preview',
  handlers: CompanionHandlers,
): void {
  const root = document.querySelector<HTMLDivElement>('#app')!
  root.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div>
          <h1>BlinkWire <span class="badge">G2 HUD</span></h1>
          <p class="sub">Track 1: Messaging & News · Best Telegram Integration</p>
        </div>
        <span id="statusChip" class="chip ${mode === 'glasses' ? 'chip-live' : 'chip-preview'}">
          ${mode === 'glasses' ? 'G2 BRIDGE LIVE' : 'BROWSER HUD MIRROR'}
        </span>
      </header>

      <section class="hud-card">
        <div class="hud-meta">
          <span>Even G2 · 576 × 288 Monochrome Preview</span>
          <button id="btnPoll" class="btn-ghost" type="button">↻ Poll Live</button>
        </div>
        <div class="g2-screen" aria-live="polite">
          <pre id="hudHeader" class="g2-header"></pre>
          <pre id="hudBody" class="g2-body"></pre>
          <pre id="hudFooter" class="g2-footer"></pre>
        </div>
        <div class="controls">
          <button data-g="swipe_up" class="btn" type="button">▲ Swipe Up</button>
          <button data-g="swipe_down" class="btn" type="button">▼ Swipe Down</button>
          <button data-g="tap" class="btn btn-primary" type="button">● Single Tap</button>
          <button data-g="double_tap" class="btn btn-danger" type="button">✕ Double-Tap Exit</button>
        </div>
        <p class="hint">Keyboard shortcuts: ↑ / ↓ swipe · Enter/Space tap · Esc double-tap</p>
      </section>

      <div id="errorBanner" class="error-banner" hidden></div>

      <section class="card">
        <h2>Live Account Credentials (Zero Mocks)</h2>
        <p class="sub">Saved locally in browser storage; sent only to your local relay server. Or populate <code>.env.local</code>.</p>
        <form id="cfgForm" class="grid">
          <label>Telegram Bot Token (@BotFather)
            <input name="telegramToken" type="password" value="${esc(initialConfig.telegramToken)}" placeholder="123456:ABC-DEF..." />
          </label>
          <label>OpenRouter API Key (AI Quick Replies)
            <input name="openRouterKey" type="password" value="${esc(initialConfig.openRouterKey)}" placeholder="sk-or-v1-..." />
          </label>
          <label>OpenRouter Model
            <input name="openRouterModel" type="text" value="${esc(initialConfig.openRouterModel)}" placeholder="openai/gpt-4o-mini" />
          </label>
          <label>Groq API Key (Fast Whisper STT)
            <input name="groqKey" type="password" value="${esc(initialConfig.groqKey)}" placeholder="gsk_..." />
          </label>
          <label>OpenAI API Key (Fallback LLM + Whisper)
            <input name="openAiKey" type="password" value="${esc(initialConfig.openAiKey)}" placeholder="sk-..." />
          </label>
          <label>Slack Bot Token (Optional)
            <input name="slackToken" type="password" value="${esc(initialConfig.slackToken)}" placeholder="xoxb-..." />
          </label>
          <label>Slack Channel ID (Optional)
            <input name="slackChannelId" type="text" value="${esc(initialConfig.slackChannelId)}" placeholder="C01234567" />
          </label>
          <label>Discord Bot Token (Optional)
            <input name="discordToken" type="password" value="${esc(initialConfig.discordToken)}" placeholder="MT..." />
          </label>
          <label>Discord Channel ID (Optional)
            <input name="discordChannelId" type="text" value="${esc(initialConfig.discordChannelId)}" placeholder="1234567890" />
          </label>
          <label>Custom Relay URL (For Phone Sideloading)
            <input name="relayUrl" type="text" value="${esc(initialConfig.relayUrl)}" placeholder="blank = same origin /api" />
          </label>
          <label class="checkbox-row">
            <input name="includeNews" type="checkbox" ${initialConfig.includeNews ? 'checked' : ''} />
            Include live Hacker News headlines in feed
          </label>
          <div class="actions-row">
            <button type="submit" class="btn btn-primary">Save & Poll Live Accounts</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>Voice Reply Test (When No G2 Mic Attached)</h2>
        <div class="inline-row">
          <input id="simVoiceInput" type="text" placeholder="Type spoken reply to arm 2-tap confirm…" />
          <button id="btnSimVoice" class="btn" type="button">Arm Reply</button>
        </div>
      </section>

      <section class="card">
        <h2>Executed Write Audit Log</h2>
        <ul id="auditList" class="audit-list">
          <li class="muted">No messages sent yet. Every send requires 2-tap safety confirmation.</li>
        </ul>
      </section>
    </main>
  `

  injectStyles()

  hudHeaderEl = root.querySelector('#hudHeader')!
  hudBodyEl = root.querySelector('#hudBody')!
  hudFooterEl = root.querySelector('#hudFooter')!
  statusChipEl = root.querySelector('#statusChip')!
  auditListEl = root.querySelector('#auditList')!
  errorBannerEl = root.querySelector('#errorBanner')!

  root.querySelector('#btnPoll')!.addEventListener('click', () => handlers.onPollNow())

  root.querySelectorAll<HTMLButtonElement>('[data-g]').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.g as G2Gesture
      handlers.onGesture(g)
    })
  })

  const form = root.querySelector<HTMLFormElement>('#cfgForm')!
  form.addEventListener('submit', e => {
    e.preventDefault()
    const fd = new FormData(form)
    const next: WireConfig = {
      relayUrl: String(fd.get('relayUrl') || '').trim(),
      telegramToken: String(fd.get('telegramToken') || '').trim(),
      slackToken: String(fd.get('slackToken') || '').trim(),
      slackChannelId: String(fd.get('slackChannelId') || '').trim(),
      discordToken: String(fd.get('discordToken') || '').trim(),
      discordChannelId: String(fd.get('discordChannelId') || '').trim(),
      openRouterKey: String(fd.get('openRouterKey') || '').trim(),
      openRouterModel: String(fd.get('openRouterModel') || 'openai/gpt-4o-mini').trim(),
      openAiKey: String(fd.get('openAiKey') || '').trim(),
      groqKey: String(fd.get('groqKey') || '').trim(),
      includeNews: fd.get('includeNews') === 'on',
    }
    handlers.onSaveConfig(next)
  })

  const voiceInput = root.querySelector<HTMLInputElement>('#simVoiceInput')!
  root.querySelector('#btnSimVoice')!.addEventListener('click', () => {
    const val = voiceInput.value.trim()
    if (!val) return
    voiceInput.value = ''
    handlers.onSimulateVoiceText(val)
  })
}

export function updateHudPreview(frame: HudFrame): void {
  if (!hudHeaderEl) return
  hudHeaderEl.textContent = frame.header
  hudBodyEl.textContent = frame.body
  hudFooterEl.textContent = frame.footer
}

export function updateCompanionStatus(label: string, errors: Record<string, string>, audit: AuditEntry[]): void {
  if (statusChipEl && label) statusChipEl.textContent = label
  if (errorBannerEl) {
    const pairs = Object.entries(errors)
    if (pairs.length === 0) {
      errorBannerEl.hidden = true
      errorBannerEl.textContent = ''
    } else {
      errorBannerEl.hidden = false
      errorBannerEl.textContent = pairs.map(([k, v]) => `${k.toUpperCase()}: ${v}`).join(' · ')
    }
  }
  if (auditListEl) {
    if (audit.length === 0) {
      auditListEl.innerHTML =
        '<li class="muted">No messages sent yet. Every send requires 2-tap safety confirmation.</li>'
    } else {
      auditListEl.innerHTML = audit
        .map(
          a =>
            `<li><span class="${a.status === 'SENT' ? 'ok' : 'err'}">[${a.status}]</span> <strong>${esc(a.platform.toUpperCase())}</strong> → ${esc(a.target)}: "${esc(a.text)}" <span class="muted">(${esc(a.time)} · ${esc(a.detail)})</span></li>`,
        )
        .join('')
    }
  }
}

function esc(str: string): string {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c)
}

function injectStyles(): void {
  const style = document.createElement('style')
  style.textContent = `
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; min-height: 100%; background: #232323; color: #E5E5E5;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none;
    }
    .shell { max-width: 760px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
    .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    h1 { margin: 0; font-size: 20px; display: flex; align-items: center; gap: 8px; }
    h2 { margin: 0 0 8px; font-size: 15px; }
    .sub { margin: 2px 0 0; color: #9A9A9A; font-size: 12px; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(60,250,68,0.14); color: #3CFA44; border: 1px solid rgba(60,250,68,0.35); }
    .chip { font-size: 11px; padding: 5px 10px; border-radius: 999px; letter-spacing: 0.04em; white-space: nowrap; }
    .chip-live { color: #3CFA44; border: 1px solid #3CFA44; background: rgba(60,250,68,0.08); }
    .chip-preview { color: #E5E5E5; border: 1px solid #555; background: #2E2E2E; }
    .hud-card, .card { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 16px; }
    .hud-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 12px; color: #9A9A9A; }
    .g2-screen {
      width: 100%; max-width: 576px; min-height: 288px; margin: 0 auto;
      background: #081208; border: 2px solid #204A22; border-radius: 10px; padding: 10px 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #3CFA44; text-shadow: 0 0 6px rgba(60,250,68,0.35);
      display: flex; flex-direction: column; justify-content: space-between; gap: 8px;
    }
    .g2-header, .g2-body, .g2-footer { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; }
    .g2-header { font-size: 12px; opacity: 0.9; border-bottom: 1px solid rgba(60,250,68,0.22); padding-bottom: 4px; }
    .g2-body { font-size: 14px; line-height: 1.45; flex: 1; padding: 4px 0; }
    .g2-footer { font-size: 11px; opacity: 0.8; border-top: 1px solid rgba(60,250,68,0.22); padding-top: 4px; }
    .controls { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 12px; }
    .hint { text-align: center; font-size: 11px; color: #888; margin: 8px 0 0; }
    .btn, .btn-ghost {
      background: #383838; color: #E5E5E5; border: 1px solid #4A4A4A; border-radius: 8px;
      padding: 8px 12px; font-size: 13px; cursor: pointer;
    }
    .btn:hover, .btn-ghost:hover { background: #444; }
    .btn-ghost { padding: 4px 10px; font-size: 12px; }
    .btn-primary { background: rgba(60,250,68,0.16); border-color: #3CFA44; color: #3CFA44; font-weight: 600; }
    .btn-danger { background: rgba(255,69,58,0.14); border-color: #FF453A; color: #FF7870; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-top: 10px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #BDBDBD; }
    input[type="text"], input[type="password"] {
      background: #1F1F1F; color: #E5E5E5; border: 1px solid #444; border-radius: 8px; padding: 8px 10px; font-size: 13px;
    }
    .checkbox-row { flex-direction: row; align-items: center; gap: 8px; grid-column: 1 / -1; }
    .actions-row { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
    .inline-row { display: flex; gap: 8px; }
    .inline-row input { flex: 1; }
    .error-banner { background: rgba(255,69,58,0.14); border: 1px solid #FF453A; color: #FF9A94; border-radius: 10px; padding: 10px 14px; font-size: 12px; }
    .audit-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    .ok { color: #3CFA44; font-weight: 600; }
    .err { color: #FF453A; font-weight: 600; }
    .muted { color: #8A8A8A; }
  `
  document.head.appendChild(style)
}
