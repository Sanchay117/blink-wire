import {
  loadConfig,
  saveConfig,
  pollInbox,
  fetchDrafts,
  sendConfirmedReply,
  transcribeVoice,
  type WireConfig,
} from './client/api'
import { createG2Controller, type G2Controller, type G2Gesture } from './g2/bridge'
import { encodePcm16kToWavBase64 } from './g2/wav'
import { createInitialState, renderHud } from './state'
import { mountCompanionUi, updateCompanionStatus, updateHudPreview } from './ui'

let config: WireConfig = loadConfig()
const state = createInitialState()
let g2: G2Controller | null = null
let armTicker: number | null = null
let voiceTicker: number | null = null

async function syncHud(): Promise<void> {
  const frame = renderHud(state)
  updateHudPreview(frame)
  if (g2) await g2.render(frame)
  const label =
    g2?.mode === 'glasses'
      ? state.botUsername
        ? `G2 LIVE · @${state.botUsername}`
        : 'G2 BRIDGE LIVE'
      : state.botUsername
        ? `MIRROR · @${state.botUsername}`
        : 'BROWSER HUD MIRROR'
  updateCompanionStatus(label, state.errors, state.auditLog)
}

function clearTimers(): void {
  if (armTicker !== null) {
    window.clearInterval(armTicker)
    armTicker = null
  }
  if (voiceTicker !== null) {
    window.clearInterval(voiceTicker)
    voiceTicker = null
  }
}

async function refreshInbox(): Promise<void> {
  try {
    const res = await pollInbox(config)
    if (res.ok) {
      state.botUsername = res.botUsername || state.botUsername
      state.messages = res.messages
      state.errors = res.errors || {}
      state.lastPollAt = res.polledAt
      if (state.selectedIdx >= state.messages.length) {
        state.selectedIdx = Math.max(0, state.messages.length - 1)
      }
    }
  } catch (err) {
    state.errors = { relay: err instanceof Error ? err.message : String(err) }
  }
  await syncHud()
}

function armSend(replyText: string): void {
  clearTimers()
  state.pendingReplyText = replyText
  state.armExpiresAt = Date.now() + 6000
  state.screen = 'confirm_send'
  void syncHud()

  armTicker = window.setInterval(() => {
    if (state.screen !== 'confirm_send') {
      clearTimers()
      return
    }
    if (Date.now() >= state.armExpiresAt) {
      clearTimers()
      state.screen = 'reply_pick'
      state.pendingReplyText = ''
    }
    void syncHud()
  }, 1000)
}

async function startVoiceCapture(): Promise<void> {
  clearTimers()
  state.voiceChunks = []
  state.voiceStartedAt = Date.now()
  state.screen = 'voice_capture'
  await g2?.setMic(true)
  await syncHud()

  voiceTicker = window.setInterval(() => {
    if (state.screen !== 'voice_capture') {
      clearTimers()
      return
    }
    void syncHud()
  }, 500)
}

async function finishVoiceCapture(): Promise<void> {
  clearTimers()
  await g2?.setMic(false)
  if (state.voiceChunks.length === 0) {
    state.receiptText = 'No G2 mic PCM captured. Use physical G2/simulator mic or Companion voice test box.'
    state.screen = 'receipt'
    await syncHud()
    return
  }

  state.receiptText = 'Transcribing G2 audio…'
  state.screen = 'receipt'
  await syncHud()

  const wavBase64 = encodePcm16kToWavBase64(state.voiceChunks, 16000)
  const res = await transcribeVoice(config, wavBase64)
  if (!res.ok || !res.text) {
    state.receiptText = `Transcription failed: ${res.error || 'empty transcript'}`
    await syncHud()
    return
  }
  armSend(res.text)
}

async function executeArmedSend(): Promise<void> {
  clearTimers()
  const current = state.messages[state.selectedIdx]
  if (!current || !state.pendingReplyText) {
    state.screen = 'inbox'
    await syncHud()
    return
  }

  const replyText = state.pendingReplyText
  state.pendingReplyText = ''
  state.receiptText = `Sending to ${current.chatLabel}…`
  state.screen = 'receipt'
  await syncHud()

  const res = await sendConfirmedReply(config, current, replyText)
  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  if (res.ok) {
    state.receiptText = `✓ SENT via ${current.platform.toUpperCase()} to ${current.chatLabel}\n"${replyText}"\nRef: ${res.messageId || 'ok'}`
    state.auditLog.unshift({
      time: nowStr,
      platform: current.platform,
      target: current.chatLabel,
      text: replyText,
      status: 'SENT',
      detail: `id:${res.messageId || 'ok'}`,
    })
  } else {
    state.receiptText = `✕ SEND FAILED\n${res.error || 'Unknown API error'}`
    state.auditLog.unshift({
      time: nowStr,
      platform: current.platform,
      target: current.chatLabel,
      text: replyText,
      status: 'ERROR',
      detail: res.error || 'failed',
    })
  }
  await syncHud()
}

