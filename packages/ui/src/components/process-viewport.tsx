import {
  createContext,
  createEffect,
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
  let viewport!: HTMLDivElement, content!: HTMLDivElement
  let frame: number | undefined
  let resumeRequested = false
  let previousOffset = 0
  const pause = () => {
    resumeRequested = false
    if (!overflow()) return
    setFollowing(false)
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
    setFollowing(true)
    setUnread(false)
    props.onReading?.(false)
    follow(true)
  }
  createEffect(
    on(
      () => props.revision,
      () => {
        if (!untrack(following)) setUnread(true)
        else if (props.active) follow()
      },
      { defer: true },
    ),
  )
  onMount(() => {
    const measure = () => {
      setOverflow(viewport.scrollHeight > viewport.clientHeight + 1)
      if (props.active && following()) follow()
    }
    const observer = new ResizeObserver(measure)
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
      positions.set(props.identity, { offset: viewport.scrollTop, following: following(), anchor: props.anchor?.() })
      if (positions.size > 128) positions.delete(positions.keys().next().value!)
      props.onReading?.(false)
    })
    measure()
  })
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  return (
    <div data-component="process-window">
      <Show when={!following() && unread()}>
        <button
          type="button"
          data-slot="process-latest"
          onClick={latest}
          aria-label={_({ id: "session.process.latest", message: "Back to latest" })}
          title={_({ id: "session.process.latest", message: "Back to latest" })}
        >
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
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pause()
          if (["ArrowDown", "PageDown"].includes(event.key)) resumeRequested = true
          if (event.key === "End") latest()
        }}
        onScroll={() => {
          props.onScroll?.()
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
