import { createEffect, createSignal, createUniqueId, For, onCleanup, untrack } from "solid-js"
import { resolveThemeColor } from "@ericsanchezok/synergy-plugin/theme"
import { useViewActivity } from "../context/view-activity"
import { getAppliedTheme, THEME_CHANGE_EVENT } from "../theme/application"
import { useConversationLiveRevision, useConversationMotionReady } from "./conversation-motion"
import {
  completionRibbonGeometry,
  drawCompletionRibbon,
  ribbonStrips,
  type RibbonPalette,
} from "./completion-ribbon-geometry"
import "./completion-ribbon.css"

export function CompletionRibbon(props: { ref?: (element: SVGSVGElement) => void }) {
  const id = createUniqueId()
  return (
    <svg
      ref={props.ref}
      data-component="completion-ribbon"
      width="16"
      height="16"
      viewBox="0 0 48 48"
      aria-hidden="true"
    >
      <defs>
        <For each={ribbonStrips}>
          {(strip, index) => (
            <linearGradient
              id={`${id}-${index()}`}
              gradientUnits="userSpaceOnUse"
              x1={strip.gradient[0]}
              y1={strip.gradient[1]}
              x2={strip.gradient[2]}
              y2={strip.gradient[3]}
            >
              <For each={strip.colors}>
                {(color, stop) => (
                  <stop offset={stop() / (strip.colors.length - 1)} stop-color={`var(--brand-ribbon-${color})`} />
                )}
              </For>
            </linearGradient>
          )}
        </For>
      </defs>
      <For each={ribbonStrips}>
        {(strip, index) => <polygon points={strip.points} fill={`url(#${id}-${index()})`} />}
      </For>
    </svg>
  )
}

