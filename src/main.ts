import {
  apiBase,
  armReplyOnServer,
  clearSessionSecrets,
  fetchDrafts,
  fetchHealth,
  loadConfig,
  pollInbox,
  saveConfig,
  sendArmedReply,
  sendTelegramPresence,
  transcribeVoice,
  verifyTelegramBot,
  type WireConfig,
  type WireMessage,
} from './client/api'
import { createG2Controller, type G2Controller, type G2Gesture } from './g2/bridge'
import { computePcm16Rms, encodePcm16kToWavBase64 } from './g2/wav'
import {
  createInitialState,
  getReplyOptions,
  persistTriageState,
  renderHud,
  visibleMessages,
} from './state'
import {
  mountCompanionUi,
  setBrowserMicRecording,
  showVerifyResult,
  updateCompanionStatus,
  updateHealthPills,
  updateHudPreview,
} from './ui'

let config: WireConfig = loadConfig()
const state = createInitialState()
let g2: G2Controller | null = null
let armTicker: number | null = null
let voiceTicker: number | null = null
let pollInterval: number | null = null
let prefetchTimer: number | null = null
let isPolling = false
let isSending = false
let foregroundActive = true
let draftReqSeq = 0
let batteryLevel: number | undefined

const MAX_PCM_BYTES = 15 * 16000 * 2 // 15s @ 16kHz 16-bit mono = 480 KB
const MIN_PCM_BYTES = 9600 // 0.3s minimum to prevent Whisper silence hallucination

const draftCache = new Map<string, { source: 'ai' | 'rule'; summary: string; drafts: string[] }>()

// Browser mic capture handles (for real voice testing without physical G2)
let browserMicStream: MediaStream | null = null
let browserAudioCtx: AudioContext | null = null
let browserMicActive = false

function clearActionTimers(): void {
  if (armTicker !== null) {
    window.clearInterval(armTicker)
    armTicker = null
  }
  if (voiceTicker !== null) {
    window.clearInterval(voiceTicker)
    voiceTicker = null
  }
}

function quickRuleDrafts(msg: WireMessage): string[] {
  const lower = msg.text.toLowerCase()
  if (/\b(eta|where|when|late|omw|meet|sync|call)\b/.test(lower)) {
    return ['On my way - 10m', 'Can we push 15 min?', 'Free now, calling soon']
  }
  if (/\b(approve|confirm|ok|good|ship|merge|deploy)\b/.test(lower)) {
    return ['Approved - go ahead', 'Hold on, checking now', 'Looks good to ship']
  }
  if (/\?/.test(msg.text)) {
    return ['Yes, on it now', 'Checking - reply in 15m', 'Got it, will follow up']
  }
  return ['Got it, thanks!', 'On it - update soon', 'Acknowledged, talking later']
}

function recentThreadFor(msg: WireMessage): Array<{ sender: string; text: string }> {
  return state.messages
    .filter(m => m.platform === msg.platform && m.chatId === msg.chatId && m.id !== msg.id)
    .slice(0, 3)
    .reverse()
    .map(m => ({ sender: m.sender, text: m.text }))
}

async function syncHud(): Promise<void> {
  const frame = renderHud(state)
  updateHudPreview(frame)
  if (g2) await g2.render(frame)
  const bat = typeof batteryLevel === 'number' ? ` · ${batteryLevel}%` : ''
  const mode = g2?.mode ?? 'browser-preview'
  const label =
    mode === 'glasses'
      ? state.botUsername
        ? `G2 LIVE · @${state.botUsername}${bat}`
        : `G2 BRIDGE LIVE${bat}`
      : state.botUsername
        ? `MIRROR · @${state.botUsername}`
        : 'BROWSER HUD MIRROR'
  updateCompanionStatus(label, mode, state.errors, state.auditLog)
}

function schedulePrefetch(): void {
  if (prefetchTimer !== null) window.clearTimeout(prefetchTimer)
  const list = visibleMessages(state)
  const cur = list[state.selectedIdx]
  if (!cur || !cur.replyable || draftCache.has(cur.id)) return
  prefetchTimer = window.setTimeout(() => {
    void fetchDrafts(config, cur, recentThreadFor(cur))
      .then(res => {
        if (res.ok && res.drafts.length > 0) {
          draftCache.set(cur.id, { source: res.source, summary: res.summary, drafts: res.drafts })
        }
      })
      .catch(() => {})
  }, 600)
}

