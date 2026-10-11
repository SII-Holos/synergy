import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
  useContext,
  type ParentProps,
} from "solid-js"
import { useLingui } from "@lingui/solid"
import "./process-viewport.css"
import { useConversationLiveRevision } from "./conversation-motion"
import { readSelectionRanges } from "../utils/selection"
import { createScrollMotion } from "../utils/scroll-motion"

const Contained = createContext<{ disclose(event: Event): () => void }>()
export const useProcessViewport = () => !!useContext(Contained)
export const useProcessDisclosure = () => useContext(Contained)
export type ProcessReadingAnchor = {
  key: string
  offset: number
  partID?: string
  block?: number
  fragment?: boolean
  reasoningIdentity?: string
}
type ReadingAnchor = ProcessReadingAnchor
const positions = new Map<string, { offset: number; following: boolean; anchor?: ReadingAnchor }>()

const anchorSelector =
  '[data-slot="activity-step"][data-part-id], [data-component="process-reasoning"][data-part-id], [data-reasoning-part][data-part-id], [data-display-row]'
const blockSelector = "p,li,pre,h1,h2,h3,h4,h5,h6"

export function captureProcessReadingAnchor(viewport: HTMLElement, target?: Element): ReadingAnchor | undefined {
  const bounds = viewport.getBoundingClientRect()
  const pointed = target?.closest<HTMLElement>(anchorSelector)
  const part =
    (pointed && viewport.contains(pointed) ? pointed : undefined) ??
    [...viewport.querySelectorAll<HTMLElement>(anchorSelector)].find((element) => {
      if (
        element.dataset.displayRow &&
        element.querySelector('[data-slot="activity-step"], [data-component="process-reasoning"]')
      )
        return false
      const fragment = element.matches('[data-component="process-reasoning"]')
        ? element.querySelector("[data-reasoning-part]")
        : undefined
      if (fragment && !fragment.closest("[hidden]")) return false
      const rect = element.getBoundingClientRect()
      return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
    })
  if (!part) return
  const blocks = [...part.querySelectorAll<HTMLElement>(blockSelector)]
  const block = target
    ? -1
    : blocks.findIndex((element) => {
        const rect = element.getBoundingClientRect()
        return !element.closest("[hidden]") && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
      })
  const node =
    block >= 0 ? blocks[block] : (part.querySelector<HTMLElement>('[data-slot="process-reasoning-trigger"]') ?? part)
  return {
    key: part.closest<HTMLElement>("[data-display-row]")?.dataset.displayRow ?? part.dataset.partId!,
    partID: part.dataset.partId,
    fragment: part.hasAttribute("data-reasoning-part") || undefined,
    reasoningIdentity: part.closest<HTMLElement>('[data-component="process-reasoning"]')?.dataset.reasoningIdentity,
    block,
    offset: node.getBoundingClientRect().top - bounds.top,
  }
}

export function processReadingAnchorNode(viewport: HTMLElement, anchor: ReadingAnchor) {
  const reasoningTrigger = () =>
    [...viewport.querySelectorAll<HTMLElement>('[data-component="process-reasoning"]')]
      .find(
        (element) =>
          anchor.reasoningIdentity &&
          element.dataset.reasoningIdentity === anchor.reasoningIdentity &&
          element.querySelector('[data-slot="process-reasoning-trigger"]'),
      )
      ?.querySelector<HTMLElement>('[data-slot="process-reasoning-trigger"]')
  if (anchor.reasoningIdentity && !anchor.fragment) return reasoningTrigger()
  const part = [...viewport.querySelectorAll<HTMLElement>(anchorSelector)].find((element) => {
    if (
      element.dataset.displayRow &&
      element.querySelector('[data-slot="activity-step"], [data-component="process-reasoning"]')
    )
      return false
    if (anchor.fragment && !element.hasAttribute("data-reasoning-part")) return false
    return anchor.partID ? element.dataset.partId === anchor.partID : element.dataset.displayRow === anchor.key
  })
  if (!part) return reasoningTrigger()
  if (anchor.fragment)
    return !part.closest("[hidden]") && part.getBoundingClientRect().height > 0 ? part : reasoningTrigger()
  const block =
    anchor.block !== undefined && anchor.block >= 0
      ? part.querySelectorAll<HTMLElement>(blockSelector)[anchor.block]
      : undefined
  return block && !block.closest("[hidden]") && block.getBoundingClientRect().height > 0
    ? block
    : (part.querySelector<HTMLElement>('[data-slot="process-reasoning-trigger"]') ?? part)
}

