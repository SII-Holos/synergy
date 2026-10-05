import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  useContext,
  type ParentProps,
} from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import "./process-viewport.css"

const Contained = createContext(false)
export const useProcessViewport = () => useContext(Contained)
type ReadingAnchor = { key: string; offset: number; partID?: string }
const positions = new Map<string, { offset: number; following: boolean; anchor?: ReadingAnchor }>()

export function ProcessViewport(
  props: ParentProps<{
    identity: string
    active: boolean
    revision?: string
    following?: boolean
    ref?: (element: HTMLDivElement) => void
    onScroll?: () => void
    onReading?: (value: boolean) => void
    anchor?: () => ReadingAnchor | undefined
    restoreAnchor?: (anchor: ReadingAnchor) => void
    controls?: (value: { pause(): void }) => void
  }>,
) {
  const { _ } = useLingui()
  const saved = positions.get(props.identity)
  const [following, setFollowing] = createSignal(saved?.following ?? true)
  const [overflow, setOverflow] = createSignal(false)
  const [unread, setUnread] = createSignal(false)
  const [above, setAbove] = createSignal(false)
  const [below, setBelow] = createSignal(false)
  let viewport!: HTMLDivElement, content!: HTMLDivElement
  let frame: number | undefined
  let measureFrame: number | undefined
  let resumeRequested = false
  let explicitFollow = false
  let previousOffset = 0
  let readingAnchor = saved?.anchor
  const measureEdges = () => {
    const top = viewport.scrollTop
    const remaining = viewport.scrollHeight - viewport.clientHeight - top
    batch(() => {
      setAbove(top > 1)
      setBelow(remaining > 2)
    })
  }
  const pause = () => {
    resumeRequested = false
    explicitFollow = false
    if (!overflow()) return
    setFollowing(false)
    readingAnchor = props.anchor?.()
    props.onReading?.(true)
  }
  const follow = (force = false) => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (following() && viewport && (force || props.following !== false)) viewport.scrollTop = viewport.scrollHeight
    })
  }
  const latest = () => {
    resumeRequested = false
    explicitFollow = true
    setFollowing(true)
    setUnread(false)
    props.onReading?.(false)
    follow(true)
  }
  const revision = createMemo(() => props.revision)
  createEffect(
    on(
      revision,
      () => {
        if (!untrack(following)) setUnread(true)
        else if (props.active || explicitFollow) follow(explicitFollow)
      },
      { defer: true },
    ),
  )
  onMount(() => {
    const measure = () => {
      const height = viewport.clientHeight
      const contentHeight = viewport.scrollHeight
      const top = viewport.scrollTop
      batch(() => {
        setOverflow(contentHeight > height + 1)
        setAbove(top > 1)
        setBelow(contentHeight - height - top > 2)
      })
      if ((props.active || explicitFollow) && following()) follow(explicitFollow)
    }
    const observer = new ResizeObserver(() => {
      if (measureFrame !== undefined) return
      measureFrame = requestAnimationFrame(() => {
        measureFrame = undefined
        measure()
      })
    })
    observer.observe(viewport)
    observer.observe(content)
    if (saved) viewport.scrollTop = saved.offset
    else if (props.active) follow()
    props.controls?.({ pause })
    if (saved?.anchor && !saved.following) {
      frame = requestAnimationFrame(() => {
        frame = undefined
        props.restoreAnchor?.(saved.anchor!)
      })
      props.onReading?.(true)
    }
    const selection = () => {
      const value = document.getSelection()
      if (value && !value.isCollapsed && viewport.contains(value.anchorNode)) pause()
    }
    document.addEventListener("selectionchange", selection)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("selectionchange", selection)
      positions.delete(props.identity)
      positions.set(props.identity, {
        offset: viewport.clientHeight ? viewport.scrollTop : previousOffset,
        following: following(),
        anchor: viewport.clientHeight ? props.anchor?.() : readingAnchor,
      })
      if (positions.size > 128) positions.delete(positions.keys().next().value!)
      props.onReading?.(false)
    })
    measure()
  })
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
  })
  return (
    <div
      data-component="process-window"
      data-overflow={overflow() ? "" : undefined}
      data-above={above() ? "" : undefined}
      data-below={below() ? "" : undefined}
    >
      <Show when={overflow() && below() && !(unread() && !following())}>
        <span data-slot="process-more">{_({ id: "session.process.more", message: "More actions below" })}</span>
      </Show>
      <Show when={!following() && unread()}>
        <button
          type="button"
          data-slot="process-latest"
          onClick={latest}
          aria-label={_({ id: "session.process.newActions", message: "New actions" })}
          title={_({ id: "session.process.newActions", message: "New actions" })}
        >
          {_({ id: "session.process.newActions", message: "New actions" })}
          <Icon name={getSemanticIcon("navigation.latest")} size="small" />
        </button>
      </Show>
      <div
        data-component="process-viewport"
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
          if (event.deltaY < 0) pause()
          if (event.deltaY > 0) resumeRequested = true
        }}
        onTouchStart={() => {
          pause()
          resumeRequested = true
        }}
        onPointerDown={(event) => {
          if (event.target === viewport) {
            pause()
            resumeRequested = true
          }
        }}
        onKeyDown={(event) => {
          if ((event.target as Element).closest("input, textarea, [contenteditable='true']")) return
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pause()
          if (["ArrowDown", "PageDown"].includes(event.key)) resumeRequested = true
          if (event.key === "End") {
            event.preventDefault()
            latest()
          }
        }}
        onScroll={() => {
          if (!viewport.clientHeight) return
          measureEdges()
          props.onScroll?.()
          readingAnchor = props.anchor?.()
          if (
            resumeRequested &&
            viewport.scrollTop > previousOffset &&
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 4 &&
            !following()
          )
            latest()
          previousOffset = viewport.scrollTop
        }}
      >
        <div ref={content} data-slot="process-viewport-content">
          <Contained.Provider value={true}>{props.children}</Contained.Provider>
        </div>
      </div>
    </div>
  )
}
