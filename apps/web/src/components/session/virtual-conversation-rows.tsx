import type { PluginConversationService } from "@ericsanchezok/synergy-plugin"
import type { AssistantMessage, UserMessage, TurnExecutionState } from "@ericsanchezok/synergy-sdk"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { ActivityBatchLabel, ActivityBatchStatus } from "@ericsanchezok/synergy-ui/activity-batch"
import {
  processIsWorking,
  sessionActivityAnimating,
  sessionActivityLabel,
} from "@ericsanchezok/synergy-ui/session-status"
import { createDisclosureMotionRef, readSelectionElements } from "@ericsanchezok/synergy-ui/hooks"
import "./conversation-rows.css"
import { Dynamic } from "solid-js/web"
import { SessionTurn, resolveActivityDisclosure } from "@ericsanchezok/synergy-ui/session-turn"
import {
  createUserMessagePresentation,
  type UserMessagePresentation,
} from "@ericsanchezok/synergy-ui/user-message-content"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import { MessageSlotOutlet } from "@ericsanchezok/synergy-ui/message-slots"
import { useExecution } from "@/context/execution"
import { buildConversationRows, estimateConversationRowSize, type ConversationRow } from "./conversation-rows"
import { ToolExpansionProvider } from "@ericsanchezok/synergy-ui/tool-expansion"
import {
  ProcessViewport,
  captureProcessReadingAnchor,
  processReadingAnchorNode,
  type ProcessReadingAnchor,
} from "@ericsanchezok/synergy-ui/process-viewport"
import { ConversationMotionProvider } from "@ericsanchezok/synergy-ui/conversation-motion"
import { CompactionCard } from "@ericsanchezok/synergy-ui/compaction-card"
import { useData } from "@ericsanchezok/synergy-ui/context/data"
import { requestErrorMessage } from "../../utils/error"
import { PartContentSyncError } from "../../context/part-materializer"
import {
  conversationReadingIndex,
  createConversationLayoutBinding,
  createConversationLayoutCache,
} from "./conversation-layout"

// Provenance: https://github.com/inokawa/virtua/blob/0.42.3/src/solid/Virtualizer.tsx
// Local adaptation: Part identities, retained interaction rows and prepend offsets share the existing scroll element.
const layouts = createConversationLayoutCache()
const sameItems = <T,>(previous: T[], next: T[]) =>
  previous.length === next.length && previous.every((item) => next.includes(item))

type ProcessControls = {
  layoutOwner: readonly [server: string, scope: string, sessionID: string]
  liveRevision?: () => number
  takePartArrival?: (partID: string) => boolean
  messageKey?: (messageID: string) => string
  takeUserArrival?: (messageID: string) => boolean
  submissionFor?: (
    rootID: string,
  ) => { activity?: import("@ericsanchezok/synergy-sdk").SessionActivity; failed: boolean } | undefined
  executionFor?: (rootID: string) => TurnExecutionState | undefined
  connected?: () => boolean
  onRestoreChanges?: (messageID: string) => void
  onRowReady?: (owner: symbol, ready: boolean | undefined) => void
}