export function restoreProcessReadingAnchor(viewport: HTMLElement, anchor: ReadingAnchor) {
  const node = processReadingAnchorNode(viewport, anchor)
  if (!node) return false
  const displacement = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset
  if (Math.abs(displacement) > 0.5) viewport.scrollTop += displacement
  return true
}

export function ProcessViewport(
  props: ParentProps<{
    identity: string
    active: boolean
    revision?: string
    parentFollowing?: boolean
    ref?: (element: HTMLDivElement) => void
    onScroll?: () => void
    onReading?: (value: boolean) => void
    onInteraction?: () => void
    isLayoutMutation?: (record: MutationRecord) => boolean
    anchor?: (target?: Element) => ReadingAnchor | undefined
    restoreAnchor?: (anchor: ReadingAnchor) => boolean | void
    onWidthChange?: (width: number) => void
    onBeforeLayoutChange?: (event: Event) => void
    controls?: (value: { pause(anchor?: ReadingAnchor): void }) => void
  }>,
) {
  const { _ } = useLingui()
  const liveRevision = useConversationLiveRevision()
  const saved = positions.get(props.identity)
  const [following, setFollowing] = createSignal(saved?.following ?? true)
  const [overflow, setOverflow] = createSignal(false)
  const [above, setAbove] = createSignal(false)
  const [below, setBelow] = createSignal(false)
  let viewport!: HTMLDivElement, content!: HTMLDivElement, motionTarget!: HTMLDivElement
  const motion = createScrollMotion(() => motionTarget)
  let followReady = false
  let frame: number | undefined
  let restoreFrame: number | undefined
  let layoutReleaseFrame: number | undefined
  let layoutPending = false
  let releaseFrame: number | undefined
  let captureFrame: number | undefined
  let capturedOffset = 0
  let movementPending = false
  let pagingPending = false
  let pagingAnchorPending = false
  let notifiedReading = false
  let resumeRequested = false
  let explicitFollow = false
  let previousOffset = 0
  let readingAnchor = saved?.anchor
  let restoring = !!saved?.anchor && !saved.following
  let disclosureAnchor: ReadingAnchor | undefined
  let disclosureGeneration = 0
  let disposed = false
  let restoredOffset: number | undefined
  const capture = (target?: Element) => props.anchor?.(target) ?? captureProcessReadingAnchor(viewport, target)
  const notifyReading = (value: boolean) => {
    if (notifiedReading === value) return
    notifiedReading = value
    props.onReading?.(value)
  }
  const cancelCapture = () => {
    if (captureFrame !== undefined) cancelAnimationFrame(captureFrame)
    captureFrame = undefined
    movementPending = false
    pagingPending = false
  }
  const refreshAnchor = () => {
    if (disposed || restoring || disclosureAnchor || layoutPending) return
    if (captureFrame === undefined) {
      readingAnchor = capture()
      captureFrame = requestAnimationFrame(() => {
        captureFrame = undefined
      })
    } else if (viewport.scrollTop !== capturedOffset) {
      readingAnchor = capture()
    }
    capturedOffset = viewport.scrollTop
  }
  const restore = (anchor: ReadingAnchor) => {
    let measured: boolean | void = true
    if (props.restoreAnchor) measured = props.restoreAnchor(anchor)
    else restoreProcessReadingAnchor(viewport, anchor)
    restoredOffset = viewport.scrollTop
    if (measured !== false) capturedOffset = restoredOffset
    return measured !== false
  }
  const preserve = () => {
    if (pagingPending) {
      layoutPending = true
      return
    }
    if (restoreFrame !== undefined) return
    if (layoutReleaseFrame !== undefined) cancelAnimationFrame(layoutReleaseFrame)
    layoutReleaseFrame = undefined
    layoutPending = true
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      if (movementPending && viewport.scrollTop !== capturedOffset) {
        cancelPreserve()
        refreshAnchor()
        return
      }
      const anchor = disclosureAnchor ?? readingAnchor
      if (anchor && !following() && !restore(anchor)) {
        preserve()
        return
      }
      layoutReleaseFrame = requestAnimationFrame(() => {
        layoutReleaseFrame = undefined
        layoutPending = false
        if (pagingAnchorPending) {
          pagingAnchorPending = false
          cancelCapture()
          refreshAnchor()
        }
      })
    })
  }
  const measureEdges = () => {
    const top = viewport.scrollTop
    const remaining = viewport.scrollHeight - viewport.clientHeight - top
    batch(() => {
      setAbove(top > 1)
      setBelow(remaining > 2)
    })
  }
  const cancelPreserve = () => {
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
    restoreFrame = undefined
    if (layoutReleaseFrame !== undefined) cancelAnimationFrame(layoutReleaseFrame)
    layoutReleaseFrame = undefined
    layoutPending = false
    pagingAnchorPending = false
  }
  const pause = (captureReading = true) => {
    motion.interrupt(viewport)
    movementPending = false
    pagingPending = false
    if (restoring || disclosureAnchor || layoutPending) cancelCapture()
    cancelPreserve()
    restoring = false
    disclosureAnchor = undefined
    disclosureGeneration++
    resumeRequested = false
    explicitFollow = false
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    setFollowing(false)
    props.onInteraction?.()
    if (captureReading) refreshAnchor()
    notifyReading(true)
  }
  // Provenance: https://github.com/SII-Holos/synergy/commit/7ee64f5a6fcb57ceaa06cafa4629edbe934043d5
  // Local adaptation: Movement owns its next scroll delivery; following resizes commit before paint.
  const beginMovement = () => {
    pause()
    movementPending = true
  }
  const disclose = (event: Event) => {
    pause(false)
    cancelCapture()
    props.onBeforeLayoutChange?.(event)
    const generation = ++disclosureGeneration
    disclosureAnchor = capture(event.target instanceof Element ? event.target : undefined)
    if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame)
    return () => {
      if (disposed || generation !== disclosureGeneration) return
      releaseFrame = requestAnimationFrame(() => {
        releaseFrame = undefined
        if (generation !== disclosureGeneration) return
        if (disclosureAnchor) restore(disclosureAnchor)
        readingAnchor = disclosureAnchor
        disclosureAnchor = undefined
      })
    }
  }
  const commitFollow = () => {
    if (following() && viewport)
      motion.move(viewport, viewport.scrollHeight, followReady && !content.querySelector("[data-motion-resizing]"))
  }
  const follow = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      commitFollow()
    })
  }
  const latest = () => {
    cancelCapture()
    cancelPreserve()
    if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame)
    releaseFrame = undefined
    restoring = false
    resumeRequested = false
    explicitFollow = true
    setFollowing(true)
    disclosureAnchor = undefined
    disclosureGeneration++
    notifyReading(false)
    follow()
  }
  createEffect(
    on(
      () => props.parentFollowing,
      (value, previous) => {
        if (value && previous === false && props.active) latest()
      },
      { defer: true },
    ),
  )
  const revision = createMemo(() => props.revision)
  createEffect(
    on(
      revision,
      () => {
        if (!untrack(following)) preserve()
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      liveRevision,
      () => {
        if (untrack(following) && props.active) follow()
      },
      { defer: true },
    ),
  )
  onMount(() => {
    let measuredWidth: number | undefined
    const measure = () => {
      const width = viewport.clientWidth
      if (width !== measuredWidth) {
        measuredWidth = width
        props.onWidthChange?.(width)
      }
      if (following()) {
        if (explicitFollow || props.active) commitFollow()
      } else preserve()
      const height = viewport.clientHeight
      const contentHeight = viewport.scrollHeight
      const top = viewport.scrollTop
      batch(() => {
        setOverflow(contentHeight > height + 1)
        setAbove(top > 1)
        setBelow(contentHeight - height - top > 2)
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    const mutations = new MutationObserver((records) => {
      if (!following() && records.some((record) => props.isLayoutMutation?.(record) ?? true)) preserve()
    })
    mutations.observe(content, { childList: true, characterData: true, subtree: true })
    if (saved?.offset) viewport.scrollTop = saved.offset
    props.controls?.({
      pause: (anchor) => {
        pause(!anchor)
        if (!anchor) return
        cancelCapture()
        readingAnchor = anchor
      },
    })
    if (saved?.anchor && !saved.following) {
      frame = requestAnimationFrame(() => {
        frame = undefined
        restore(saved.anchor!)
      })
    }
    if (saved && !saved.following) {
      props.onInteraction?.()
      notifyReading(true)
    }
    const selection = () => {
      if (
        readSelectionRanges(document).some(
          (range) => viewport.contains(range.startContainer) || viewport.contains(range.endContainer),
        )
      )
        pause()
    }
    document.addEventListener("selectionchange", selection)
    onCleanup(() => {
      observer.disconnect()
      mutations.disconnect()
      document.removeEventListener("selectionchange", selection)
      positions.delete(props.identity)
      positions.set(props.identity, {
        offset: viewport.clientHeight ? viewport.scrollTop : previousOffset,
        following: following(),
        anchor: !following() ? readingAnchor : viewport.clientHeight ? capture() : readingAnchor,
      })
      if (positions.size > 128) positions.delete(positions.keys().next().value!)
      notifyReading(false)
    })
    measure()
    followReady = true
  })
  onCleanup(() => {
    disposed = true
    motion.dispose()
    cancelCapture()
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
    if (layoutReleaseFrame !== undefined) cancelAnimationFrame(layoutReleaseFrame)
    if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame)
  })
  return (
    <div
      data-component="process-window"
      data-overflow={overflow() ? "" : undefined}
      data-above={above() ? "" : undefined}
      data-below={below() ? "" : undefined}
    >
      <div
        data-component="process-viewport"
        data-scroll-viewport="vertical"
        data-overflow={overflow() ? "" : undefined}
        role="region"
        aria-label={_({ id: "session.process.records", message: "Process history" })}
        tabIndex={overflow() ? 0 : undefined}
        ref={(element) => {
          viewport = element
          props.ref?.(element)
        }}
        onFocusIn={(event) => {
          if (event.target !== viewport) pause()
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) beginMovement()
          if (event.deltaY > 0) {
            if (!following()) beginMovement()
            resumeRequested = true
          }
        }}
        onTouchStart={() => {
          beginMovement()
          resumeRequested = true
        }}
        onTouchMove={beginMovement}
        onPointerDown={(event) => {
          if (event.target === viewport) {
            beginMovement()
            resumeRequested = true
          }
        }}
        onPointerMove={(event) => {
          if (event.buttons && event.target === viewport) beginMovement()
        }}
        onKeyDown={(event) => {
          if ((event.target as Element).closest("input, textarea, [contenteditable='true']")) return
          if (event.key === " ") {
            if ((event.target as Element).closest("button, summary, [role='button']")) return
            if (event.shiftKey) beginMovement()
            else {
              if (!following()) beginMovement()
              resumeRequested = true
            }
          }
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) beginMovement()
          if (["ArrowDown", "PageDown"].includes(event.key)) {
            if (!following()) beginMovement()
            resumeRequested = true
          }
          if (event.key === "End") {
            event.preventDefault()
            latest()
          }
          if (
            event.isTrusted &&
            !event.defaultPrevented &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            movementPending &&
            event.key === " "
          ) {
            pagingPending = event.shiftKey
              ? viewport.scrollTop > 1
              : viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1
          }
        }}
        onScroll={() => {
          if (!viewport.clientHeight) return
          measureEdges()
          props.onScroll?.()
          const compensated = restoredOffset !== undefined && Math.abs(viewport.scrollTop - restoredOffset) < 1
          restoredOffset = undefined
          if (pagingPending && layoutPending) {
            if (readingAnchor)
              readingAnchor = { ...readingAnchor, offset: readingAnchor.offset - (viewport.scrollTop - capturedOffset) }
            capturedOffset = viewport.scrollTop
          } else if (movementPending && !compensated && viewport.scrollTop !== capturedOffset) {
            cancelPreserve()
          }
          if (!restoring && !disclosureAnchor && !compensated && !layoutPending) refreshAnchor()
          if (
            resumeRequested &&
            !compensated &&
            viewport.scrollTop > previousOffset &&
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 4 &&
            !following()
          )
            latest()
          previousOffset = viewport.scrollTop
        }}
        on:scrollend={() => {
          movementPending = false
          if (pagingPending) {
            pagingPending = false
            if (layoutPending) {
              if (readingAnchor)
                readingAnchor = {
                  ...readingAnchor,
                  offset: readingAnchor.offset - (viewport.scrollTop - capturedOffset),
                }
              capturedOffset = viewport.scrollTop
              pagingAnchorPending = true
              preserve()
            }
          }
        }}
      >
        <div ref={content} data-slot="process-viewport-content">
          <div ref={motionTarget} data-slot="process-viewport-motion">
            <Contained.Provider value={{ disclose }}>{props.children}</Contained.Provider>
          </div>
        </div>
      </div>
    </div>
  )
}