async function refreshInbox(): Promise<void> {
  if (isPolling || !foregroundActive) return
  isPolling = true
  try {
    const prevList = visibleMessages(state)
    const prevSelectedId = prevList[state.selectedIdx]?.id

    const res = await pollInbox(config)
    if (res.ok) {
      state.botUsername = res.botUsername || state.botUsername
      state.messages = res.messages
      state.errors = res.errors || {}
      state.lastPollAt = res.polledAt

      // Preserve cursor by message ID so background arrivals never shift selection
      const nextList = visibleMessages(state)
      if (prevSelectedId) {
        const foundIdx = nextList.findIndex(m => m.id === prevSelectedId)
        state.selectedIdx = foundIdx >= 0 ? foundIdx : 0
      } else if (state.selectedIdx >= nextList.length) {
        state.selectedIdx = Math.max(0, nextList.length - 1)
      }
      schedulePrefetch()
    }
  } catch (err) {
    state.errors = { relay: err instanceof Error ? err.message : String(err) }
  } finally {
    isPolling = false
  }
  await syncHud()
}

async function armReply(
  target: WireMessage,
  payload: { kind: 'reply'; text: string } | { kind: 'reaction'; emoji: string },
): Promise<void> {
  if (isSending) return
  isSending = true
  try {
    const res = await armReplyOnServer(config, target, payload)
    if (!res.ok || !res.armToken || !res.expiresAt) {
      state.receiptText = `[ERR] Could not arm reply:\n${res.error || 'Relay error'}`
      state.screen = 'receipt'
      await syncHud()
      return
    }
    clearActionTimers()
    state.activeMessage = target
    state.armed = {
      target,
      kind: payload.kind,
      text: payload.kind === 'reply' ? payload.text : 'Thumbs-up reaction',
      emoji: payload.kind === 'reaction' ? payload.emoji : undefined,
      armToken: res.armToken,
      expiresAt: res.expiresAt,
    }
    state.screen = 'confirm_send'
    await syncHud()

    armTicker = window.setInterval(() => {
      if (state.screen !== 'confirm_send' || !state.armed) {
        clearActionTimers()
        return
      }
      if (Date.now() >= state.armed.expiresAt) {
        clearActionTimers()
        state.armed = null
        state.screen = state.drafts.length > 0 ? 'reply_pick' : 'inbox'
      }
      void syncHud()
    }, 1000)
  } catch (err) {
    state.receiptText = `[ERR] Arm failed:\n${err instanceof Error ? err.message : String(err)}`
    state.screen = 'receipt'
    await syncHud()
  } finally {
    isSending = false
  }
}