export function VirtualConversationRows(
  input: ProcessControls & {
    context: PluginConversationService
    scrollRef?: HTMLDivElement
    onReady?: (ready: boolean) => void
    onReadingMessage?: (messageID: string) => void
  },
) {
  const props = input.context
  const content = props.content!
  const { view } = useData()
  const paused = (rootID: string) =>
    rootID === props.lastUserMessage()?.id && view.statusFor(props.sessionID)?.type === "paused"
  const owner = input.layoutOwner
  const layoutIdentity = () =>
    JSON.stringify([...owner, "conversation", props.activityDisplay(), props.compactReasoning()])
  const pending = new Set<symbol>()
  const [pendingCount, setPendingCount] = createSignal(0)
  const onRowReady = (owner: symbol, ready: boolean | undefined) => {
    if (ready === false) pending.add(owner)
    else pending.delete(owner)
    setPendingCount(pending.size)
  }
  createEffect(() => input.onReady?.(pendingCount() === 0))
  const userPresentations = new Map<string, UserMessagePresentation>()
  const userPresentation = (messageID: string) => {
    const key = input.messageKey?.(messageID) ?? messageID
    let state = userPresentations.get(key)
    if (!state) userPresentations.set(key, (state = createUserMessagePresentation()))
    return state
  }
  createEffect(() => {
    const ids = new Set(
      props
        .timeline()
        .flatMap((root) => [
          root.id,
          ...(root.role === "user"
            ? props
                .turnProjection()
                .turnMessagesFor(root)
                .map((message) => message.id)
            : []),
        ])
        .map((id) => input.messageKey?.(id) ?? id),
    )
    for (const id of userPresentations.keys()) if (!ids.has(id)) userPresentations.delete(id)
  })
  const [handle, setHandle] = createSignal<VirtualizerHandle>()
  const [mounted, setMounted] = createSignal(false)
  const [width, setWidth] = createSignal(0)
  const [located, setLocated] = createSignal<{ messageID: string; partID?: string }>()
  const [margin, setMargin] = createSignal(0)
  const [retained, setRetained] = createSignal<string[]>([], { equals: sameItems })
  const [interactionBlocks, setInteractionBlocks] = createSignal<string[]>([], { equals: sameItems })
  const [readingBlocks, setReadingBlocks] = createSignal<string[]>([])
  const [readingOwner, setReadingOwner] = createSignal<string>()
  const [outerReadingOwner, setOuterReadingOwner] = createSignal<string>()
  const [interactionRoots, setInteractionRoots] = createSignal<string[]>([], { equals: sameItems })
  const [expanded, setExpanded] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  let manualProcess: { rootID: string; opening: boolean } | undefined
  const activityView = {
    getExpanded: (key: string) => props.activityView?.getExpanded(key) ?? expanded().get(key),
    setExpanded: (key: string, value: boolean) => {
      if (props.activityView) props.activityView.setExpanded(key, value)
      else setExpanded((previous) => new Map(previous).set(key, value))
    },
  }
  const processState = createMemo((previous: Map<string, { working: boolean; held: boolean }> | undefined) => {
    const next = new Map<string, { working: boolean; held: boolean }>()
    let changed = false
    for (const root of props.timeline()) {
      if (root.role !== "user") continue
      const state = input.executionFor?.(root.id)
      const last = previous?.get(root.id)
      const final = props
        .turnProjection()
        .turnMessagesFor(root)
        .findLast((message) => message.role === "assistant")
      const submission = input.submissionFor?.(root.id)
      const working = processIsWorking({
        current: root.id === props.lastUserMessage()?.id,
        sessionStatus: view.statusFor(props.sessionID),
        submission,
        projected: state?.status === "completed" && last?.working && final?.time.completed == null ? true : undefined,
        executionStatus: state?.status,
        fallback: root.id === props.lastUserMessage()?.id && props.isWorking(),
      })
      const reading =
        props.scrolledUp() ||
        interactionRoots().includes(root.id) ||
        readingBlocks().some((key) => key.startsWith(`${root.id}:activity:`))
      const held = paused(root.id) || (reading && (!!last?.held || (!!last?.working && !working)))
      if (last && working === last.working && held === last.held) next.set(root.id, last)
      else {
        changed = true
        next.set(root.id, { working, held })
      }
    }
    return !changed && previous?.size === next.size ? previous : next
  })
  const projectionRows = createMemo<ConversationRow[]>((previous) =>
    buildConversationRows({
      previous,
      timeline: props.timeline(),
      messageKey: input.messageKey,
      messagesFor: (root) => props.turnProjection().turnMessagesFor(root as UserMessage),
      summaries: content.summaries,
      page: content.page,
      activity: (block) =>
        activityView.getExpanded(block.key) ??
        (props.activityDisplay() === "full" ||
          ((interactionBlocks().includes(block.key) || readingBlocks().includes(block.key) || props.scrolledUp()) &&
            !!previous?.find((row) => row.key === block.key)?.activity?.open) ||
          (props.activityDisplay() !== "minimal" && (block.active || paused(block.entries[0].root.id)))),
      process: (root) => {
        const state = processState().get(root.id)!
        return {
          working: state.working,
          open: resolveActivityDisclosure({
            mode: props.activityDisplay(),
            working: state.working,
            heldOpen: state.held,
            explicit: activityView.getExpanded(`turn-process:${root.id}`),
          }),
        }
      },
    }),
  )
  const requestedRows = createMemo(() => projectionRows().filter((row) => row.kind !== "body" || !row.activity))
  let container: HTMLDivElement | undefined
  const [rows, setRows] = createSignal<ConversationRow[]>(requestedRows())
  createEffect(
    on(requestedRows, (next) => {
      const manual = manualProcess?.rootID
      const opening = manualProcess?.opening
      const current = untrack(rows)
      const previous = new Map(current.map((row) => [row.key, row]))
      const nextKeys = new Set(next.map((row) => row.key))
      const mounted = new Set(
        [...(container?.querySelectorAll<HTMLElement>("[data-display-row]") ?? [])].map(
          (row) => row.dataset.displayRow,
        ),
      )
      const exits = current.filter(
        (row) =>
          !nextKeys.has(row.key) &&
          mounted.has(row.key) &&
          ((row.kind === "body" && row.processBody) || row.kind === "activity" || row.activity),
      )
      const entering = { kind: "enter" as const }
      const merged = next.map((row) => {
        const prior = previous.get(row.key)
        const process = row.kind === "activity" || (row.kind === "body" && row.processBody)
        if (opening && manual === row.root.id && process && (!prior || prior.exiting)) {
          return { ...row, motion: entering }
        }
        return prior?.motion?.kind === "enter" && !prior.exiting ? { ...row, motion: prior.motion } : row
      })
      for (const row of exits) {
        const following = current.slice(current.indexOf(row) + 1).find((item) => nextKeys.has(item.key))
        const index = following ? merged.findIndex((item) => item.key === following.key) : merged.length
        merged.splice(index, 0, {
          ...row,
          exiting: true,
          motion: !opening && manual === row.root.id ? { kind: "exit" } : undefined,
        })
      }
      if (!opening || !next.some((row) => row.root.id === manual) || merged.some((row) => row.motion === entering))
        manualProcess = undefined
      setRows(merged)
    }),
  )
  const finishExit = (key: string) => setRows((previous) => previous.filter((row) => row.key !== key || !row.exiting))
  const releaseMotion = (motion: ConversationRow["motion"]) => {
    if (motion?.kind !== "enter") return
    setRows((previous) =>
      previous.some((row) => row.motion === motion)
        ? previous.map((row) => (row.motion === motion ? { ...row, motion: undefined } : row))
        : previous,
    )
  }
  const rowLayout = createMemo<{ keys: string[]; shift: boolean }>((previous) => {
    const keys = rows().map((row) => row.key)
    if (previous && keys.length === previous.keys.length && keys.every((key, index) => key === previous.keys[index]))
      return previous.shift ? { keys: previous.keys, shift: false } : previous
    const added = previous ? keys.length - previous.keys.length : 0
    return {
      keys,
      shift: added > 0 && !!previous && previous.keys.every((key, index) => keys[added + index] === key),
    }
  })
  const keys = () => rowLayout().keys
  const layout = createConversationLayoutBinding(layouts, {
    identity: () => untrack(layoutIdentity),
    keys: () => untrack(keys),
    width: () => untrack(width),
    changed: setHandle,
  })
  const byKey = createMemo(() => new Map(rows().map((row) => [row.key, row])))
  const ownsLocation = (row: ConversationRow, location: { messageID: string; partID?: string }) =>
    row.kind === "activity"
      ? row.activity.entries.some(
          (entry) =>
            entry.message.id === location.messageID &&
            (!location.partID || (entry.kind === "body" && entry.parts.some((part) => part.id === location.partID))),
        )
      : row.message.id === location.messageID &&
        (!location.partID || (row.kind === "body" && row.parts.some((part) => part.id === location.partID)))
  const locatedIndex = createMemo(() => {
    const location = located()
    return location ? rows().findIndex((row) => ownsLocation(row, location)) : -1
  })
  const kept = createMemo(() =>
    [
      ...new Set([
        ...retained().map((key) => keys().indexOf(key)),
        locatedIndex(),
        keys().indexOf(readingOwner() ?? ""),
        keys().indexOf(outerReadingOwner() ?? ""),
      ]),
    ].filter((index) => index >= 0),
  )
  const expansions = new Map<string, boolean>()
  const expansionState = {
    get: (id: string) => expansions.get(id),
    set: (id: string, open: boolean) => {
      expansions.delete(id)
      expansions.set(id, open)
      if (expansions.size > 4096) expansions.delete(expansions.keys().next().value!)
    },
  }
  let locationFrame: number | undefined
  let locationGeneration = 0
  let disposed = false
  createEffect(() => {
    const anchor = props.autoScroll?.readingAnchorOwner()
    const row =
      anchor?.closest('[data-component="process-window"]')?.parentElement?.closest<HTMLElement>("[data-display-row]") ??
      anchor?.closest<HTMLElement>("[data-display-row]")
    setOuterReadingOwner(row && container?.contains(row) ? row.dataset.displayRow : undefined)
  })
  const releaseLocation = (event?: Event) => {
    if (!(event?.target instanceof Element && event.target.closest('[data-component="process-viewport"]')))
      setReadingOwner(undefined)
    locationGeneration++
    setLocated(undefined)
    if (locationFrame !== undefined) cancelAnimationFrame(locationFrame)
    locationFrame = undefined
  }
  createEffect(() => {
    const scroll = input.scrollRef
    scroll?.addEventListener("conversation-reading-restored", releaseLocation)
    onCleanup(() => scroll?.removeEventListener("conversation-reading-restored", releaseLocation))
  })

  const locationElement = (row: ConversationRow, partID?: string) =>
    [...(container?.querySelectorAll<HTMLElement>(partID ? "[data-part-id]" : "[data-display-row]") ?? [])].find(
      (element) => (partID ? element.dataset.partId === partID : element.dataset.displayRow === row.key),
    )
  const scheduleLocation = (behavior: ScrollBehavior = "auto") => {
    if (!untrack(located) || locationFrame !== undefined) return
    locationFrame = requestAnimationFrame(() => {
      locationFrame = undefined
      const location = located(),
        virtual = handle(),
        scroll = input.scrollRef
      if (!location || !virtual || !scroll) return
      const index = rows().findIndex((row) => ownsLocation(row, location))
      if (index < 0) return
      const row = rows()[index]
      const element = locationElement(row, location.partID)
      const owner = locationElement(row)
      const offset =
        row.kind !== "activity" && element && owner
          ? element.getBoundingClientRect().top - owner.getBoundingClientRect().top
          : 0
      const top =
        margin() + virtual.getItemOffset(index) + offset - (parseFloat(getComputedStyle(scroll).scrollPaddingTop) || 0)
      if (Math.abs(scroll.scrollTop - Math.max(0, top)) > 0.5) scroll.scrollTo({ top, behavior })
      if (row.kind === "activity")
        container?.dispatchEvent(new CustomEvent("process-locate", { detail: { key: row.key, ...location } }))
    })
  }
  createEffect(
    on(
      rows,
      (next) => {
        const location = untrack(located)
        if (location && !next.some((row) => ownsLocation(row, location))) releaseLocation()
        else scheduleLocation()
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    disposed = true
    releaseLocation()
  })
  const pinInteraction = (event?: Event) => {
    const ids = new Set<string>()
    const roots = new Set<string>()
    const blocks = new Set<string>()
    const add = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement
      const row = element?.closest<HTMLElement>("[data-display-row]")
      if (row && container?.contains(row)) {
        const owner = row
          .closest('[data-component="process-window"]')
          ?.parentElement?.closest<HTMLElement>("[data-display-row]")
        ids.add(owner?.dataset.displayRow ?? row.dataset.displayRow!)
        roots.add(row.dataset.turnRoot!)
        if (row.dataset.activityBlock) blocks.add(row.dataset.activityBlock)
      }
    }
    const focus = event?.type === "focusout" ? (event as FocusEvent).relatedTarget : document.activeElement
    add(focus instanceof Node ? focus : null)
    if (container) for (const element of readSelectionElements(container, "[data-display-row]")) add(element)
    batch(() => {
      setRetained([...ids])
      setInteractionRoots([...roots])
      setInteractionBlocks([...blocks])
    })
  }
  onMount(() => {
    let measureFrame: number | undefined
    let viewportLimit: number | undefined
    const measure = () => {
      const scroll = input.scrollRef
      if (scroll && container) {
        const measuredWidth = container.clientWidth
        layout.resize(measuredWidth)
        setWidth(measuredWidth)
        const limit = scroll.clientHeight * 0.45
        let parent: HTMLElement | null = container
        let margin = 0
        while (parent && parent !== scroll) {
          margin += parent.offsetTop
          parent = parent.offsetParent as HTMLElement | null
        }
        if (parent !== scroll)
          margin = container.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
        if (limit !== viewportLimit) {
          viewportLimit = limit
          container.style.setProperty("--process-viewport-limit", `${limit}px`)
        }
        setMargin(margin)
      }
      scheduleLocation()
    }
    const observer = new ResizeObserver(() => {
      if (measureFrame !== undefined) return
      measureFrame = requestAnimationFrame(() => {
        measureFrame = undefined
        measure()
      })
    })
    if (container) observer.observe(container)
    if (container?.parentElement) observer.observe(container.parentElement)
    if (input.scrollRef) observer.observe(input.scrollRef)
    measure()
    setMounted(true)
    document.addEventListener("focusin", pinInteraction)
    document.addEventListener("focusout", pinInteraction)
    document.addEventListener("selectionchange", pinInteraction)
    input.scrollRef?.addEventListener("wheel", releaseLocation, { passive: true })
    input.scrollRef?.addEventListener("touchstart", releaseLocation, { passive: true })
    input.scrollRef?.addEventListener("pointerdown", releaseLocation)
    input.scrollRef?.addEventListener("keydown", releaseLocation)
    const release = props.registerMessageLocator?.(async (messageID, behavior, partID) => {
      releaseLocation()
      const generation = locationGeneration
      if (content.loadWindow && !(await content.loadWindow(messageID, partID))) return false
      if (disposed || generation !== locationGeneration) return false
      const root = props.timeline().find(
        (root) =>
          root.id === messageID ||
          (root.role === "user" &&
            props
              .turnProjection()
              .turnMessagesFor(root)
              .some((message) => message.id === messageID)),
      )
      if (root && root.id !== messageID) activityView.setExpanded(`turn-process:${root.id}`, true)
      if (partID || root?.id !== messageID) {
        const block = requestedRows().find((row) => row.kind === "activity" && ownsLocation(row, { messageID, partID }))
        if (block?.activity) activityView.setExpanded(block.activity.key, true)
      }
      const location = { messageID, partID }
      const owns = (row: ConversationRow) => ownsLocation(row, location)
      let index = rows().findIndex(owns)
      if (index < 0) return false
      setLocated(location)
      try {
        await content.load(messageID)
      } catch (error) {
        if (generation === locationGeneration) releaseLocation()
        throw error
      }
      if (disposed || generation !== locationGeneration) return false
      index = rows().findIndex(owns)
      if (index < 0 || !handle()) {
        releaseLocation()
        return false
      }
      scheduleLocation(behavior)
      for (let attempt = 0; attempt < 24; attempt++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (disposed || generation !== locationGeneration) return false
        const group = rows().find(owns)
        if (!group) break
        const element = locationElement(group, partID)
        const scroll = element?.closest<HTMLElement>('[data-component="process-viewport"]') ?? input.scrollRef
        const bounds = scroll?.getBoundingClientRect()
        const item = element?.getBoundingClientRect()
        if (bounds && item && item.height > 0 && item.bottom > bounds.top && item.top < bounds.bottom) return true
        scheduleLocation()
      }
      releaseLocation()
      return false
    })
    onCleanup(() => {
      observer.disconnect()
      if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
      release?.()
      document.removeEventListener("focusin", pinInteraction)
      document.removeEventListener("focusout", pinInteraction)
      document.removeEventListener("selectionchange", pinInteraction)
      input.scrollRef?.removeEventListener("wheel", releaseLocation)
      input.scrollRef?.removeEventListener("touchstart", releaseLocation)
      input.scrollRef?.removeEventListener("pointerdown", releaseLocation)
      input.scrollRef?.removeEventListener("keydown", releaseLocation)
    })
  })
  return (
    <ConversationMotionProvider takeArrival={input.takePartArrival} liveRevision={input.liveRevision}>
      <div ref={container} data-component="virtual-conversation-rows" class="w-full min-w-0 max-w-full">
        <Show when={mounted() && input.scrollRef}>
          <ToolExpansionProvider value={expansionState}>
            <Virtualizer
              ref={layout.ref}
              data={keys()}
              shift={rowLayout().shift}
              scrollRef={input.scrollRef}
              startMargin={margin()}
              overscan={4}
              keepMounted={kept()}
              cache={layout.restore()}
              onScroll={() => {
                const virtual = handle()
                if (!virtual) return
                const index = conversationReadingIndex(virtual, rows().length, margin())
                if (index !== undefined) input.onReadingMessage?.(rows()[index].root.id)
              }}
            >
              {(key) => {
                const row = createMemo<ConversationRow>((previous) => byKey().get(key) ?? previous!, byKey().get(key)!)
                return (
                  <ConversationDisplayRow
                    layoutOwner={owner}
                    context={props}
                    userPresentation={userPresentation}
                    located={located()}
                    row={row}
                    onExit={finishExit}
                    onMotionReleased={releaseMotion}
                    onBeforeProcessDisclosure={(rootID, opening, event) => {
                      props.autoScroll?.handleInteraction(event)
                      if (
                        event.currentTarget instanceof HTMLElement &&
                        event.currentTarget.dataset.slot === "turn-process-trigger"
                      )
                        manualProcess = { rootID, opening }
                    }}
                    activityView={activityView}
                    submissionFor={input.submissionFor}
                    takeUserArrival={input.takeUserArrival}
                    executionFor={input.executionFor}
                    connected={input.connected}
                    onRestoreChanges={input.onRestoreChanges}
                    onRowReady={onRowReady}
                    onReading={(key, reading) => {
                      setReadingOwner((previous) => (reading ? key : previous === key ? undefined : previous))
                      setReadingBlocks((previous) => {
                        const included = previous.includes(key)
                        if (reading === included) return previous
                        return reading ? [...previous, key] : previous.filter((value) => value !== key)
                      })
                    }}
                    onReadingInteraction={setReadingOwner}
                  />
                )
              }}
            </Virtualizer>
          </ToolExpansionProvider>
        </Show>
      </div>
    </ConversationMotionProvider>
  )
}

