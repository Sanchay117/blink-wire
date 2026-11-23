import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

export interface HudFrame {
  header: string
  body: string
  footer: string
}

export type G2Gesture = 'tap' | 'swipe_up' | 'swipe_down' | 'double_tap'

export interface G2Controller {
  mode: 'glasses' | 'browser-preview'
  render(frame: HudFrame): Promise<void>
  setMic(enabled: boolean): Promise<boolean>
  triggerGesture(gesture: G2Gesture): void
  destroy(): void
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve(null), ms)
    promise
      .then(v => {
        window.clearTimeout(timer)
        resolve(v)
      })
      .catch(() => {
        window.clearTimeout(timer)
        resolve(null)
      })
  })
}

export async function createG2Controller(opts: {
  initialFrame: HudFrame
  onGesture: (gesture: G2Gesture) => void
  onAudioPcm?: (pcm: Uint8Array) => void
  onFrameRendered?: (frame: HudFrame) => void
}): Promise<G2Controller> {
  const hasHost =
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as Record<string, unknown>).flutter_inappwebview ||
        (window as unknown as Record<string, unknown>).EvenAppBridge,
    )

  const bridge: EvenAppBridge | null = hasHost
    ? await withTimeout(waitForEvenAppBridge(), 2000)
    : await withTimeout(waitForEvenAppBridge(), 650)

  let lastFrame: HudFrame = { header: '', body: '', footer: '' }
  let renderChain: Promise<unknown> = Promise.resolve()
  let unsub: (() => void) | null = null
  let cleaned = false

  if (bridge) {
    const headerBox = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 36,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: 1,
      containerName: 'header',
      content: opts.initialFrame.header,
      isEventCapture: 0,
    })

    const bodyBox = new TextContainerProperty({
      xPosition: 0,
      yPosition: 38,
      width: 576,
      height: 210,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 8,
      containerID: 2,
      containerName: 'body',
      content: opts.initialFrame.body,
      isEventCapture: 1,
    })

    const footerBox = new TextContainerProperty({
      xPosition: 0,
      yPosition: 252,
      width: 576,
      height: 36,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: 3,
      containerName: 'footer',
      content: opts.initialFrame.footer,
      isEventCapture: 0,
    })

    const created = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 3,
        textObject: [headerBox, bodyBox, footerBox],
      }),
    )
    if (created !== 0) {
      console.error('createStartUpPageContainer failed:', created)
    }

    lastFrame = { ...opts.initialFrame }

    unsub = bridge.onEvenHubEvent(event => {
      if (event.audioEvent?.audioPcm && opts.onAudioPcm) {
        opts.onAudioPcm(event.audioEvent.audioPcm)
      }

      const sysType = eventTypeOf(event.sysEvent)
      const textType = eventTypeOf(event.textEvent)

      if (
        sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
        textType === OsEventTypeList.DOUBLE_CLICK_EVENT
      ) {
        opts.onGesture('double_tap')
        void bridge.shutDownPageContainer(1)
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

      if (
        sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
        sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        destroy()
      }
    })
  }

  opts.onFrameRendered?.(opts.initialFrame)

  async function render(frame: HudFrame): Promise<void> {
    opts.onFrameRendered?.(frame)
    if (!bridge) {
      lastFrame = { ...frame }
      return
    }
    const prev = lastFrame
    lastFrame = { ...frame }
    renderChain = renderChain.then(async () => {
      if (frame.header !== prev.header) {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 1,
            containerName: 'header',
            content: frame.header,
          }),
        )
      }
      if (frame.body !== prev.body) {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 2,
            containerName: 'body',
            content: frame.body,
          }),
        )
      }
      if (frame.footer !== prev.footer) {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 3,
            containerName: 'footer',
            content: frame.footer,
          }),
        )
      }
    })
    await renderChain
  }

  async function setMic(enabled: boolean): Promise<boolean> {
    if (!bridge) return false
    return bridge.audioControl(enabled)
  }

  function triggerGesture(gesture: G2Gesture): void {
    opts.onGesture(gesture)
  }

  function destroy(): void {
    if (cleaned) return
    cleaned = true
    if (bridge) void bridge.audioControl(false)
    unsub?.()
  }

  window.addEventListener('beforeunload', destroy)

  return {
    mode: bridge ? 'glasses' : 'browser-preview',
    render,
    setMic,
    triggerGesture,
    destroy,
  }
}