async function executeArmedSend(): Promise<void> {
  if (isSending) return
  clearActionTimers()
  const armed = state.armed
  state.armed = null
  if (!armed || Date.now() >= armed.expiresAt) {
    state.receiptText = '[ERR] Arm token expired. Re-arm on G2.'
    state.screen = 'receipt'
    await syncHud()
    return
  }

  isSending = true
  state.receiptText = `Sending to ${armed.target.chatLabel}...`
  state.screen = 'receipt'
  await syncHud()

  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  try {
    const res = await sendArmedReply(config, armed.armToken)
    if (res.ok) {
      if (!state.repliedIds.includes(armed.target.id)) {
        state.repliedIds.unshift(armed.target.id)
      }
      state.receiptText = `[OK] SENT via ${armed.target.platform.toUpperCase()} -> ${armed.target.chatLabel}\n"${armed.text}"\nRef: ${res.messageId || 'ok'}`
      state.auditLog.unshift({
        time: nowStr,
        platform: armed.target.platform,
        target: armed.target.chatLabel,
        text: armed.text,
        status: 'SENT',
        detail: `id:${res.messageId || 'ok'}`,
      })
      persistTriageState(state)
    } else {
      state.receiptText = `[ERR] SEND FAILED\n${res.error || 'Unknown API error'}`
      state.auditLog.unshift({
        time: nowStr,
        platform: armed.target.platform,
        target: armed.target.chatLabel,
        text: armed.text,
        status: 'ERROR',
        detail: res.error || 'failed',
      })
      persistTriageState(state)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state.receiptText = `[ERR] SEND ERROR\n${msg}`
  } finally {
    isSending = false
  }
  await syncHud()
}

async function startG2VoiceCapture(): Promise<void> {
  const target = state.activeMessage
  if (!target) return
  clearActionTimers()
  state.voiceChunks = []
  state.voiceStartedAt = Date.now()
  state.voiceRms = 0
  state.screen = 'voice_capture'

  if (target.platform === 'telegram') {
    sendTelegramPresence(config, target.chatId, 'record_voice')
  }

  const started = await g2?.setMic(true)
  if (!started && g2?.mode === 'glasses') {
    state.receiptText = '[ERR] Could not open G2 microphone.'
    state.screen = 'receipt'
    await syncHud()
    return
  }
  await syncHud()

  voiceTicker = window.setInterval(() => {
    if (state.screen !== 'voice_capture') {
      clearActionTimers()
      return
    }
    if (Date.now() - state.voiceStartedAt >= 15_000) {
      void finishVoiceCapture()
      return
    }
    void syncHud()
  }, 1000)
}

async function finishVoiceCapture(): Promise<void> {
  if (isSending) return
  clearActionTimers()
  await g2?.setMic(false)
  const target = state.activeMessage
  const chunks = state.voiceChunks
  state.voiceChunks = []
  state.voiceRms = 0

  const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0)
  if (!target || totalBytes < MIN_PCM_BYTES) {
    state.receiptText =
      'Not enough mic audio captured (<0.3s). Use G2 mic or Record Browser Mic in Companion.'
    state.screen = 'receipt'
    await syncHud()
    return
  }

  isSending = true
  state.receiptText = 'Transcribing 16kHz WAV via Whisper...'
  state.screen = 'receipt'
  await syncHud()

  try {
    const wavBase64 = encodePcm16kToWavBase64(chunks, 16000)
    const res = await transcribeVoice(config, wavBase64)
    isSending = false
    if (!res.ok || !res.text) {
      state.receiptText = `[ERR] STT failed:\n${res.error || 'empty transcript'}`
      await syncHud()
      return
    }
    await armReply(target, { kind: 'reply', text: res.text })
  } catch (err) {
    isSending = false
    state.receiptText = `[ERR] STT error:\n${err instanceof Error ? err.message : String(err)}`
    await syncHud()
  }
}

async function toggleBrowserMic(): Promise<void> {
  if (browserMicActive) {
    browserMicActive = false
    setBrowserMicRecording(false)
    browserMicStream?.getTracks().forEach(t => t.stop())
    browserMicStream = null
    if (browserAudioCtx) {
      await browserAudioCtx.close().catch(() => {})
      browserAudioCtx = null
    }
    await finishVoiceCapture()
    return
  }

  const list = visibleMessages(state)
  const target = state.activeMessage || list[state.selectedIdx]
  if (!target || !target.replyable) {
    state.errors = { voice: 'Select a Telegram, Slack, or Discord message first.' }
    await syncHud()
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ctx = new AudioContext({ sampleRate: 16000 })
    const src = ctx.createMediaStreamSource(stream)
    const proc = ctx.createScriptProcessor(4096, 1, 1)

    state.activeMessage = target
    state.voiceChunks = []
    state.voiceStartedAt = Date.now()
    state.voiceRms = 0
    state.screen = 'voice_capture'
    browserMicStream = stream
    browserAudioCtx = ctx
    browserMicActive = true
    setBrowserMicRecording(true)

    if (target.platform === 'telegram') sendTelegramPresence(config, target.chatId, 'record_voice')

    proc.onaudioprocess = ev => {
      if (!browserMicActive) return
      const f32 = ev.inputBuffer.getChannelData(0)
      const pcm = new Int16Array(f32.length)
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      const bytes = new Uint8Array(pcm.buffer)
      const currentTotal = state.voiceChunks.reduce((sum, c) => sum + c.byteLength, 0)
      if (currentTotal + bytes.byteLength <= MAX_PCM_BYTES) {
        state.voiceChunks.push(bytes)
        state.voiceRms = computePcm16Rms(bytes)
      }
    }
    src.connect(proc)
    proc.connect(ctx.destination)
    await syncHud()
  } catch (err) {
    state.errors = { mic: err instanceof Error ? err.message : 'Browser mic permission denied' }
    await syncHud()
  }
}