function ConversationDisplayRow(
  input: ProcessControls & {
    context: PluginConversationService
    row: () => ConversationRow
    onExit: (key: string) => void
    onMotionReleased?: (motion: ConversationRow["motion"]) => void
    onBeforeProcessDisclosure?: (rootID: string, opening: boolean, event: Event) => void
    activityView: NonNullable<PluginConversationService["activityView"]>
    onReading?: (key: string, reading: boolean) => void
    onReadingInteraction?: (key: string) => void
    userPresentation?: (messageID: string) => UserMessagePresentation
    located?: { messageID: string; partID?: string }
  },
) {
  const props = input.context
  const content = props.content!
  const row = input.row
  const [activityMounted, setActivityMounted] = createSignal(!!row().activity?.open)
  let manualDisclosure = false
  createEffect(() => {
    if (row().activity?.open) setActivityMounted(true)
  })
  const batchMotion = createDisclosureMotionRef({
    visible: () => !!row().activity?.open,
    animate: () => true,
    appear: () => manualDisclosure,
    resize: true,
    onHidden: () => setActivityMounted(false),
    onSettled: () => {
      manualDisclosure = false
    },
  })
  const execution = useExecution()
  const { _ } = useLingui()
  const entrance = untrack(() => (row().motion?.kind === "enter" ? row().motion : undefined))
  onCleanup(() => input.onMotionReleased?.(row().motion))
  const exitMotion = createDisclosureMotionRef({
    visible: () => !row().exiting,
    animate: () => !!row().motion || !props.scrolledUp(),
    appear: () => !!entrance && row().motion === entrance,
    resize: () => !!row().motion || row().kind !== "activity",
    onHidden: () => input.onExit(row().key),
    onSettled: () => input.onMotionReleased?.(row().motion),
  })
  const [loadFailure, setLoadFailure] = createSignal<{ error: unknown }>()
  const [partStates, setPartStates] = createStore<
    Record<string, { pending: boolean; failed: boolean; error?: unknown } | undefined>
  >({})
  const readinessOwner = Symbol()
  input.onRowReady?.(readinessOwner, false)
  onCleanup(() => input.onRowReady?.(readinessOwner, undefined))
  const [loading, setLoading] = createSignal(false)
  const [retry, setRetry] = createSignal(0)
  const ready = createMemo(() => {
    const current = row()
    const pageReady = !!content.page(current.message.id) || !!loadFailure()
    return current.kind === "load"
      ? pageReady
      : current.kind !== "body" || current.event
        ? true
        : pageReady &&
          current.parts.every((part) => {
            const state = partStates[part.id]
            return state && !state.pending
          })
  })
  const preparingProcess = createMemo(() => {
    const current = row()
    return current.kind === "body" && current.processBody && !ready()
  })
  createEffect(() => input.onRowReady?.(readinessOwner, !!ready()))
  let loadGeneration = 0
  let rowElement: HTMLDivElement | undefined
  let retryFocus: HTMLButtonElement | undefined
  const failure = () => {
    if (loadFailure()) return loadFailure()
    const current = row()
    if (current.kind !== "body") return
    return current.parts.map((part) => partStates[part.id]).find((state) => state?.failed)
  }
  const retrying = () => {
    const current = row()
    return (
      loading() ||
      (current.kind === "body" &&
        !loadFailure() &&
        !current.parts.some((part) => partStates[part.id]?.failed && !partStates[part.id]?.pending))
    )
  }
  const load = async () => {
    if (loading()) return
    const focused = document.activeElement
    if (
      focused instanceof HTMLButtonElement &&
      focused.closest("[data-content-error]") &&
      rowElement?.contains(focused)
    )
      retryFocus = focused
    const current = row()
    const refresh = !!content.page(current.message.id)?.stale
    if (current.kind === "body" && !loadFailure() && !refresh) {
      for (const part of current.parts) {
        if (!partStates[part.id]?.failed || partStates[part.id]?.pending) continue
        retainedParts.get(part.id)?.lease.release()
        retainedParts.delete(part.id)
      }
      setRetry((value) => value + 1)
      return
    }
    if (current.kind !== "load" && current.kind !== "body") return
    const generation = ++loadGeneration
    setLoading(true)
    try {
      if (refresh) await content.load(current.message.id)
      else if (current.kind === "load" && current.older && content.loadEarlier)
        await content.loadEarlier(current.message.id)
      else await content.load(current.message.id, current.kind === "load" && current.more, current.kind === "body")
      if (alive && generation === loadGeneration) setLoadFailure(undefined)
    } catch (error) {
      if (alive && generation === loadGeneration) setLoadFailure({ error })
    } finally {
      if (alive && generation === loadGeneration) setLoading(false)
    }
  }
  onMount(() => {
    props.onFirstTurnMounted()
    if (row().kind === "load") void load()
  })
  const staleLoadMessage = createMemo(() => {
    const current = row()
    return current.kind === "load" && content.page(current.message.id)?.stale ? current.message.id : undefined
  })
  createEffect(
    on(
      staleLoadMessage,
      (messageID) => {
        if (messageID) void load()
      },
      { defer: true },
    ),
  )
  const retainedParts = new Map<string, { version: string; lease: ReturnType<typeof content.retain> }>()
  let alive = true
  onCleanup(() => {
    alive = false
    loadGeneration++
    for (const entry of retainedParts.values()) entry.lease.release()
    retainedParts.clear()
  })
  createEffect(() => {
    const current = row()
    if (current.kind !== "body" || current.event) return
    const page = content.page(current.message.id)
    if (page && !page.stale) return
    const generation = ++loadGeneration
    void content
      .load(current.message.id)
      .then(() => {
        if (!alive || generation !== loadGeneration) return
        setLoadFailure(undefined)
        for (const entry of retainedParts.values()) entry.lease.release()
        retainedParts.clear()
        setRetry((value) => value + 1)
      })
      .catch((error) => {
        if (alive && generation === loadGeneration) setLoadFailure({ error })
      })
      .finally(() => {
        if (alive && generation === loadGeneration) setLoading(false)
      })
  })
  createEffect(() => {
    retry()
    const current = row()
    if (current.kind !== "body" || current.event) return
    const wanted = new Set(current.parts.map((part) => part.id))
    for (const part of current.parts) {
      const previous = retainedParts.get(part.id)
      if (previous?.version === part.content.version) continue
      const lease = content.retain(part)
      retainedParts.set(part.id, { version: part.content.version, lease })
      previous?.lease.release()
      setPartStates(
        part.id,
        reconcile({ pending: true, failed: partStates[part.id]?.failed ?? false, error: partStates[part.id]?.error }),
      )
      void lease.ready
        .then(() => {
          if (!alive || retainedParts.get(part.id)?.lease !== lease) return
          setPartStates(part.id, reconcile({ pending: false, failed: false }))
        })
        .catch((error) => {
          if (!alive || retainedParts.get(part.id)?.lease !== lease) return
          setPartStates(part.id, reconcile({ pending: false, failed: true, error }))
        })
    }
    for (const [key, entry] of retainedParts)
      if (!wanted.has(key)) {
        entry.lease.release()
        retainedParts.delete(key)
        setPartStates(key, undefined)
      }
  })
  createEffect(() => {
    const currentFailure = failure()
    const busy = !!currentFailure && retrying()
    if (busy || !retryFocus) return
    const previous = retryFocus
    retryFocus = undefined
    if (document.activeElement !== document.body && document.activeElement !== previous) return
    if (currentFailure && previous.isConnected) previous.focus({ preventScroll: true })
    else rowElement?.focus({ preventScroll: true })
  })
  const standalone = () => row().root.role === "assistant"
  const segment = () => {
    const current = row()
    return {
      user: current.kind === "body" && current.message.id === current.root.id,
      userHasText:
        current.message.role === "user" &&
        content.summaries(current.message.id).some((part) => part.type === "text" && part.render !== false),
      footer: current.kind === "footer",
      parts: current.kind === "body" ? current.parts : [],
      before: current.kind === "body" && current.before,
      after: current.kind === "body" && current.after,
      beforeTool: current.kind === "body" && current.beforeTool,
      beforeReasoning: current.kind === "body" && current.beforeReasoning,
      reasoningAnchors: current.kind === "body" ? current.reasoningAnchors : undefined,
      toolAttachments: current.kind === "body" ? current.toolAttachments : undefined,
      hiddenAttachments: current.kind === "body" ? current.hiddenAttachments : undefined,
      activityBody: current.kind === "body" && !!current.activity,
      processHeader: current.kind === "process",
      processBody: current.kind === "body" && current.processBody,
      contentMessageID: current.kind === "body" ? current.message.id : undefined,
      process: current.process,
    }
  }
  const anchor = () => {
    const current = row()
    return current.kind === "body" && current.before ? props.anchor(current.message.id) : undefined
  }
  const partID = () => {
    const current = row()
    if (
      current.kind === "body" &&
      input.located?.messageID === current.message.id &&
      current.parts.some((part) => part.id === input.located?.partID)
    )
      return input.located.partID
    return current.kind === "body" ? current.parts[0]?.id : undefined
  }
  return (
    <div
      ref={(element) => {
        rowElement = element
        exitMotion(element)
      }}
      tabIndex={-1}
      data-display-row={row().key}
      data-row-kind={row().kind}
      data-content-pending={preparingProcess() ? "" : undefined}
      style={{
        "min-height": preparingProcess() ? `${estimateConversationRowSize(row())}px` : undefined,
      }}
      data-activity-block={row().activity?.key}
      data-process-body={segment().processBody ? "" : undefined}
      data-turn-root={row().root.id}
      data-message-id={row().message.id}
      data-message-role={row().message.role}
      data-message-end={segment().after ? "" : undefined}
      data-part-id={partID()}
      id={anchor()}
      class="conversation-display-row min-w-0 w-full max-w-full"
    >
      <Show when={failure()}>
        <div
          data-content-error
          class="flex items-start gap-3 py-2 text-12-medium text-text-weak"
          role="status"
          aria-live="polite"
        >
          <div class="min-w-0 flex-1 break-words">
            <p>
              {failure()?.error instanceof PartContentSyncError
                ? _({ id: "session.content.syncFailed", message: "Couldn’t sync this content" })
                : _({ id: "session.content.loadFailed", message: "Couldn’t load this content" })}
            </p>
            <Show
              when={failure()?.error instanceof PartContentSyncError}
              fallback={<Show when={requestErrorMessage(failure()?.error, "")}>{(reason) => <p>{reason()}</p>}</Show>}
            >
              <p>
                {_({
                  id: "session.content.syncHint",
                  message: "This content is still updating. Try again in a moment.",
                })}
              </p>
            </Show>
          </div>
          <button
            type="button"
            class="shrink-0 text-12-medium text-text-strong hover:text-text-base disabled:text-text-weak"
            disabled={retrying()}
            onClick={() => void load()}
          >
            {retrying()
              ? _({ id: "session.content.retrying", message: "Retrying…" })
              : _({ id: "session.content.retry", message: "Retry loading content" })}
          </button>
        </div>
      </Show>
      <Show
        when={row().kind !== "load"}
        fallback={
          <div
            classList={{
              "min-h-6": !content
                .summaries(row().message.id)
                .some((part) => part.content.version.startsWith("optimistic:")),
            }}
            aria-busy={loading()}
          />
        }
      >
        <Show
          when={row().kind === "activity"}
          fallback={
            <Show
              when={!standalone()}
              fallback={
                <Show when={row().kind === "body"}>
                  <Show when={segment().before}>
                    <MessageSlotOutlet
                      slot="message.before"
                      sessionId={props.sessionID}
                      messageId={row().message.id}
                      role="assistant"
                    />
                  </Show>
                  <Dynamic
                    component={row().message.metadata?.source === "command" ? CommandResultOutput : MailboxMessage}
                    message={row().message as AssistantMessage}
                    partIDs={segment().parts.map((part) => part.id)}
                    showHeader={segment().before}
                    classes={{ root: "min-w-0 w-full relative", container: "w-full min-w-0 max-w-full" }}
                  />
                  <Show when={segment().after}>
                    <MessageSlotOutlet
                      slot="message.actions"
                      sessionId={props.sessionID}
                      messageId={row().message.id}
                      role="assistant"
                    />
                    <MessageSlotOutlet
                      slot="message.after"
                      sessionId={props.sessionID}
                      messageId={row().message.id}
                      role="assistant"
                    />
                  </Show>
                </Show>
              }
            >
              <Show
                when={
                  row().kind === "body" && (row() as Extract<ConversationRow, { kind: "body" }>).event === "compaction"
                }
                fallback={
                  <SessionTurn
                    onBeforeProcessLayoutChange={(event) => {
                      if (input.onBeforeProcessDisclosure)
                        input.onBeforeProcessDisclosure(row().root.id, !row().process?.open, event)
                      else props.autoScroll?.handleInteraction(event)
                    }}
                    takeUserArrival={input.takeUserArrival}
                    sessionID={props.sessionID}
                    messageID={row().root.id}
                    rootMessage={row().root as UserMessage}
                    messages={
                      row().kind === "footer" || row().kind === "process"
                        ? props.turnProjection().turnMessagesFor(row().root as UserMessage)
                        : [row().message]
                    }
                    segment={segment()}
                    copyMessageText={content.text}
                    userPresentation={
                      row().message.role === "user" ? input.userPresentation?.(row().message.id) : undefined
                    }
                    compactionParentIDs={props.turnProjection().compactionParentIDs}
                    activityDisplay={props.activityDisplay()}
                    activityView={input.activityView}
                    submission={input.submissionFor?.(row().root.id)}
                    executionState={input.executionFor?.(row().root.id)}
                    connected={input.connected?.()}
                    following={!props.scrolledUp()}
                    lastUserMessageID={props.lastUserMessage()?.id}
                    compactReasoning={props.compactReasoning()}
                    onRewind={
                      props.canRewind(row().root as UserMessage)
                        ? () => props.onRewind?.(row().root as UserMessage)
                        : undefined
                    }
                    rollbackActive={props.rollbackActive}
                    onReviewChanges={props.onReviewChanges}
                    onRestoreChanges={input.onRestoreChanges}
                    onForkMessage={props.onForkMessage}
                    executionSummary={
                      (row().kind === "footer" || row().kind === "process") && execution.available()
                        ? execution.round(row().root.id)
                        : undefined
                    }
                    onExecutionDetails={
                      row().kind === "footer" && execution.available()
                        ? () => void execution.open(row().root.id)
                        : undefined
                    }
                    classes={{
                      root: "min-w-0 w-full relative",
                      content: "flex flex-col justify-between !overflow-visible",
                      container: "w-full min-w-0 max-w-full",
                    }}
                  />
                }
              >
                <CompactionCard message={row().message} />
              </Show>
            </Show>
          }
        >
          <div data-component="conversation-activity">
            <button
              type="button"
              data-slot="activity-batch-trigger"
              aria-expanded={row().activity?.open}
              aria-controls={`${row().key}:content`}
              onClick={(event) => {
                const block = row().activity
                if (block) {
                  manualDisclosure = true
                  props.autoScroll?.handleInteraction(event)
                  input.activityView.setExpanded(block.key, !block.open)
                }
              }}
            >
              <span>
                {row().activity?.tools ? (
                  <ActivityBatchLabel
                    batch={row().activity!}
                    total={row().activity!.tools}
                    identity={row().key}
                    live={row().activity!.active}
                  />
                ) : row().activity?.entries.some((entry) => entry.kind === "body" && entry.event) ? (
                  _({ id: "session.process.records", message: "Process history" })
                ) : (
                  _({ id: "session.reasoning.title", message: "Reasoning" })
                )}
                <ConversationActivityStatus
                  layoutOwner={input.layoutOwner}
                  context={props}
                  row={row}
                  submissionFor={input.submissionFor}
                  executionFor={input.executionFor}
                  connected={input.connected}
                />
              </span>
              <Icon name={getSemanticIcon("navigation.expand")} size="small" />
            </button>
            <Show when={activityMounted()}>
              <div ref={batchMotion} id={`${row().key}:content`} data-slot="activity-batch-content">
                <ConversationActivityBody
                  layoutOwner={input.layoutOwner}
                  context={props}
                  row={row}
                  activityView={input.activityView}
                  onReading={input.onReading}
                  onReadingInteraction={input.onReadingInteraction}
                  submissionFor={input.submissionFor}
                  executionFor={input.executionFor}
                  connected={input.connected}
                  onRestoreChanges={input.onRestoreChanges}
                  onRowReady={input.onRowReady}
                />
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function ConversationActivityStatus(
  input: ProcessControls & { context: PluginConversationService; row: () => ConversationRow },
) {
  const { view } = useData()
  const { i18n } = useLingui()
  const props = input.context
  const row = input.row
  const sessionStatus = () => {
    const submission = input.submissionFor?.(row().root.id)
    return submission?.activity
      ? { type: "busy" as const, activity: submission.activity }
      : view.statusFor(props.sessionID)
  }
  const activityContext = () => ({
    rootID: row().root.id,
    approval:
      input.executionFor?.(row().root.id)?.status === "approval" ||
      (props.lastUserMessage()?.id === row().root.id && view.permissionsFor(props.sessionID).length > 0),
    question: props.lastUserMessage()?.id === row().root.id && view.questionsFor(props.sessionID).length > 0,
    connected: input.connected?.(),
  })
  const active = () => row().activity?.active && (sessionStatus()?.type === "busy" || sessionStatus()?.type === "retry")
  return (
    <ActivityBatchStatus
      label={active() ? sessionActivityLabel(sessionStatus(), i18n(), activityContext()) : undefined}
      animated={sessionActivityAnimating(sessionStatus(), activityContext())}
    />
  )
}

function ConversationActivityBody(
  input: ProcessControls & {
    context: PluginConversationService
    row: () => ConversationRow
    activityView: NonNullable<PluginConversationService["activityView"]>
    onReading?: (key: string, value: boolean) => void
    onReadingInteraction?: (key: string) => void
  },
) {
  const [scroll, setScroll] = createSignal<HTMLDivElement>()
  const [width, setWidth] = createSignal(0)
  const [handle, setHandle] = createSignal<VirtualizerHandle>()
  const [retained, setRetained] = createSignal<number[]>([], { equals: sameItems })
  const entries = () => input.row().activity?.entries ?? []
  const keys = createMemo(() => entries().map((entry) => entry.key))
  const estimatedSize = createMemo(() => {
    const rows = entries()
    return rows.length ? rows.reduce((total, row) => total + estimateConversationRowSize(row), 0) / rows.length : 28
  })
  let virtualRoot: HTMLDivElement | undefined
  const VirtualRoot = (props: JSX.HTMLAttributes<HTMLDivElement>) => (
    <div
      {...props}
      data-slot="process-virtualizer"
      ref={(element) => {
        virtualRoot = element
        if (typeof props.ref === "function") props.ref(element)
      }}
    />
  )
  const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry])))
  let viewport: HTMLDivElement | undefined
  let pause: ((anchor?: ProcessReadingAnchor) => void) | undefined
  const owner = input.layoutOwner
  const layoutIdentity = () =>
    JSON.stringify([
      ...owner,
      "activity",
      input.row().key,
      input.context.activityDisplay(),
      input.context.compactReasoning(),
    ])
  const layout = createConversationLayoutBinding(layouts, {
    identity: () => untrack(layoutIdentity),
    keys: () => untrack(keys),
    width: () => untrack(width),
    changed: setHandle,
  })
  let anchor: ProcessReadingAnchor | undefined
  let anchorFrame: number | undefined
  const captureAnchor = (target?: Element) => {
    if (!viewport) return
    anchor = captureProcessReadingAnchor(viewport, target)
  }
  const restoreAnchor = (saved: ProcessReadingAnchor) => {
    anchor = saved
    const index = saved.partID
        ? entries().findIndex((entry) => entry.kind === "body" && entry.parts.some((part) => part.id === saved.partID))
        : keys().indexOf(saved.key),
      virtual = handle()
    if (!virtual || !viewport) return
    let measured = true
    const align = () => {
      if (!viewport) return false
      const node = processReadingAnchorNode(viewport, saved),
        row = node?.closest<HTMLElement>("[data-display-row]")
      if (!node || !row) return false
      const nodeIndex = keys().indexOf(row.dataset.displayRow!)
      const targetIndex = nodeIndex >= 0 ? nodeIndex : index
      if (targetIndex < 0) return false
      measured = Math.abs(virtual.getItemSize(targetIndex) - row.parentElement!.getBoundingClientRect().height) < 0.5
      const offset = node.getBoundingClientRect().top - row.getBoundingClientRect().top - saved.offset
      const targetOffset = virtual.getItemOffset(targetIndex) + offset
      const legalOffset = Math.min(
        Math.max(0, viewport.scrollHeight - viewport.clientHeight),
        Math.max(0, targetOffset),
      )
      // Virtua retries imperative targets on later measurements; aligned anchors must not leave a stale request.
      if (Math.abs(viewport.scrollTop - legalOffset) < 0.5) return true
      virtual.scrollToIndex(targetIndex, {
        align: "start",
        offset,
      })
      return true
    }
    if (align()) return measured
    if (index < 0) return
    virtual.scrollToIndex(index, { align: "start", offset: -saved.offset })
    if (!saved.partID) return
    if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = undefined
      align()
    })
  }
  let previous = keys()
  createEffect(() => {
    const next = keys(),
      saved = anchor
    if (saved && next.indexOf(saved.key) > previous.indexOf(saved.key) && next.includes(previous[0])) {
      if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
      anchorFrame = requestAnimationFrame(() => {
        anchorFrame = undefined
        restoreAnchor(saved)
      })
    }
    previous = next
  })
  onCleanup(() => {
    if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
  })
  const pin = (event?: Event) => {
    const indices = new Set<number>()
    const add = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement
      const row = element?.closest<HTMLElement>("[data-display-row]")
      if (row && viewport?.contains(row)) {
        const index = keys().indexOf(row.dataset.displayRow!)
        if (index >= 0) indices.add(index)
      }
    }
    const focus = event?.type === "focusout" ? (event as FocusEvent).relatedTarget : document.activeElement
    add(focus instanceof Node ? focus : null)
    if (viewport) for (const element of readSelectionElements(viewport, "[data-display-row]")) add(element)
    setRetained([...indices])
  }
  onMount(() => {
    setScroll(viewport)
    const container = viewport?.closest('[data-component="virtual-conversation-rows"]')
    const locate = (event: Event) => {
      const target = (event as CustomEvent<{ key: string; messageID: string; partID?: string }>).detail
      if (target.key !== input.row().key) return
      const index = entries().findIndex(
        (entry) =>
          entry.message.id === target.messageID &&
          (!target.partID || (entry.kind === "body" && entry.parts.some((part) => part.id === target.partID))),
      )
      if (index >= 0) {
        pause?.({ key: entries()[index].key, partID: target.partID, offset: 0 })
        handle()?.scrollToIndex(index, { align: "start" })
      }
    }
    container?.addEventListener("process-locate", locate)
    document.addEventListener("focusin", pin)
    document.addEventListener("focusout", pin)
    document.addEventListener("selectionchange", pin)
    onCleanup(() => {
      container?.removeEventListener("process-locate", locate)
      document.removeEventListener("focusin", pin)
      document.removeEventListener("focusout", pin)
      document.removeEventListener("selectionchange", pin)
    })
  })
  return (
    <ProcessViewport
      identity={JSON.stringify([...owner, input.row().key])}
      isLayoutMutation={(record) => record.type !== "childList" || record.target !== virtualRoot}
      onInteraction={() => {
        if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
        anchorFrame = undefined
        input.context.autoScroll?.handleInteraction(new Event("process-reading"))
        input.onReadingInteraction?.(input.row().key)
      }}
      controls={(value) => {
        pause = value.pause
      }}
      anchor={(target) => {
        captureAnchor(target)
        return anchor
      }}
      restoreAnchor={restoreAnchor}
      onWidthChange={(value) => {
        layout.resize(value)
        setWidth(value)
      }}
      onBeforeLayoutChange={(event) => input.context.autoScroll?.handleInteraction(event)}
      active={input.row().activity?.active ?? false}
      parentFollowing={!input.context.scrolledUp()}
      revision={entries()
        .map((entry) =>
          entry.kind === "body" ? entry.parts.map((part) => `${part.id}:${part.content.version}`).join(",") : entry.key,
        )
        .join(";")}
      onReading={(value) => {
        if (value) input.onReadingInteraction?.(input.row().key)
        input.onReading?.(input.row().key, value)
      }}
      ref={(element) => {
        viewport = element
      }}
    >
      <Show when={scroll() && width() > 0}>
        <Virtualizer
          as={VirtualRoot}
          ref={layout.ref}
          data={keys()}
          scrollRef={scroll()}
          overscan={2}
          itemSize={estimatedSize()}
          keepMounted={retained()}
          cache={layout.restore()}
        >
          {(key) => {
            const row = createMemo<ConversationRow>((previous) => byKey().get(key) ?? previous!, byKey().get(key)!)
            return (
              <ConversationDisplayRow
                layoutOwner={owner}
                context={input.context}
                row={row}
                activityView={input.activityView}
                onExit={() => {}}
                submissionFor={input.submissionFor}
                executionFor={input.executionFor}
                connected={input.connected}
                onRestoreChanges={input.onRestoreChanges}
                onRowReady={input.onRowReady}
              />
            )
          }}
        </Virtualizer>
      </Show>
    </ProcessViewport>
  )
}
