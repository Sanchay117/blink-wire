import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  type EvenAppBridge,
  type DeviceStatus,
} from '@evenrealities/even_hub_sdk'

export interface HudFrame {
  header: string
  body: string
  footer: string
}

export type G2Gesture = 'tap' | 'swipe_up' | 'swipe_down' | 'double_tap'

export interface G2Controller {
  readonly mode: 'glasses' | 'browser-preview'
  render(frame: HudFrame): Promise<void>
  setMic(enabled: boolean): Promise<boolean>
  triggerGesture(gesture: G2Gesture): void
  destroy(): void
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function clampUtf8Bytes(text: string, maxBytes = 900): string {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= maxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (enc.encode(text.slice(0, mid)).length <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}

export async function createG2Controller(opts: {
  initialFrame: HudFrame
  onGesture: (gesture: G2Gesture) => void
  onHardwareDoubleTap?: () => boolean // return true to exit OS app, false if handled as in-app back
  onAudioPcm?: (pcm: Uint8Array) => void
  onForegroundChange?: (active: boolean) => void
  onExit?: () => void
  onFrameRendered?: (frame: HudFrame) => void
  onModeChange?: (mode: 'glasses' | 'browser-preview', deviceStatus?: DeviceStatus) => void
}): Promise<G2Controller> {
  let bridge: EvenAppBridge | null = null
  let mode: 'glasses' | 'browser-preview' = 'browser-preview'
  let lastFrame: HudFrame = { header: '', body: '', footer: '' }
  let pendingFrame: HudFrame | null = null
  let flushing = false
  let unsubEvent: (() => void) | null = null
  let unsubDevice: (() => void) | null = null
  let cleaned = false

  async function attachBridge(b: EvenAppBridge): Promise<void> {
    if (cleaned || bridge) return
    const f = pendingFrame || opts.initialFrame
    let created = 1
    try {
      created = await b.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: 3,
          textObject: [
            new TextContainerProperty({
              xPosition: 0,
              yPosition: 0,
              width: 576,
              height: 34,
              borderWidth: 0,
              borderColor: 5,
              paddingLength: 2,
              containerID: 1,
              containerName: 'header',
              content: clampUtf8Bytes(f.header, 160),
              isEventCapture: 0,
            }),
            new TextContainerProperty({
              xPosition: 0,
              yPosition: 36,
              width: 576,
              height: 218,
              borderWidth: 1,
              borderColor: 5,
              borderRadius: 6,
              paddingLength: 6,
              containerID: 2,
              containerName: 'body',
              content: clampUtf8Bytes(f.body, 900),
              isEventCapture: 1,
            }),
            new TextContainerProperty({
              xPosition: 0,
              yPosition: 256,
              width: 576,
              height: 32,
              borderWidth: 0,
              borderColor: 5,
              paddingLength: 2,
              containerID: 3,
              containerName: 'footer',
              content: clampUtf8Bytes(f.footer, 160),
              isEventCapture: 0,
            }),
          ],
        }),
      )
    } catch {
      created = 1
    }
    if (created !== 0) return

    bridge = b
    mode = 'glasses'
    lastFrame = { ...f }

    unsubDevice = b.onDeviceStatusChanged(st => {
      opts.onModeChange?.('glasses', st)
    })

    unsubEvent = b.onEvenHubEvent(event => {
      if (event.audioEvent?.audioPcm && opts.onAudioPcm) {
        opts.onAudioPcm(event.audioEvent.audioPcm)
      }

      const sysType = eventTypeOf(event.sysEvent)
      const textType = eventTypeOf(event.textEvent)

      if (
        sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
        textType === OsEventTypeList.DOUBLE_CLICK_EVENT
      ) {
        const shouldExit = opts.onHardwareDoubleTap ? opts.onHardwareDoubleTap() : true
        if (shouldExit) {
          void b.audioControl(false)
          void b.shutDownPageContainer(1)
        }
        return
      }

      if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
        opts.onGesture('swipe_up')
        return
      }
      if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        opts.onGesture('swipe_down')
        return
      }
      if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
        opts.onGesture('tap')
        return
      }

      if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
        opts.onForegroundChange?.(false)
        return
      }
      if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
        opts.onForegroundChange?.(true)
        return
      }
      if (
        sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
        sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        destroy()
        opts.onExit?.()
      }
    })

    opts.onModeChange?.('glasses')
  }

  async function flushFrames(): Promise<void> {
    if (flushing || !bridge) return
    flushing = true
    try {
      while (pendingFrame && bridge) {
        const next = pendingFrame
        pendingFrame = null
        try {
          if (next.header !== lastFrame.header) {
            await bridge.textContainerUpgrade(
              new TextContainerUpgrade({
                containerID: 1,
                containerName: 'header',
                content: clampUtf8Bytes(next.header, 160),
              }),
            )
            lastFrame.header = next.header
          }
          if (next.body !== lastFrame.body) {
            await bridge.textContainerUpgrade(
              new TextContainerUpgrade({
                containerID: 2,
                containerName: 'body',
                content: clampUtf8Bytes(next.body, 900),
              }),
            )
            lastFrame.body = next.body
          }
          if (next.footer !== lastFrame.footer) {
            await bridge.textContainerUpgrade(
              new TextContainerUpgrade({
                containerID: 3,
                containerName: 'footer',
                content: clampUtf8Bytes(next.footer, 160),
              }),
            )
            lastFrame.footer = next.footer
          }
        } catch (err) {
          console.error('G2 upgrade error (recovered):', err)
        }
      }
    } finally {
      flushing = false
    }
  }

  // Only attempt host handshake when running inside Even Hub / Simulator WebView
  const hasFlutterHost =
    typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>).flutter_inappwebview)

  if (hasFlutterHost) {
    const bridgePromise = waitForEvenAppBridge()
    const initialBridge = await new Promise<EvenAppBridge | null>(resolve => {
      const timer = window.setTimeout(() => resolve(null), 1500)
      bridgePromise
        .then(b => {
          window.clearTimeout(timer)
          resolve(b)
        })
        .catch(() => {
          window.clearTimeout(timer)
          resolve(null)
        })
    })
    if (initialBridge) {
      await attachBridge(initialBridge)
    } else {
      void bridgePromise.then(b => attachBridge(b)).catch(() => {})
    }
  }

  opts.onFrameRendered?.(opts.initialFrame)

  async function render(frame: HudFrame): Promise<void> {
    opts.onFrameRendered?.(frame)
    pendingFrame = { ...frame }
    if (!bridge) {
      lastFrame = { ...frame }
      return
    }
    await flushFrames()
  }

  async function setMic(enabled: boolean): Promise<boolean> {
    if (!bridge) return false
    try {
      return await bridge.audioControl(enabled)
    } catch {
      return false
    }
  }

  function destroy(): void {
    if (cleaned) return
    cleaned = true
    if (bridge) void bridge.audioControl(false)
    unsubEvent?.()
    unsubDevice?.()
  }

  window.addEventListener('beforeunload', destroy)

  return {
    get mode() {
      return mode
    },
    render,
    setMic,
    triggerGesture: g => opts.onGesture(g),
    destroy,
  }
}