async function openReplyPicker(target: WireMessage): Promise<void> {
  state.activeMessage = target
  state.screen = 'reply_pick'
  state.optionIdx = 0
  if (target.platform === 'telegram') {
    sendTelegramPresence(config, target.chatId, 'typing')
  }

  const cached = draftCache.get(target.id)
  if (cached) {
    state.draftSource = cached.source
    state.draftSummary = cached.summary
    state.drafts = cached.drafts
    await syncHud()
    return
  }

  // Instant rule drafts immediately (never arming a "Loading..." string!)
  state.draftSource = 'loading'
  state.draftSummary = target.text
  state.drafts = quickRuleDrafts(target)
  await syncHud()

  const reqId = ++draftReqSeq
  try {
    const res = await fetchDrafts(config, target, recentThreadFor(target))
    if (reqId !== draftReqSeq || state.screen !== 'reply_pick' || state.activeMessage?.id !== target.id) return
    if (res.ok && res.drafts.length > 0) {
      draftCache.set(target.id, { source: res.source, summary: res.summary, drafts: res.drafts })
      state.draftSource = res.source
      state.draftSummary = res.summary
      state.drafts = res.drafts
      await syncHud()
    }
  } catch {
    if (reqId === draftReqSeq) {
      state.draftSource = 'rule'
      await syncHud()
    }
  }
}

async function handleGesture(gesture: G2Gesture): Promise<void> {
  if (isSending) return
  try {
    if (gesture === 'double_tap') {
      clearActionTimers()
      await g2?.setMic(false)
      state.voiceChunks = []
      state.armed = null
      state.activeMessage = null
      state.screen = 'inbox'
      await syncHud()
      return
    }

    if (state.screen === 'inbox') {
      const list = visibleMessages(state)
      const current = list[state.selectedIdx]
      if (gesture === 'swipe_up' && list.length > 0) {
        state.selectedIdx = (state.selectedIdx - 1 + list.length) % list.length
        schedulePrefetch()
        await syncHud()
        return
      }
      if (gesture === 'swipe_down' && list.length > 0) {
        state.selectedIdx = (state.selectedIdx + 1) % list.length
        schedulePrefetch()
        await syncHud()
        return
      }
      if (gesture === 'tap') {
        if (!current || !current.replyable) {
          await refreshInbox()
          return
        }
        await openReplyPicker(current)
      }
      return
    }

    if (state.screen === 'reply_pick' && state.activeMessage) {
      const opts = getReplyOptions(state)
      if (gesture === 'swipe_up') {
        state.optionIdx = (state.optionIdx - 1 + opts.length) % opts.length
        await syncHud()
        return
      }
      if (gesture === 'swipe_down') {
        state.optionIdx = (state.optionIdx + 1) % opts.length
        await syncHud()
        return
      }
      if (gesture === 'tap') {
        const chosen = opts[state.optionIdx]
        if (!chosen || chosen.kind === 'back') {
          state.activeMessage = null
          state.screen = 'inbox'
          await syncHud()
          return
        }
        if (chosen.kind === 'voice') {
          await startG2VoiceCapture()
          return
        }
        if (chosen.kind === 'reaction') {
          await armReply(state.activeMessage, { kind: 'reaction', emoji: chosen.emoji || '👍' })
          return
        }
        if (chosen.kind === 'draft' && chosen.text) {
          await armReply(state.activeMessage, { kind: 'reply', text: chosen.text })
        }
      }
      return
    }

    if (state.screen === 'voice_capture') {
      if (gesture === 'tap') {
        if (browserMicActive) await toggleBrowserMic()
        else await finishVoiceCapture()
      } else {
        clearActionTimers()
        await g2?.setMic(false)
        state.voiceChunks = []
        state.screen = state.drafts.length > 0 ? 'reply_pick' : 'inbox'
        await syncHud()
      }
      return
    }

    if (state.screen === 'confirm_send') {
      if (gesture === 'tap') {
        await executeArmedSend()
      } else {
        clearActionTimers()
        state.armed = null
        state.screen = state.drafts.length > 0 ? 'reply_pick' : 'inbox'
        await syncHud()
      }
      return
    }

    if (state.screen === 'receipt') {
      state.activeMessage = null
      state.screen = 'inbox'
      await syncHud()
    }
  } catch (err) {
    state.receiptText = `[ERR] ${err instanceof Error ? err.message : String(err)}`
    state.screen = 'receipt'
    await syncHud()
  }
}

