import type { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import type { HostContext, RenderRuntime, RuntimeConfig, ViewState } from "./protocol"
import { installRenderControls } from "./controls"
import { captureRenderElement } from "./capture"

// HTML sandbox and channel messaging: https://html.spec.whatwg.org/multipage/web-messaging.html#channel-messaging
// This function is serialized into the opaque frame; dependencies are supplied explicitly.
export function renderRuntime(
  config: RuntimeConfig,
  installControls: typeof installRenderControls,
  capture: typeof captureRenderElement,
) {
  document.documentElement.dataset.renderVersion = config.version
  let port: MessagePort | undefined
  let sequence = 0
  let context = config.context
  let state = config.state
  let revision = config.revision
  let savedContent = JSON.stringify(config.state)
  let epoch = 0
  let view: ViewState = { controls: {} }
  let authoredUI: RenderArtifact.Content["uiContent"]
  let feedback = false
  const pending = new Map<
    string,
    { resolve: (value?: unknown) => void; reject: (error: Error) => void; timer?: number }
  >()
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const api = new EventTarget() as RenderRuntime
  const nativeRequestFrame = window.requestAnimationFrame.bind(window)
  const nativeCancelFrame = window.cancelAnimationFrame.bind(window)
  const frames = new Map<number, { callback: FrameRequestCallback; scheduled?: number }>()
  let frameID = 0
  const pausedAnimations = new Set<Animation>()
  function schedule(id: number, frame: { callback: FrameRequestCallback; scheduled?: number }) {
    if (!context.active || frame.scheduled !== undefined) return
    frame.scheduled = nativeRequestFrame((time) => {
      frame.scheduled = undefined
      if (!context.active) return
      frames.delete(id)
      frame.callback(time)
    })
  }
  window.requestAnimationFrame = (callback) => {
    const id = ++frameID,
      frame = { callback }
    frames.set(id, frame)
    schedule(id, frame)
    return id
  }
  window.cancelAnimationFrame = (id) => {
    const frame = frames.get(id)
    if (frame?.scheduled !== undefined) nativeCancelFrame(frame.scheduled)
    frames.delete(id)
  }
  function syncAnimation(animation: Animation) {
    if (context.reducedMotion && animation.playState === "running") {
      const end = animation.effect?.getComputedTiming().endTime
      if (typeof end === "number" && Number.isFinite(end) && animation.playbackRate !== 0) animation.finish()
      else {
        animation.pause()
        pausedAnimations.add(animation)
      }
      return
    }
    if (!context.active && animation.playState === "running") {
      animation.pause()
      pausedAnimations.add(animation)
    } else if (context.active && pausedAnimations.delete(animation) && animation.playState === "paused") {
      animation.play()
    }
  }
  const animate = Element.prototype.animate
  Element.prototype.animate = function (...args) {
    const animation = animate.apply(this, args)
    syncAnimation(animation)
    return animation
  }
  const labels = config.labels
  const report = (error: unknown) => {
    const message = String(error instanceof Error ? error.message : error).slice(0, 2000)
    port?.postMessage({ type: "error", message })
    document.body?.setAttribute("data-render-error", message)
  }
  function unpack(content: RenderArtifact.Content) {
    state = content
    const ui = content.uiContent
    if (ui && typeof ui === "object" && !Array.isArray(ui) && ui.renderViewVersion === 1) {
      view = (ui.view as unknown as ViewState) ?? { controls: {} }
      authoredUI = ui.value
    } else {
      authoredUI = ui
      view = { controls: {} }
    }
  }
  unpack(state)
  function packed(): RenderArtifact.Content {
    return {
      modelContent: state.modelContent,
      uiContent: JSON.parse(JSON.stringify({ renderViewVersion: 1, view, value: authoredUI })),
    }
  }
  function request(type: string, payload: object) {
    if (!config.interactive) return Promise.reject(new Error(labels.static))
    if (
      type === "followup" &&
      (!("text" in payload) || typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 8000)
    )
      return Promise.reject(new Error(labels.invalidRequest))
    if (config.offline) return type === "state" ? Promise.resolve() : Promise.reject(new Error(labels.offline))
    return ready.then(
      () =>
        new Promise<unknown>((resolve, reject) => {
          if (!port || pending.size >= 8) {
            reject(new Error(port ? labels.busy : labels.closed))
            return
          }
          const requestID = `${config.nonce}:${++sequence}`
          const timer =
            type === "state"
              ? window.setTimeout(() => {
                  pending.delete(requestID)
                  reject(new Error(labels.timeout))
                }, 30000)
              : undefined
          pending.set(requestID, { resolve, reject, timer })
          port!.postMessage({ type, requestID, ...payload })
        }),
    )
  }
  let saves = Promise.resolve()
  function persist() {
    const content = packed()
    const encoded = JSON.stringify(content)
    if (new TextEncoder().encode(encoded).byteLength > 16 * 1024) return Promise.reject(new Error(labels.tooLarge))
    const current = epoch
    saves = saves
      .catch(() => {})
      .then(async () => {
        if (epoch !== current) throw new Error(labels.conflict)
        if (encoded === savedContent) return
        const value = (await request("state", { revision, content })) as { revision?: number } | undefined
        if (value?.revision === undefined || value.revision >= revision) {
          savedContent = encoded
          if (typeof value?.revision === "number") revision = value.revision
        }
      })
    return saves
  }
  let viewTimer: number | undefined
  function saveView() {
    clearTimeout(viewTimer)
    viewTimer = window.setTimeout(() => {
      persist().catch(report)
    }, 120)
  }
  function applyTheme(next: HostContext) {
    context = next
    document.documentElement.lang = next.locale
    document.documentElement.style.colorScheme = next.colorScheme
    for (const [name, value] of Object.entries(next.theme))
      document.documentElement.style.setProperty(`--render-${name}`, value)
    document.documentElement.dataset.renderActive = String(next.active)
    document.documentElement.dataset.renderReducedMotion = String(next.reducedMotion)
    for (const [id, frame] of frames) {
      if (!next.active && frame.scheduled !== undefined) {
        nativeCancelFrame(frame.scheduled)
        frame.scheduled = undefined
      } else schedule(id, frame)
    }
    for (const animation of document.getAnimations()) syncAnimation(animation)
    api.dispatchEvent(new Event("hostcontextchange"))
  }
  function fieldKey(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, index: number) {
    return element.id || element.name || String(index)
  }
  function fields() {
    return Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"),
    )
      .filter(
        (element) =>
          !element.closest("[data-render-controls]") && !["password", "file", "hidden"].includes(element.type),
      )
      .slice(0, 80)
  }
  function restore() {
    fields().forEach((element, index) => {
      const value = view.forms?.[fieldKey(element, index)]
      if (typeof value === "boolean" && element instanceof HTMLInputElement) element.checked = value
      else if (typeof value === "string") element.value = value
    })
    if (typeof view.scroll === "number") window.scrollTo(0, view.scroll)
    api.dispatchEvent(new Event("statechange"))
  }
  Object.assign(api, {
    ready,
    getState: () => structuredClone({ modelContent: state.modelContent, uiContent: authoredUI }),
    getHostContext: () => structuredClone(context),
    setState: async (content: RenderArtifact.Content) => {
      const json = JSON.stringify(content)
      if (new TextEncoder().encode(json).byteLength > 16 * 1024) throw new Error(labels.tooLarge)
      const next = JSON.parse(json) as RenderArtifact.Content
      state = { ...state, modelContent: next.modelContent }
      authoredUI = next.uiContent
      await persist()
    },
    requestFollowUp: (text: string) => request("followup", { text }),
  })
  Object.defineProperty(window, "synergy", { value: Object.freeze({ render: api }), configurable: false })
  installControls(api, {
    labels,
    getView: () => view,
    saveView,
    report,
    version: config.version,
    offline: config.offline,
  })
  applyTheme(context)
  function connect(event: MessageEvent) {
    if (
      event.source !== parent ||
      event.data?.type !== "synergy.render.connect" ||
      event.data.nonce !== config.nonce ||
      !event.ports[0] ||
      port
    )
      return
    port = event.ports[0]
    window.removeEventListener("message", connect)
    port.onmessage = (event) => {
      const message = event.data
      if (message.type === "response") {
        const receipt = pending.get(message.requestID)
        if (!receipt) return
        clearTimeout(receipt.timer)
        pending.delete(message.requestID)
        if (message.ok) receipt.resolve(message.value)
        else receipt.reject(new Error(message.error))
      }
      if (message.type === "context") {
        Object.assign(labels, message.labels)
        applyTheme(message.context)
      }
      if (message.type === "state" && message.state.revision > revision) {
        revision = message.state.revision
        savedContent = JSON.stringify(message.state.content)
        if (!message.state.mutationID?.startsWith(`${config.nonce}:`)) {
          epoch++
          unpack(message.state.content)
          restore()
        }
      }
      if (message.type === "feedback") {
        feedback = !!message.active
        document.documentElement.dataset.renderFeedback = String(feedback)
      }
      if (message.type === "flush") {
        clearTimeout(viewTimer)
        const work = config.interactive ? persist() : Promise.resolve()
        work.then(
          () => port?.postMessage({ type: "flushed", requestID: message.requestID }),
          (error) =>
            port?.postMessage({ type: "flushed", requestID: message.requestID, error: String(error).slice(0, 2000) }),
        )
      }
      if (message.type === "dispose") {
        for (const id of frames.keys()) window.cancelAnimationFrame(id)
        pausedAnimations.clear()
        clearTimeout(viewTimer)
        for (const receipt of pending.values()) {
          clearTimeout(receipt.timer)
          receipt.reject(new Error(labels.closed))
        }
        pending.clear()
        port?.close()
        port = undefined
      }
    }
    port.start()
    resolveReady()
    measure()
  }
  window.addEventListener("message", connect)
  if (config.offline) resolveReady()
  else parent.postMessage({ type: "synergy.render.ready", nonce: config.nonce }, "*")
  function measure() {
    const height = Math.min(32000, Math.max(48, document.body?.offsetHeight ?? 0, document.body?.scrollHeight ?? 0))
    port?.postMessage({ type: "resize", height })
  }
  document.addEventListener("change", () => {
    if (config.interactive) {
      clearTimeout(viewTimer)
      persist().catch(report)
    }
  })
  const annotations = new Map<
    Element,
    { id: string; label: string; hitTest?: (x: number, y: number) => { id: string; label: string } | undefined }
  >()
  api.annotate = (element, options) => {
    if (annotations.size >= 200) throw new Error(labels.tooMany)
    annotations.set(element, options)
    element.setAttribute("data-render-annotation", options.id.slice(0, 120))
  }
  document.addEventListener(
    "click",
    async (event) => {
      if (event.composedPath().some((target) => target instanceof Element && target.matches("a[href], area[href]")))
        event.preventDefault()
      if (!feedback || !(event.target instanceof Element)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const element = event.target.closest("[data-render-annotation]") ?? event.target
      const registered = annotations.get(element)
      const rect = element.getBoundingClientRect()
      const x = event.clientX - rect.left,
        y = event.clientY - rect.top
      const object = registered?.hitTest?.(x, y)
      const details = {
        version: config.version,
        variant: view.variant,
        id: object?.id ?? registered?.id ?? element.id,
        label: object?.label ?? registered?.label ?? element.tagName,
        selection: String(window.getSelection()).slice(0, 1000),
        text: element.textContent?.slice(0, 1000),
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        parameters: view.controls,
      }
      const image = await capture(element)
      request("followup", {
        text: `${labels.feedback}\n${JSON.stringify({ ...details, screenshot: image ? "attached" : "unavailable" })}\n`,
        ...(image ? { image } : {}),
      }).catch(report)
    },
    true,
  )
  document.addEventListener("submit", (event) => event.preventDefault(), true)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) port?.postMessage({ type: "escape" })
  })
  document.addEventListener("input", () => {
    if (!config.interactive) return
    view.forms = Object.fromEntries(
      fields().map((element, index) => [
        fieldKey(element, index),
        element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
          ? element.checked
          : element.value.slice(0, 2000),
      ]),
    )
    saveView()
  })
  window.addEventListener(
    "scroll",
    () => {
      view.scroll = window.scrollY
      if (config.interactive) saveView()
    },
    { passive: true },
  )
  window.addEventListener("error", (event) => report(event.message || labels.resourceFailed))
  window.addEventListener("unhandledrejection", (event) => report(event.reason))
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      const observer = new ResizeObserver(measure)
      observer.observe(document.body)
      document.fonts?.ready.then(measure)
      restore()
      measure()
    },
    { once: true },
  )
}
