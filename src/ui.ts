import type { HealthInfo, WireConfig } from './client/api'
import type { G2Gesture, HudFrame } from './g2/bridge'
import type { AuditEntry, InboxFilter } from './state'

export interface CompanionHandlers {
  onSaveConfig: (cfg: WireConfig) => void
  onClearKeys: () => void
  onPollNow: () => void
  onVerifyTelegram: (clearWebhook: boolean, overrides?: { telegramToken?: string; relayUrl?: string }) => void
  onFilterChange: (filter: InboxFilter) => void
  onGesture: (g: G2Gesture) => void
  onSimulateVoiceText: (text: string) => void
  onBrowserMicToggle: () => void
}

const DEFAULT_SECRET_PLACEHOLDERS: Record<string, string> = {
  telegramToken: '123456:ABC-DEF...',
  openRouterKey: 'sk-or-v1-...',
  groqKey: 'gsk_...',
  openAiKey: 'sk-...',
  slackToken: 'xoxb-...',
  discordToken: 'MT...',
}

let hudHeaderEl: HTMLElement
let hudBodyEl: HTMLElement
let hudFooterEl: HTMLElement
let statusChipEl: HTMLElement
let envRowEl: HTMLElement
let verifyOutEl: HTMLElement
let auditListEl: HTMLElement
let errorBannerEl: HTMLElement
let browserMicBtnEl: HTMLButtonElement