function lastReplyLine(root: HTMLElement, messageID: string, viewport: DOMRect) {
  const scope = root.closest('[data-component="virtual-conversation-rows"]') ?? root
  const replies = [...scope.querySelectorAll<HTMLElement>("[data-completion-reply]")].filter(
    (element) => element.dataset.completionReply === messageID,
  )
  for (const reply of replies.reverse()) {
    const walker = reply.ownerDocument.createTreeWalker(reply, reply.ownerDocument.defaultView!.NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    for (const node of nodes.reverse()) {
      const end = node.data.trimEnd().length
      if (!end || node.parentElement?.closest('button, [hidden], [aria-hidden="true"]')) continue
      const range = reply.ownerDocument.createRange()
      range.setStart(node, 0)
      range.setEnd(node, end)
      const rectangles = [...range.getClientRects()]
      const rect = rectangles.findLast(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > viewport.top &&
          rect.top < viewport.bottom &&
          rect.right > viewport.left &&
          rect.left < viewport.right,
      )
      if (rect) return { range, rect }
    }
  }
}

export function createCompletionRibbon(options: {
  root(): HTMLElement | undefined
  replyID(): string | undefined
  working(): boolean
  completed(): boolean
  following(): boolean
}) {
  const active = useViewActivity()
  const ready = useConversationMotionReady()
  const liveRevision = useConversationLiveRevision()
  const [visible, setVisible] = createSignal(typeof document !== "undefined" && document.visibilityState === "visible")
  const reduced = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined
  const [reduce, setReduce] = createSignal(reduced?.matches ?? false)
  let target: SVGSVGElement | undefined
  let frame: number | undefined
  let canvas: HTMLCanvasElement | undefined
  let releaseTheme: (() => void) | undefined
  let armed = false
  let previousRevision = untrack(liveRevision)
  let previousWorking = false
  let previousCompleted = false
  const stop = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    canvas?.remove()
    canvas = undefined
    releaseTheme?.()
    releaseTheme = undefined
    target?.removeAttribute("data-travelling")
  }
  const visibility = () => setVisible(document.visibilityState === "visible")
  const preference = () => setReduce(reduced?.matches ?? false)
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility)
  reduced?.addEventListener("change", preference)

  const play = () => {
    frame = undefined
    const root = options.root(),
      signature = target,
      replyID = options.replyID()
    if (!root?.isConnected || !signature?.isConnected || !replyID || reduced?.matches) return stop()
    const document = signature.ownerDocument
    const window = document.defaultView!
    const viewport = root.closest<HTMLElement>("[data-conversation-viewport]")
    const bounds = () => viewport?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
    const clip = bounds()
    const source = lastReplyLine(root, replyID, clip)
    const seal = signature.getBoundingClientRect()
    if (!source || !seal.width || seal.top < clip.top || seal.bottom > clip.bottom) return stop()
    let palette: RibbonPalette | undefined
    const colors = () => {
      const applied = getAppliedTheme(document)
      if (!applied) return
      palette = {
        start: resolveThemeColor(applied.tokens, "brand-ribbon-start"),
        middle: resolveThemeColor(applied.tokens, "brand-ribbon-middle"),
        end: resolveThemeColor(applied.tokens, "brand-ribbon-end"),
      }
    }
    colors()
    if (!palette) return stop()
    const overlay = document.createElement("canvas")
    const context = overlay.getContext("2d")
    if (!context) return stop()
    overlay.dataset.component = "completion-ribbon-overlay"
    overlay.setAttribute("aria-hidden", "true")
    overlay.style.left = `${Math.max(0, clip.left)}px`
    overlay.style.top = `${Math.max(0, clip.top)}px`
    const width = Math.min(window.innerWidth, clip.right) - Math.max(0, clip.left)
    const height = Math.min(window.innerHeight, clip.bottom) - Math.max(0, clip.top)
    if (width <= 0 || height <= 0) return stop()
    overlay.style.width = `${width}px`
    overlay.style.height = `${height}px`
    const ratio = window.devicePixelRatio || 1
    overlay.width = Math.ceil(width * ratio)
    overlay.height = Math.ceil(height * ratio)
    context.scale(ratio, ratio)
    document.body.appendChild(overlay)
    canvas = overlay
    signature.setAttribute("data-travelling", "")
    document.addEventListener(THEME_CHANGE_EVENT, colors)
    releaseTheme = () => document.removeEventListener(THEME_CHANGE_EVENT, colors)
    const started = performance.now()
    let range = source.range
    const tick = (now: number) => {
      frame = undefined
      if (!signature.isConnected || reduced?.matches || document.visibilityState !== "visible") {
        stop()
        return
      }
      const destination = signature.getBoundingClientRect()
      let line = [...range.getClientRects()].at(-1)
      if (!range.endContainer.isConnected || !line) {
        const replacement = lastReplyLine(root, replyID, clip)
        if (replacement) {
          range = replacement.range
          line = replacement.rect
        } else line = undefined
      }
      const currentBounds = bounds()
      if (
        !line ||
        line.bottom <= clip.top ||
        line.top >= clip.bottom ||
        destination.top < clip.top ||
        destination.bottom > clip.bottom ||
        currentBounds.left !== clip.left ||
        currentBounds.top !== clip.top ||
        currentBounds.width !== clip.width ||
        currentBounds.height !== clip.height
      ) {
        stop()
        return
      }
      const left = Math.max(0, clip.left),
        top = Math.max(0, clip.top)
      const geometry = completionRibbonGeometry(
        new DOMRect(line.left - left, line.top - top, line.width, line.height),
        new DOMRect(destination.left - left, destination.top - top, destination.width, destination.height),
        width,
      )
      if (!geometry) return stop()
      context.clearRect(0, 0, width, height)
      if (drawCompletionRibbon(context, geometry, now - started, palette!)) {
        stop()
      } else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
  }

  createEffect(() => {
    const revision = liveRevision()
    const working = options.working()
    const completed = options.completed()
    const eligible = active() && ready() && visible() && !reduce() && !reduced?.matches && options.following()
    if (!eligible || revision < previousRevision) {
      armed = false
      stop()
    } else if (revision > previousRevision && (working || previousWorking)) armed = true
    if (completed && !previousCompleted) {
      if (armed && eligible) {
        stop()
        target?.setAttribute("data-travelling", "")
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(play)
        })
      }
      armed = false
    }
    if (!completed) stop()
    previousRevision = revision
    previousWorking = working
    previousCompleted = completed
  })
  onCleanup(() => {
    stop()
    document.removeEventListener("visibilitychange", visibility)
    reduced?.removeEventListener("change", preference)
  })
  return (element: SVGSVGElement) => {
    target = element
  }
}