async function boot(): Promise<void> {
  g2 = await createG2Controller({
    initialFrame: renderHud(state),
    onGesture: gesture => {
      void handleGesture(gesture)
    },
    onHardwareDoubleTap: () => {
      if (state.screen !== 'inbox') {
        void handleGesture('double_tap')
        return false
      }
      clearActionTimers()
      return true
    },
    onAudioPcm: chunk => {
      if (state.screen === 'voice_capture') {
        const cur = state.voiceChunks.reduce((sum, c) => sum + c.byteLength, 0)
        if (cur + chunk.byteLength <= MAX_PCM_BYTES) {
          state.voiceChunks.push(new Uint8Array(chunk))
          state.voiceRms = computePcm16Rms(chunk)
        } else {
          void finishVoiceCapture()
        }
      }
    },
    onForegroundChange: active => {
      foregroundActive = active
      if (active && state.screen === 'inbox') void refreshInbox()
    },
    onExit: () => {
      clearActionTimers()
      if (pollInterval !== null) window.clearInterval(pollInterval)
    },
    onFrameRendered: frame => updateHudPreview(frame),
    onModeChange: (_mode, dev) => {
      batteryLevel = dev?.batteryLevel
      void syncHud()
    },
  })

  mountCompanionUi(config, g2.mode, {
    onSaveConfig: next => {
      config = next
      saveConfig(next)
      void refreshInbox()
    },
    onClearKeys: () => {
      clearSessionSecrets()
      config = {
        ...config,
        telegramToken: '',
        slackToken: '',
        discordToken: '',
        openRouterKey: '',
        openAiKey: '',
        groqKey: '',
      }
      void refreshInbox()
    },
    onPollNow: () => {
      void refreshInbox()
    },
    onVerifyTelegram: clearWebhook => {
      void verifyTelegramBot(config, clearWebhook)
        .then(r => {
          if (!r.ok) {
            showVerifyResult(`Telegram verify failed: ${r.error || 'unknown'}`, true)
            return
          }
          const notes = [
            `Connected: @${r.username} (${r.firstName}) -> https://t.me/${r.username}`,
            r.webhookUrl ? `Active webhook detected (${r.webhookUrl}) - click Clear Webhook!` : 'Polling mode clean (no webhook conflict).',
            r.canReadAllGroups ? 'Group Privacy: OFF (sees all group msgs).' : 'Group Privacy: ON (sees DMs + @mentions; use /setprivacy in @BotFather for full group feeds).',
          ]
          showVerifyResult(notes.join(' | '), Boolean(r.webhookUrl))
        })
        .catch(err => showVerifyResult(String(err), true))
    },
    onFilterChange: f => {
      state.filter = f
      state.selectedIdx = 0
      void syncHud()
    },
    onGesture: g => g2?.triggerGesture(g),
    onSimulateVoiceText: text => {
      const list = visibleMessages(state)
      const target = state.activeMessage || list[state.selectedIdx]
      if (!target || !target.replyable) {
        state.errors = { voice: 'Select a Telegram/Slack/Discord message first.' }
        void syncHud()
        return
      }
      void armReply(target, { kind: 'reply', text })
    },
    onBrowserMicToggle: () => {
      void toggleBrowserMic()
    },
  })

  window.addEventListener('keydown', e => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      g2?.triggerGesture('swipe_up')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      g2?.triggerGesture('swipe_down')
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      g2?.triggerGesture('tap')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      g2?.triggerGesture('double_tap')
    }
  })

  // Connect live SSE push stream for instant updates
  try {
    const es = new EventSource(`${apiBase(config)}/api/stream`)
    es.addEventListener('messages', () => {
      if (state.screen === 'inbox') void refreshInbox()
    })
  } catch {
    // Polling fallback handles environments without EventSource
  }

  void fetchHealth(config).then(updateHealthPills).catch(() => {})
  await refreshInbox()
  pollInterval = window.setInterval(() => {
    if (state.screen === 'inbox') void refreshInbox()
  }, 4000)
}

void boot()