async function handleGesture(gesture: G2Gesture): Promise<void> {
  if (gesture === 'double_tap') {
    clearTimers()
    await g2?.setMic(false)
    state.screen = 'inbox'
    await syncHud()
    return
  }

  const current = state.messages[state.selectedIdx]

  if (state.screen === 'inbox') {
    if (gesture === 'swipe_up' && state.messages.length > 0) {
      state.selectedIdx = (state.selectedIdx - 1 + state.messages.length) % state.messages.length
      await syncHud()
      return
    }
    if (gesture === 'swipe_down' && state.messages.length > 0) {
      state.selectedIdx = (state.selectedIdx + 1) % state.messages.length
      await syncHud()
      return
    }
    if (gesture === 'tap') {
      if (!current || !current.replyable) {
        await refreshInbox()
        return
      }
      state.screen = 'reply_pick'
      state.optionIdx = 0
      state.draftSource = 'loading'
      state.draftSummary = current.text
      state.drafts = ['Loading quick replies…']
      await syncHud()

      const res = await fetchDrafts(config, current)
      state.draftSource = res.source
      state.draftSummary = res.summary
      state.drafts = res.drafts
      await syncHud()
    }
    return
  }

  if (state.screen === 'reply_pick') {
    const totalOptions = state.drafts.length + 2 // drafts + voice + back
    if (gesture === 'swipe_up') {
      state.optionIdx = (state.optionIdx - 1 + totalOptions) % totalOptions
      await syncHud()
      return
    }
    if (gesture === 'swipe_down') {
      state.optionIdx = (state.optionIdx + 1) % totalOptions
      await syncHud()
      return
    }
    if (gesture === 'tap') {
      if (state.optionIdx < state.drafts.length) {
        armSend(state.drafts[state.optionIdx])
      } else if (state.optionIdx === state.drafts.length) {
        await startVoiceCapture()
      } else {
        state.screen = 'inbox'
        await syncHud()
      }
    }
    return
  }

  if (state.screen === 'voice_capture') {
    if (gesture === 'tap') {
      await finishVoiceCapture()
    } else {
      clearTimers()
      await g2?.setMic(false)
      state.screen = 'reply_pick'
      await syncHud()
    }
    return
  }

  if (state.screen === 'confirm_send') {
    if (gesture === 'tap') {
      await executeArmedSend()
    } else {
      clearTimers()
      state.pendingReplyText = ''
      state.screen = 'reply_pick'
      await syncHud()
    }
    return
  }

  if (state.screen === 'receipt') {
    state.screen = 'inbox'
    await syncHud()
  }
}

async function boot(): Promise<void> {
  g2 = await createG2Controller({
    initialFrame: renderHud(state),
    onGesture: gesture => {
      void handleGesture(gesture)
    },
    onAudioPcm: chunk => {
      if (state.screen === 'voice_capture') {
        state.voiceChunks.push(new Uint8Array(chunk))
      }
    },
    onFrameRendered: frame => {
      updateHudPreview(frame)
    },
  })

  mountCompanionUi(config, g2.mode, {
    onSaveConfig: next => {
      config = next
      saveConfig(next)
      void refreshInbox()
    },
    onPollNow: () => {
      void refreshInbox()
    },
    onGesture: g => g2?.triggerGesture(g),
    onSimulateVoiceText: text => {
      const current = state.messages[state.selectedIdx]
      if (!current || !current.replyable) {
        state.errors = { voice: 'Select a Telegram/Slack/Discord message first to arm a reply.' }
        void syncHud()
        return
      }
      armSend(text)
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

  await refreshInbox()
  window.setInterval(() => {
    if (state.screen === 'inbox') {
      void refreshInbox()
    }
  }, 8000)
}

void boot()