export function mountCompanionUi(
  getConfig: () => WireConfig,
  mode: 'glasses' | 'browser-preview',
  handlers: CompanionHandlers,
): void {
  const initialConfig = getConfig()
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
          <div class="tabs">
            <button data-f="all" class="btn-ghost active-tab" type="button">All</button>
            <button data-f="unread" class="btn-ghost" type="button">Unread</button>
            <button data-f="telegram" class="btn-ghost" type="button">Telegram Only</button>
          </div>
          <button id="btnPoll" class="btn-ghost" type="button">Poll Live</button>
        </div>
        <div id="envRow" class="env-row"></div>
        <div class="g2-screen" aria-live="polite">
          <pre id="hudHeader" class="g2-header"></pre>
          <pre id="hudBody" class="g2-body"></pre>
          <pre id="hudFooter" class="g2-footer"></pre>
        </div>
        <div class="controls">
          <button data-g="swipe_up" class="btn" type="button">Swipe Up</button>
          <button data-g="swipe_down" class="btn" type="button">Swipe Down</button>
          <button data-g="tap" class="btn btn-primary" type="button">Single Tap</button>
          <button data-g="double_tap" class="btn btn-danger" type="button">Double-Tap</button>
        </div>
        <p class="hint">Keys: Up/Down swipe · Enter/Space tap · Esc back/exit · Exact 576x288 proportional G2 preview</p>
      </section>

      <div id="errorBanner" class="error-banner" hidden></div>

      <section class="card">
        <div class="row-between">
          <h2>Telegram Diagnostics & Live Credentials</h2>
          <div class="tabs">
            <button id="btnVerifyTg" class="btn-ghost" type="button">Verify Bot</button>
            <button id="btnClearWh" class="btn-ghost" type="button">Clear Webhook</button>
          </div>
        </div>
        <div id="verifyOut" class="verify-box" hidden></div>
        <p class="sub">Browser-entered secrets stay in <code>sessionStorage</code> only (never persisted to disk). Or set in <code>.env.local</code>.</p>
        <form id="cfgForm" class="grid">
          <label>Telegram Bot Token (@BotFather)
            <input name="telegramToken" type="password" value="" placeholder="${initialConfig.telegramToken ? 'Loaded in session' : '123456:ABC-DEF...'}" />
          </label>
          <label>OpenRouter API Key (AI Quick Replies)
            <input name="openRouterKey" type="password" value="" placeholder="${initialConfig.openRouterKey ? 'Loaded in session' : 'sk-or-v1-...'}" />
          </label>
          <label>OpenRouter Model
            <input name="openRouterModel" type="text" value="${esc(initialConfig.openRouterModel)}" placeholder="openai/gpt-4o-mini" />
          </label>
          <label>Groq API Key (Whisper STT + Voice Notes)
            <input name="groqKey" type="password" value="" placeholder="${initialConfig.groqKey ? 'Loaded in session' : 'gsk_...'}" />
          </label>
          <label>OpenAI API Key (Fallback LLM + Whisper)
            <input name="openAiKey" type="password" value="" placeholder="${initialConfig.openAiKey ? 'Loaded in session' : 'sk-...'}" />
          </label>
          <label>Slack Bot Token (Optional)
            <input name="slackToken" type="password" value="" placeholder="${initialConfig.slackToken ? 'Loaded in session' : 'xoxb-...'}" />
          </label>
          <label>Slack Channel ID
            <input name="slackChannelId" type="text" value="${esc(initialConfig.slackChannelId)}" placeholder="C01234567" />
          </label>
          <label>Discord Bot Token (Optional)
            <input name="discordToken" type="password" value="" placeholder="${initialConfig.discordToken ? 'Loaded in session' : 'MT...'}" />
          </label>
          <label>Discord Channel ID
            <input name="discordChannelId" type="text" value="${esc(initialConfig.discordChannelId)}" placeholder="1234567890" />
          </label>
          <label>Custom Relay URL
            <input name="relayUrl" type="text" value="${esc(initialConfig.relayUrl)}" placeholder="blank = same origin /api" />
          </label>
          <label class="checkbox-row">
            <input name="includeNews" type="checkbox" ${initialConfig.includeNews ? 'checked' : ''} />
            Include live Hacker News headlines
          </label>
          <div class="actions-row">
            <button id="btnClearKeys" type="button" class="btn">Clear Session Keys</button>
            <button type="submit" class="btn btn-primary">Save & Poll Live</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>Voice Reply Test (Real Browser Mic -> WAV -> Whisper OR Text Arm)</h2>
        <div class="inline-row">
          <button id="btnBrowserMic" class="btn btn-primary" type="button">Record Browser Mic</button>
          <input id="simVoiceInput" type="text" placeholder="Or type a reply to arm 2-tap confirm..." />
          <button id="btnSimVoice" class="btn" type="button">Arm Reply</button>
        </div>
      </section>

      <section class="card">
        <h2>Executed Write Audit Log (Persisted)</h2>
        <ul id="auditList" class="audit-list">
          <li class="muted">No messages sent yet. Every write requires server-issued 2-tap armToken.</li>
        </ul>
      </section>
    </main>
  `

  injectStyles()

  hudHeaderEl = root.querySelector('#hudHeader')!
  hudBodyEl = root.querySelector('#hudBody')!
  hudFooterEl = root.querySelector('#hudFooter')!
  statusChipEl = root.querySelector('#statusChip')!
  envRowEl = root.querySelector('#envRow')!
  verifyOutEl = root.querySelector('#verifyOut')!
  auditListEl = root.querySelector('#auditList')!
  errorBannerEl = root.querySelector('#errorBanner')!
  browserMicBtnEl = root.querySelector('#btnBrowserMic')!

  const form = root.querySelector<HTMLFormElement>('#cfgForm')!
  const resetPasswordFields = (cfgSnapshot: WireConfig) => {
    for (const [name, defaultHint] of Object.entries(DEFAULT_SECRET_PLACEHOLDERS)) {
      const inp = form.querySelector<HTMLInputElement>(`input[name="${name}"]`)
      if (!inp) continue
      inp.value = ''
      inp.placeholder = cfgSnapshot[name as keyof WireConfig] ? 'Loaded in session' : defaultHint
    }
  }

  root.querySelector('#btnPoll')!.addEventListener('click', handlers.onPollNow)
  root.querySelector('#btnClearKeys')!.addEventListener('click', () => {
    for (const [name, defaultHint] of Object.entries(DEFAULT_SECRET_PLACEHOLDERS)) {
      const inp = form.querySelector<HTMLInputElement>(`input[name="${name}"]`)
      if (!inp) continue
      inp.value = ''
      inp.placeholder = defaultHint
    }
    handlers.onClearKeys()
  })
  const readLiveVerifyOverrides = () => ({
    telegramToken: form.querySelector<HTMLInputElement>('input[name="telegramToken"]')?.value.trim() || '',
    relayUrl: form.querySelector<HTMLInputElement>('input[name="relayUrl"]')?.value.trim() || '',
  })
  root.querySelector('#btnVerifyTg')!.addEventListener('click', () => handlers.onVerifyTelegram(false, readLiveVerifyOverrides()))
  root.querySelector('#btnClearWh')!.addEventListener('click', () => handlers.onVerifyTelegram(true, readLiveVerifyOverrides()))
  browserMicBtnEl.addEventListener('click', handlers.onBrowserMicToggle)

  root.querySelectorAll<HTMLButtonElement>('[data-g]').forEach(btn => {
    btn.addEventListener('click', () => handlers.onGesture(btn.dataset.g as G2Gesture))
  })
  root.querySelectorAll<HTMLButtonElement>('[data-f]').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('[data-f]').forEach(b => b.classList.remove('active-tab'))
      btn.classList.add('active-tab')
      handlers.onFilterChange(btn.dataset.f as InboxFilter)
    })
  })

  form.addEventListener('submit', e => {
    e.preventDefault()
    const current = getConfig()
    const fd = new FormData(form)
    const pick = (name: keyof WireConfig): string => {
      const val = String(fd.get(name) || '').trim()
      return val || String(current[name] || '')
    }
    const next: WireConfig = {
      relayUrl: String(fd.get('relayUrl') || '').trim(),
      telegramToken: pick('telegramToken'),
      slackToken: pick('slackToken'),
      slackChannelId: String(fd.get('slackChannelId') || '').trim(),
      discordToken: pick('discordToken'),
      discordChannelId: String(fd.get('discordChannelId') || '').trim(),
      openRouterKey: pick('openRouterKey'),
      openRouterModel: String(fd.get('openRouterModel') || 'openai/gpt-4o-mini').trim(),
      openAiKey: pick('openAiKey'),
      groqKey: pick('groqKey'),
      includeNews: fd.get('includeNews') === 'on',
    }
    resetPasswordFields(next)
    handlers.onSaveConfig(next)
  })

  const voiceInput = root.querySelector<HTMLInputElement>('#simVoiceInput')!
  const triggerTextArm = () => {
    const val = voiceInput.value.trim()
    if (!val) return
    voiceInput.value = ''
    handlers.onSimulateVoiceText(val)
  }
  root.querySelector('#btnSimVoice')!.addEventListener('click', triggerTextArm)
  voiceInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      triggerTextArm()
    }
  })
}

export function updateHudPreview(frame: HudFrame): void {
  if (!hudHeaderEl) return
  hudHeaderEl.textContent = frame.header
  hudBodyEl.textContent = frame.body
  hudFooterEl.textContent = frame.footer
}

export function setBrowserMicRecording(recording: boolean): void {
  if (!browserMicBtnEl) return
  browserMicBtnEl.textContent = recording ? 'Stop & Transcribe' : 'Record Browser Mic'
  browserMicBtnEl.className = recording ? 'btn btn-danger' : 'btn btn-primary'
}

export function updateHealthPills(health: HealthInfo | null): void {
  if (!envRowEl || !health) return
  const map: Array<[string, boolean]> = [
    ['TG .env', health.envConfigured.telegram],
    ['Slack .env', health.envConfigured.slack],
    ['Discord .env', health.envConfigured.discord],
    ['AI .env', health.envConfigured.ai],
    ['STT .env', health.envConfigured.stt],
  ]
  envRowEl.innerHTML = map
    .map(([label, ok]) => `<span class="vpill ${ok ? 'v-ok' : 'v-off'}">${esc(label)}</span>`)
    .join('')
}

export function showVerifyResult(text: string, isError = false): void {
  if (!verifyOutEl) return
  verifyOutEl.hidden = false
  verifyOutEl.className = `verify-box ${isError ? 'verify-err' : 'verify-ok'}`
  verifyOutEl.textContent = text
}

export function updateCompanionStatus(
  label: string,
  mode: 'glasses' | 'browser-preview',
  errors: Record<string, string>,
  audit: AuditEntry[],
): void {
  if (statusChipEl && label) {
    statusChipEl.textContent = label
    statusChipEl.className = `chip ${mode === 'glasses' ? 'chip-live' : 'chip-preview'}`
  }
  if (errorBannerEl) {
    const pairs = Object.entries(errors)
    errorBannerEl.hidden = pairs.length === 0
    errorBannerEl.textContent = pairs.map(([k, v]) => `${k.toUpperCase()}: ${v}`).join(' | ')
  }
  if (auditListEl) {
    auditListEl.innerHTML =
      audit.length === 0
        ? '<li class="muted">No messages sent yet. Every write requires server-issued 2-tap armToken.</li>'
        : audit
            .map(
              a =>
                `<li><span class="${a.status === 'SENT' ? 'ok' : 'err'}">[${a.status}]</span> <strong>${esc(a.platform.toUpperCase())}</strong> -> ${esc(a.target)}: "${esc(a.text)}" <span class="muted">(${esc(a.time)} · ${esc(a.detail)})</span></li>`,
            )
            .join('')
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
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none;
    }
    .shell { max-width: 780px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
    .topbar, .row-between, .hud-meta { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 20px; display: flex; align-items: center; gap: 8px; }
    h2 { margin: 0 0 8px; font-size: 15px; }
    .sub { margin: 2px 0 6px; color: #9A9A9A; font-size: 12px; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(60,250,68,0.14); color: #3CFA44; border: 1px solid rgba(60,250,68,0.35); }
    .chip { font-size: 11px; padding: 5px 10px; border-radius: 999px; letter-spacing: 0.04em; white-space: nowrap; }
    .chip-live { color: #3CFA44; border: 1px solid #3CFA44; background: rgba(60,250,68,0.08); }
    .chip-preview { color: #E5E5E5; border: 1px solid #555; background: #2E2E2E; }
    .hud-card, .card { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 16px; }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .active-tab { border-color: #3CFA44 !important; color: #3CFA44 !important; }
    .env-row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 10px; }
    .vpill { font-size: 11px; padding: 2px 7px; border-radius: 6px; border: 1px solid #444; }
    .v-ok { color: #3CFA44; border-color: rgba(60,250,68,0.4); background: rgba(60,250,68,0.08); }
    .v-off { color: #888; background: #262626; }
    .g2-screen {
      width: 100%; max-width: 576px; height: 288px; overflow: hidden; margin: 0 auto;
      background: #081208; border: 2px solid #204A22; border-radius: 10px; padding: 8px 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      color: #3CFA44; text-shadow: 0 0 6px rgba(60,250,68,0.35);
      display: flex; flex-direction: column; justify-content: space-between;
    }
    .g2-header, .g2-body, .g2-footer { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; }
    .g2-header { font-size: 14px; line-height: 24px; height: 28px; overflow: hidden; border-bottom: 1px solid rgba(60,250,68,0.22); }
    .g2-body { font-size: 15px; line-height: 26px; flex: 1; overflow: hidden; padding: 4px 0; }
    .g2-footer { font-size: 13px; line-height: 24px; height: 28px; overflow: hidden; opacity: 0.85; border-top: 1px solid rgba(60,250,68,0.22); }
    .controls { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 12px; }
    .hint { text-align: center; font-size: 11px; color: #888; margin: 8px 0 0; }
    .btn, .btn-ghost { background: #383838; color: #E5E5E5; border: 1px solid #4A4A4A; border-radius: 8px; padding: 8px 12px; font-size: 13px; cursor: pointer; }
    .btn-ghost { padding: 4px 10px; font-size: 12px; }
    .btn-primary { background: rgba(60,250,68,0.16); border-color: #3CFA44; color: #3CFA44; font-weight: 600; }
    .btn-danger { background: rgba(255,69,58,0.14); border-color: #FF453A; color: #FF7870; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-top: 8px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #BDBDBD; }
    input[type="text"], input[type="password"] { background: #1F1F1F; color: #E5E5E5; border: 1px solid #444; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    .checkbox-row { flex-direction: row; align-items: center; gap: 8px; grid-column: 1 / -1; }
    .actions-row { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
    .inline-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .inline-row input { flex: 1; min-width: 180px; }
    .error-banner { background: rgba(255,69,58,0.14); border: 1px solid #FF453A; color: #FF9A94; border-radius: 10px; padding: 10px 14px; font-size: 12px; }
    .verify-box { margin: 8px 0; padding: 8px 12px; border-radius: 8px; font-size: 12px; }
    .verify-ok { background: rgba(60,250,68,0.1); border: 1px solid rgba(60,250,68,0.4); color: #8DFB92; }
    .verify-err { background: rgba(255,69,58,0.12); border: 1px solid #FF453A; color: #FF9A94; }
    .audit-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    .ok { color: #3CFA44; font-weight: 600; }
    .err { color: #FF453A; font-weight: 600; }
    .muted { color: #8A8A8A; }
  `
  document.head.appendChild(style)
}
