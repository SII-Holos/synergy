import { useLingui } from "@lingui/solid"
import { browser as B } from "@/locales/messages"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useBrowser } from "./browser-store"
import { BrowserWebRTCClient, createBrowserWebRTCSignalingUrl, type BrowserWebRTCStatus } from "./browser-webrtc"
import { normalizeBrowserError, toBrowserError } from "./browser-error"

function mouseButton(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle"
  if (button === 2) return "right"
  return "left"
}

function modifiers(e: KeyboardEvent | MouseEvent | WheelEvent): string[] {
  const result: string[] = []
  if (e.altKey) result.push("Alt")
  if (e.ctrlKey) result.push("Control")
  if (e.metaKey) result.push("Meta")
  if (e.shiftKey) result.push("Shift")
  return result
}

export function RemoteBrowserSurface(props: {
  sessionID: string
  routeDirectory?: string
  container: () => HTMLDivElement | undefined
}) {
  let videoRef: HTMLVideoElement | undefined
  let textInputRef: HTMLTextAreaElement | undefined
  let webrtcClient: BrowserWebRTCClient | null = null
  let composing = false
  let suppressNextInputValue: string | null = null
  let activeWebRTCKey = ""
  const rawKeys = new Set<string>()

  const browser = useBrowser()
  const sdk = useSDK()
  const lingui = useLingui()
  const [webrtcStatus, setWebrtcStatus] = createSignal<BrowserWebRTCStatus>("idle")
  const [webrtcDetail, setWebrtcDetail] = createSignal<unknown>(null)
  const [textInputPosition, setTextInputPosition] = createSignal({ x: 0, y: 0 })

  function clearVideoStream() {
    if (videoRef?.srcObject instanceof MediaStream) {
      for (const track of videoRef.srcObject.getTracks()) track.stop()
    }
    if (videoRef) videoRef.srcObject = null
  }

  function closeWebRTCClient() {
    const client = webrtcClient
    webrtcClient = null
    activeWebRTCKey = ""
    client?.close()
    clearVideoStream()
    setWebrtcStatus("idle")
    setWebrtcDetail(null)
  }

  createEffect(() => {
    const pageId = browser.pageId()
    if (browser.presentation()?.kind !== "webrtc" || !pageId) {
      if (webrtcClient) closeWebRTCClient()
      return
    }

    const traceId = browser.browserTraceId()
    const routeDirectory = props.routeDirectory ?? sdk.directory ?? sdk.scopeID ?? sdk.scopeKey
    if (!routeDirectory) {
      if (webrtcClient) closeWebRTCClient()
      setWebrtcStatus("error")
      setWebrtcDetail({ message: "Missing browser signaling route" })
      return
    }

    const clientKey = `${pageId}:${routeDirectory}`
    if (webrtcClient && activeWebRTCKey === clientKey) return
    closeWebRTCClient()

    const client = new BrowserWebRTCClient({
      signalingUrl: async () => {
        try {
          const response = await sdk.client.browser.createViewerTicket({
            path_directory: routeDirectory,
            query_directory: sdk.directory,
            scopeID: sdk.scopeID,
            mode: "session",
            sessionID: props.sessionID,
            presentation: "webrtc",
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            browserViewerTicketRequest: { protocolVersion: BROWSER_PROTOCOL_VERSION, pageId },
          })
          if (!response.data) throw response.error ?? new Error("Could not create a Browser viewer ticket")
          const url = createBrowserWebRTCSignalingUrl({
            serverUrl: sdk.url,
            sessionID: props.sessionID,
            pageId,
            routeDirectory,
            directory: sdk.directory,
            scopeID: sdk.scopeID,
            scopeKey: sdk.scopeKey,
            ticket: response.data.ticket,
            traceId,
          })
          if (!url) throw new Error("Missing browser signaling route")
          return {
            url,
            rtcConfiguration: { iceServers: response.data.iceServers as RTCIceServer[] },
          }
        } catch (error) {
          throw toBrowserError(error, "Could not create a Browser viewer ticket")
        }
      },
      pageId,
      traceId,
      onStatus: (status, detail) => {
        if (webrtcClient !== client) return
        setWebrtcStatus(status)
        setWebrtcDetail(detail ?? null)
        if (status === "host_pending") browser.setHostStatus(pageId, "pending")
      },
      onStream: (stream) => {
        if (webrtcClient !== client) return
        if (!videoRef) return
        videoRef.srcObject = stream
        void videoRef.play().catch(() => {})
      },
      onMessage: (message) => {
        if (webrtcClient !== client) return
        if (typeof message !== "object" || message === null) return
        const msg = message as { type?: unknown; pageId?: unknown; status?: unknown }
        if (msg.type !== "browser.host.status") return
        if (typeof msg.pageId !== "string") return
        if (
          msg.status === "unavailable" ||
          msg.status === "installing" ||
          msg.status === "starting" ||
          msg.status === "pending" ||
          msg.status === "ready" ||
          msg.status === "detached" ||
          msg.status === "restarting" ||
          msg.status === "idle" ||
          msg.status === "failed"
        ) {
          browser.setHostStatus(msg.pageId, msg.status)
        }
      },
    })
    webrtcClient = client
    activeWebRTCKey = clientKey
    void client.connect().catch((error) => {
      if (webrtcClient !== client) return
      const normalized = normalizeBrowserError(error, "Browser WebRTC connection failed")
      setWebrtcStatus("error")
      setWebrtcDetail({ message: normalized.message, code: normalized.code })
    })
  })

  onCleanup(closeWebRTCClient)

  function point(e: MouseEvent | WheelEvent) {
    const target = videoRef ?? props.container()
    if (!target) return null
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const width = browser.viewportWidth()
    const height = browser.viewportHeight()
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * width),
      y: Math.round(((e.clientY - rect.top) / rect.height) * height),
    }
  }

  function sendInput(payload: Record<string, unknown>) {
    webrtcClient?.sendInput(payload)
  }

  function sendTextInput(text: string) {
    const pageId = browser.pageId()
    if (!pageId || !text) return
    sendInput({ type: "input.text", pageId, text })
  }

  function sendKeyInput(action: "down" | "up", input: Record<string, unknown>) {
    const pageId = browser.pageId()
    if (!pageId) return false
    sendInput({
      type: "input.key",
      action,
      pageId,
      ...input,
    })
    return true
  }

  function sendKeyStroke(key: string, code = key) {
    const input = { key, code, modifiers: [] }
    if (sendKeyInput("down", input)) sendKeyInput("up", input)
  }

  function keySignature(e: KeyboardEvent) {
    return e.code || e.key
  }

  function shouldSendRawKey(e: KeyboardEvent) {
    if (e.key.length !== 1) return true
    return e.altKey || e.ctrlKey || e.metaKey
  }

  function resetTextInput() {
    if (textInputRef) textInputRef.value = ""
  }

  function focusTextInput(e?: MouseEvent) {
    const container = props.container()
    if (e && container) {
      const rect = container.getBoundingClientRect()
      setTextInputPosition({
        x: Math.max(0, Math.min(rect.width, Math.round(e.clientX - rect.left))),
        y: Math.max(0, Math.min(rect.height, Math.round(e.clientY - rect.top))),
      })
    }
    textInputRef?.focus({ preventScroll: true })
  }

  function handleMouse(action: "move" | "down" | "up", e: MouseEvent) {
    e.stopPropagation()
    const pageId = browser.pageId()
    const p = point(e)
    if (!pageId || !p) return
    if (action === "down") {
      focusTextInput(e)
      if (browser.annotationMode()) {
        const wrapper = props.container()?.getBoundingClientRect()
        browser.setAnnotationTarget({
          displayX: wrapper ? Math.round(e.clientX - wrapper.left) : p.x,
          displayY: wrapper ? Math.round(e.clientY - wrapper.top) : p.y,
          pageX: p.x,
          pageY: p.y,
        })
        e.preventDefault()
        return
      }
    }
    sendInput({
      type: "input.mouse",
      action,
      pageId,
      x: p.x,
      y: p.y,
      button: mouseButton(e.button),
      clickCount: e.detail || 1,
      modifiers: modifiers(e),
    })
    e.preventDefault()
  }

  function handleWheel(e: WheelEvent) {
    e.stopPropagation()
    const pageId = browser.pageId()
    const p = point(e)
    if (!pageId || !p) return
    sendInput({
      type: "input.mouse",
      action: "wheel",
      pageId,
      x: p.x,
      y: p.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: modifiers(e),
    })
    e.preventDefault()
  }

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation()
    if (composing) return
    if (!shouldSendRawKey(e)) return
    const input = {
      key: e.key,
      code: e.code,
      autoRepeat: e.repeat,
      modifiers: modifiers(e),
    }
    if (sendKeyInput("down", input)) rawKeys.add(keySignature(e))
    e.preventDefault()
  }

  function handleKeyUp(e: KeyboardEvent) {
    e.stopPropagation()
    const signature = keySignature(e)
    if (!rawKeys.has(signature) && !shouldSendRawKey(e)) return
    const input = {
      key: e.key,
      code: e.code,
      autoRepeat: e.repeat,
      modifiers: modifiers(e),
    }
    if (sendKeyInput("up", input)) rawKeys.delete(signature)
    e.preventDefault()
  }

  function handleBeforeInput(e: InputEvent) {
    e.stopPropagation()
    if (composing || e.isComposing) return
    if (e.inputType === "insertText" || e.inputType === "insertReplacementText") {
      if (e.data) sendTextInput(e.data)
      resetTextInput()
      e.preventDefault()
      return
    }
    if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
      sendKeyStroke("Enter")
      resetTextInput()
      e.preventDefault()
      return
    }
    if (e.inputType === "deleteContentBackward") {
      sendKeyStroke("Backspace")
      resetTextInput()
      e.preventDefault()
      return
    }
    if (e.inputType === "deleteContentForward") {
      sendKeyStroke("Delete")
      resetTextInput()
      e.preventDefault()
    }
  }

  function handleTextInput(e: InputEvent & { currentTarget: HTMLTextAreaElement }) {
    e.stopPropagation()
    if (composing || e.isComposing) return
    const value = e.currentTarget.value
    if (!value) return
    if (suppressNextInputValue === value) {
      suppressNextInputValue = null
      resetTextInput()
      return
    }
    sendTextInput(value)
    resetTextInput()
  }

  function handleCompositionStart(e: CompositionEvent) {
    e.stopPropagation()
    composing = true
  }

  function handleCompositionEnd(e: CompositionEvent & { currentTarget: HTMLTextAreaElement }) {
    e.stopPropagation()
    composing = false
    const text = e.data || e.currentTarget.value
    if (text) {
      suppressNextInputValue = text
      sendTextInput(text)
    }
    resetTextInput()
    queueMicrotask(() => {
      suppressNextInputValue = null
    })
  }

  function handlePaste(e: ClipboardEvent) {
    e.stopPropagation()
    const pageId = browser.pageId()
    const text = e.clipboardData?.getData("text/plain")
    if (!pageId || !text) return
    sendInput({ type: "input.text", pageId, text })
    resetTextInput()
    e.preventDefault()
  }

  function statusMessage() {
    const detail = webrtcDetail()
    if (typeof detail === "object" && detail !== null && "message" in detail) {
      return String((detail as { message: unknown }).message)
    }
    if (webrtcStatus() === "host_pending") return lingui._(B.remoteWaiting.id)
    if (webrtcStatus() === "host_ready") return lingui._(B.remoteStreamPreparing.id)
    if (webrtcStatus() === "negotiating") return lingui._(B.remoteNegotiating.id)
    if (webrtcStatus() === "signaling") return lingui._(B.remoteConnecting.id)
    if (webrtcStatus() === "error") return lingui._(B.remoteUnavailable.id)
    return lingui._(B.remotePreparing.id)
  }

  const streamReady = () => webrtcStatus() === "stream_ready"

  return (
    <>
      <textarea
        ref={textInputRef}
        aria-label={lingui._(B.remoteTextInput.id)}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        inputmode="text"
        spellcheck={false}
        tabIndex={-1}
        class="absolute z-30 h-px w-px resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent opacity-0 outline-none pointer-events-none"
        style={{
          left: `${textInputPosition().x}px`,
          top: `${textInputPosition().y}px`,
        }}
        onBeforeInput={handleBeforeInput}
        onInput={handleTextInput}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onPaste={handlePaste}
      />
      <video
        ref={videoRef}
        tabIndex={-1}
        autoplay
        playsinline
        muted
        class="max-w-full max-h-full outline-none cursor-default bg-background-strong"
        onMouseMove={(e) => handleMouse("move", e)}
        onMouseDown={(e) => handleMouse("down", e)}
        onMouseUp={(e) => handleMouse("up", e)}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onPaste={handlePaste}
      />
      <Show when={!streamReady()}>
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background-strong/80 text-center text-text-weak">
          <Icon name={getSemanticIcon("browser.main")} class="size-10 text-icon-weak-base" />
          <span class="text-13-medium text-text-base">{statusMessage()}</span>
          <span class="text-11 text-text-weaker">{webrtcStatus()}</span>
        </div>
      </Show>
    </>
  )
}
