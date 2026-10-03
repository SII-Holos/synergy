import type { PluginConversationService } from "@ericsanchezok/synergy-plugin"
import type { AssistantMessage, UserMessage, TurnExecutionState } from "@ericsanchezok/synergy-sdk"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createDisclosureMotionRef } from "@ericsanchezok/synergy-ui/hooks"
import "./conversation-rows.css"
import { Dynamic } from "solid-js/web"
import { SessionTurn, resolveActivityDisclosure } from "@ericsanchezok/synergy-ui/session-turn"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import { MessageSlotOutlet } from "@ericsanchezok/synergy-ui/message-slots"
import { useExecution } from "@/context/execution"
import { buildConversationRows, type ConversationRow } from "./conversation-rows"
import { ToolExpansionProvider } from "@ericsanchezok/synergy-ui/tool-expansion"
import { ProcessViewport } from "@ericsanchezok/synergy-ui/process-viewport"
import { CompactionCard } from "@ericsanchezok/synergy-ui/compaction-card"
import { useData } from "@ericsanchezok/synergy-ui/context/data"
import { requestErrorMessage } from "../../utils/error"
import { PartContentSyncError } from "../../context/part-materializer"

// Provenance: https://github.com/inokawa/virtua/blob/0.42.3/src/solid/Virtualizer.tsx
// Local adaptation: Part identities, retained interaction rows and prepend offsets share the existing scroll element.
const layouts = new WeakMap<
  PluginConversationService,
  Map<string, { keys: string[]; cache: VirtualizerHandle["cache"]; bytes: number }>
>()

type ProcessControls = {
  submissionFor?: (
    rootID: string,
  ) => { activity?: import("@ericsanchezok/synergy-sdk").SessionActivity; failed: boolean } | undefined
  executionFor?: (rootID: string) => TurnExecutionState | undefined
  onRestoreChanges?: (messageID: string) => void
}

export function VirtualConversationRows(
  input: ProcessControls & { context: PluginConversationService; scrollRef?: HTMLDivElement },
) {
  const props = input.context
  const content = props.content!
  const [handle, setHandle] = createSignal<VirtualizerHandle>()
  const [margin, setMargin] = createSignal(0)
  const [retained, setRetained] = createSignal<string[]>([])
  const [interactionBlocks, setInteractionBlocks] = createSignal<string[]>([])
  const [readingBlocks, setReadingBlocks] = createSignal<string[]>([])
  const [interactionRoots, setInteractionRoots] = createSignal<string[]>([])
  const [expanded, setExpanded] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const activityView = {
    getExpanded: (key: string) => props.activityView?.getExpanded(key) ?? expanded().get(key),
    setExpanded: (key: string, value: boolean) => {
      const set = (id: string, open: boolean) => {
        if (props.activityView) props.activityView.setExpanded(id, open)
        else setExpanded((previous) => new Map(previous).set(id, open))
      }
      if (!value && key.startsWith("turn-process:")) {
        for (const row of requestedRows())
          if (row.kind === "activity" && `turn-process:${row.root.id}` === key) set(row.activity.key, false)
      }
      set(key, value)
    },
  }
  const processState = createMemo((previous: Map<string, { working: boolean; held: boolean }> | undefined) => {
    const next = new Map<string, { working: boolean; held: boolean }>()
    for (const root of props.timeline()) {
      if (root.role !== "user") continue
      const state = input.executionFor?.(root.id)
      const last = previous?.get(root.id)
      const final = props
        .turnProjection()
        .turnMessagesFor(root)
        .findLast((message) => message.role === "assistant")
      const submission = input.submissionFor?.(root.id)
      const working = submission
        ? !submission.failed
        : state
          ? ["preparing", "running", "approval"].includes(state.status) ||
            (state.status === "completed" && !!last?.working && final?.time.completed == null)
          : root.id === props.lastUserMessage()?.id && props.isWorking()
      const reading =
        props.scrolledUp() ||
        interactionRoots().includes(root.id) ||
        readingBlocks().some((key) => key.startsWith(`${root.id}:activity:`))
      next.set(root.id, { working, held: reading && (!!last?.held || (!!last?.working && !working)) })
    }
    return next
  })
  const projectionRows = createMemo<ConversationRow[]>((previous) =>
    buildConversationRows({
      previous,
      timeline: props.timeline(),
      messagesFor: (root) => props.turnProjection().turnMessagesFor(root as UserMessage),
      summaries: content.summaries,
      page: content.page,
      activity: (block) =>
        activityView.getExpanded(block.key) ??
        (props.activityDisplay() === "full" ||
          ((interactionBlocks().includes(block.key) || readingBlocks().includes(block.key)) &&
            !!previous?.find((row) => row.key === block.key)?.activity?.open) ||
          (props.activityDisplay() !== "minimal" &&
            (block.active ||
              (props.scrolledUp() && !!previous?.find((row) => row.key === block.key)?.activity?.open)))),
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
      const current = untrack(rows)
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
      const merged = [...next]
      for (const row of exits) {
        const following = current.slice(current.indexOf(row) + 1).find((item) => nextKeys.has(item.key))
        const index = following ? merged.findIndex((item) => item.key === following.key) : merged.length
        merged.splice(index, 0, { ...row, exiting: true })
      }
      setRows(merged)
    }),
  )
  const finishExit = (key: string) => setRows((previous) => previous.filter((row) => row.key !== key || !row.exiting))
  const keys = createMemo(() => rows().map((row) => row.key))
  const layout = layouts.get(props)?.get(props.sessionID)
  const initialCache =
    layout && layout.keys.length === keys().length && layout.keys.every((key, index) => key === keys()[index])
      ? layout.cache
      : undefined
  onCleanup(() => {
    const virtual = handle()
    if (!virtual) return
    const cache = virtual.cache
    const current = keys()
    const entries = layouts.get(props) ?? new Map()
    layouts.set(props, entries)
    entries.delete(props.sessionID)
    entries.set(props.sessionID, { keys: current, cache, bytes: JSON.stringify([current, cache]).length * 2 })
    let bytes = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0)
    for (const [key, entry] of entries) {
      if (bytes <= 4 * 1024 * 1024) break
      entries.delete(key)
      bytes -= entry.bytes
    }
  })
  const byKey = createMemo(() => new Map(rows().map((row) => [row.key, row])))
  const kept = createMemo(() =>
    retained()
      .map((key) => keys().indexOf(key))
      .filter((index) => index >= 0),
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
  let previous: string[] = []
  let anchor: { key: string; offset: number } | undefined
  let anchorFrame: number | undefined
  const captureAnchor = () => {
    const virtual = handle()
    if (!virtual) return
    const index = virtual.findStartIndex()
    const key = keys()[index]
    if (key) anchor = { key, offset: virtual.scrollOffset - virtual.getItemOffset(index) }
  }
  createEffect(() => {
    const next = keys()
    const virtual = untrack(handle)
    const scroller = input.scrollRef
    const leading = previous[0]?.endsWith(":earlier") ? previous[1] : previous[0]
    const prepended = leading !== undefined && next.indexOf(leading) > previous.indexOf(leading)
    if (virtual && prepended && scroller && props.scrolledUp()) {
      const saved = anchor
      const target = saved ? next.indexOf(saved.key) : -1
      if (saved && target >= 0 && target !== previous.indexOf(saved.key)) {
        if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
        anchorFrame = requestAnimationFrame(() => {
          anchorFrame = undefined
          scroller.scrollTop = virtual.getItemOffset(target) + saved.offset
        })
      }
    }
    previous = next
  })
  onCleanup(() => {
    if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
  })
  const pinInteraction = () => {
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
    add(document.activeElement)
    const selection = document.getSelection()
    if (selection && !selection.isCollapsed) {
      add(selection.anchorNode)
      add(selection.focusNode)
      const indices = [...ids].map((key) => keys().indexOf(key)).filter((index) => index >= 0)
      if (indices.length === 2) {
        const start = Math.min(...indices),
          end = Math.max(...indices)
        for (const element of container?.querySelectorAll<HTMLElement>("[data-display-row]") ?? []) {
          const index = keys().indexOf(element.dataset.displayRow!)
          if (index >= start && index <= end) ids.add(element.dataset.displayRow!)
        }
      }
    }
    setRetained([...ids])
    setInteractionRoots([...roots])
    setInteractionBlocks([...blocks])
  }
  onMount(() => {
    const measure = () => {
      const scroll = input.scrollRef
      if (scroll && container)
        container.style.setProperty("--process-viewport-limit", `${scroll.clientHeight * 0.45}px`)
      if (scroll && container)
        setMargin(container.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop)
    }
    const observer = new ResizeObserver(measure)
    if (container?.parentElement) observer.observe(container.parentElement)
    if (input.scrollRef) observer.observe(input.scrollRef)
    measure()
    captureAnchor()
    document.addEventListener("focusin", pinInteraction)
    document.addEventListener("focusout", pinInteraction)
    document.addEventListener("selectionchange", pinInteraction)
    const release = props.registerMessageLocator?.(async (messageID, behavior, partID) => {
      if (content.loadWindow && !(await content.loadWindow(messageID, partID))) return false
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
        const block = requestedRows().find(
          (row) =>
            row.kind === "activity" &&
            row.activity.entries.some(
              (entry) =>
                entry.message.id === messageID &&
                (!partID || (entry.kind === "body" && entry.parts.some((part) => part.id === partID))),
            ),
        )
        if (block?.activity) activityView.setExpanded(block.activity.key, true)
      }
      const owns = (row: ConversationRow) =>
        row.kind === "activity"
          ? row.activity.entries.some(
              (entry) =>
                entry.message.id === messageID &&
                (!partID || (entry.kind === "body" && entry.parts.some((part) => part.id === partID))),
            )
          : row.message.id === messageID &&
            (!partID || (row.kind === "body" && row.parts.some((part) => part.id === partID)))
      let index = rows().findIndex(owns)
      if (index < 0) return false
      await content.load(messageID)
      index = rows().findIndex(owns)
      if (index < 0 || !handle()) return false
      handle()!.scrollToIndex(index, { align: "start", smooth: behavior === "smooth" })
      const group = rows()[index]
      for (let attempt = 0; attempt < 24; attempt++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (group.kind !== "activity") break
        container?.dispatchEvent(new CustomEvent("process-locate", { detail: { key: group.key, messageID, partID } }))
        const mounted = [
          ...(container?.querySelectorAll<HTMLElement>('[data-component="process-viewport"] [data-display-row]') ?? []),
        ].some(
          (element) =>
            element.dataset.messageId === messageID &&
            (!partID ||
              [...element.querySelectorAll<HTMLElement>("[data-part-id]")].some(
                (part) => part.dataset.partId === partID,
              )),
        )
        if (mounted) break
      }
      if (partID)
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            const part = [
              ...container!.querySelectorAll<HTMLElement>(
                group.kind === "activity" ? '[data-component="process-viewport"] [data-part-id]' : "[data-part-id]",
              ),
            ].find((element) => element.dataset.partId === partID)
            const scroll = part?.closest<HTMLElement>('[data-component="process-viewport"]') ?? input.scrollRef
            if (part && scroll)
              scroll.scrollBy({
                top: part.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
                behavior,
              })
            resolve()
          }),
        )
      return true
    })
    onCleanup(() => {
      observer.disconnect()
      release?.()
      document.removeEventListener("focusin", pinInteraction)
      document.removeEventListener("focusout", pinInteraction)
      document.removeEventListener("selectionchange", pinInteraction)
    })
  })
  return (
    <div ref={container} data-component="virtual-conversation-rows" class="w-full min-w-0 max-w-full">
      <Show when={input.scrollRef}>
        <ToolExpansionProvider value={expansionState}>
          <Virtualizer
            ref={setHandle}
            data={keys()}
            scrollRef={input.scrollRef}
            startMargin={margin()}
            overscan={4}
            keepMounted={kept()}
            onScroll={captureAnchor}
            cache={initialCache}
          >
            {(key) => {
              const row = createMemo<ConversationRow>((previous) => byKey().get(key) ?? previous!, byKey().get(key)!)
              return (
                <ConversationDisplayRow
                  context={props}
                  row={row}
                  onExit={finishExit}
                  activityView={activityView}
                  submissionFor={input.submissionFor}
                  executionFor={input.executionFor}
                  onRestoreChanges={input.onRestoreChanges}
                  onReading={(key, reading) =>
                    setReadingBlocks((previous) =>
                      reading ? [...new Set([...previous, key])] : previous.filter((value) => value !== key),
                    )
                  }
                />
              )
            }}
          </Virtualizer>
        </ToolExpansionProvider>
      </Show>
    </div>
  )
}

function ConversationDisplayRow(
  input: ProcessControls & {
    context: PluginConversationService
    row: () => ConversationRow
    onExit: (key: string) => void
    activityView: NonNullable<PluginConversationService["activityView"]>
    onReading?: (key: string, reading: boolean) => void
  },
) {
  const props = input.context
  const content = props.content!
  const row = input.row
  const execution = useExecution()
  const { _ } = useLingui()
  const exitMotion = createDisclosureMotionRef({
    visible: () => !row().exiting,
    animate: () => !props.scrolledUp(),
    onHidden: () => input.onExit(row().key),
  })
  const [loadFailure, setLoadFailure] = createSignal<{ error: unknown }>()
  const [partStates, setPartStates] = createStore<
    Record<string, { pending: boolean; failed: boolean; error?: unknown } | undefined>
  >({})
  const [loading, setLoading] = createSignal(false)
  const [retry, setRetry] = createSignal(0)
  let loadGeneration = 0
  let hadPage = false
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
    if (current.kind === "body" && !loadFailure()) {
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
      if (current.kind === "load" && current.older && content.loadEarlier) await content.loadEarlier(current.message.id)
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
    if (content.page(current.message.id)) {
      hadPage = true
      return
    }
    const renew = hadPage
    const generation = ++loadGeneration
    void content
      .load(current.message.id)
      .then(() => {
        if (!alive || generation !== loadGeneration) return
        setLoadFailure(undefined)
        if (!renew) return
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
      footer: current.kind === "footer",
      parts: current.kind === "body" ? current.parts : [],
      before: current.kind === "body" && current.before,
      after: current.kind === "body" && current.after,
      beforeTool: current.kind === "body" && current.beforeTool,
      beforeReasoning: current.kind === "body" && current.beforeReasoning,
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
      data-activity-block={row().activity?.key}
      data-process-body={segment().processBody ? "" : undefined}
      data-turn-root={row().root.id}
      data-message-id={row().message.id}
      data-message-role={row().message.role}
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
      <Show when={row().kind !== "load"} fallback={<div class="min-h-6" aria-busy={loading()} />}>
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
                    compactionParentIDs={props.turnProjection().compactionParentIDs}
                    activityDisplay={props.activityDisplay()}
                    activityView={input.activityView}
                    submission={input.submissionFor?.(row().root.id)}
                    executionState={input.executionFor?.(row().root.id)}
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
                      row().kind === "footer" && execution.available() ? execution.round(row().root.id) : undefined
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
              onClick={() => {
                const block = row().activity
                if (block) input.activityView.setExpanded(block.key, !block.open)
              }}
            >
              <span>
                {row().activity?.tools
                  ? _({
                      id: "session.activity.operations",
                      message: "{count, plural, one {# action} other {# actions}}",
                      values: { count: row().activity!.tools },
                    })
                  : row().activity?.entries.some((entry) => entry.kind === "body" && entry.event)
                    ? _({ id: "session.process.records", message: "Process history" })
                    : _({ id: "session.reasoning.title", message: "Reasoning" })}
              </span>
              <Icon name={getSemanticIcon("navigation.expand")} size="small" />
            </button>
            <Show when={row().activity?.open}>
              <ConversationActivityBody
                context={props}
                row={row}
                activityView={input.activityView}
                onReading={input.onReading}
                submissionFor={input.submissionFor}
                executionFor={input.executionFor}
                onRestoreChanges={input.onRestoreChanges}
              />
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function ConversationActivityBody(
  input: ProcessControls & {
    context: PluginConversationService
    row: () => ConversationRow
    activityView: NonNullable<PluginConversationService["activityView"]>
    onReading?: (key: string, value: boolean) => void
  },
) {
  const [scroll, setScroll] = createSignal<HTMLDivElement>()
  const [handle, setHandle] = createSignal<VirtualizerHandle>()
  const [retained, setRetained] = createSignal<number[]>([])
  const data = useData()
  const entries = () => input.row().activity?.entries ?? []
  const keys = createMemo(() => entries().map((entry) => entry.key))
  const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry])))
  let viewport: HTMLDivElement | undefined
  let pause: (() => void) | undefined
  const layoutKey = `${input.context.sessionID}:${input.row().key}`
  const layout = layouts.get(input.context)?.get(layoutKey)
  const initialCache =
    layout && layout.keys.length === keys().length && layout.keys.every((key, index) => key === keys()[index])
      ? layout.cache
      : undefined
  let anchor: { key: string; offset: number; partID?: string } | undefined
  let anchorFrame: number | undefined
  const captureAnchor = () => {
    if (!viewport) return
    const bounds = viewport.getBoundingClientRect()
    const row = [
      ...viewport.querySelectorAll<HTMLElement>(
        '[data-slot="activity-step"][data-part-id], [data-component="process-reasoning"][data-part-id], [data-display-row]',
      ),
    ].find((element) => {
      if (
        element.dataset.displayRow &&
        element.querySelector('[data-slot="activity-step"], [data-component="process-reasoning"]')
      )
        return false
      const rect = element.getBoundingClientRect()
      return rect.bottom > bounds.top && rect.top < bounds.bottom
    })
    if (row)
      anchor = {
        key: row.closest<HTMLElement>("[data-display-row]")!.dataset.displayRow!,
        partID: row.dataset.partId,
        offset: row.getBoundingClientRect().top - bounds.top,
      }
  }
  const restoreAnchor = (saved: { key: string; offset: number; partID?: string }) => {
    const index = saved.partID
        ? entries().findIndex((entry) => entry.kind === "body" && entry.parts.some((part) => part.id === saved.partID))
        : keys().indexOf(saved.key),
      virtual = handle()
    if (index < 0 || !virtual || !viewport) return
    virtual.scrollToIndex(index, { align: "start", offset: -saved.offset })
    if (!saved.partID) return
    if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = undefined
      const part = [
        ...(viewport?.querySelectorAll<HTMLElement>(
          '[data-slot="activity-step"][data-part-id], [data-component="process-reasoning"][data-part-id]',
        ) ?? []),
      ].find((element) => element.dataset.partId === saved.partID)
      const row = part?.closest<HTMLElement>("[data-display-row]")
      if (part && row)
        virtual.scrollToIndex(index, {
          align: "start",
          offset: part.getBoundingClientRect().top - row.getBoundingClientRect().top - saved.offset,
        })
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
    const virtual = handle()
    if (!virtual) return
    const cache = virtual.cache,
      current = keys()
    const entries = layouts.get(input.context) ?? new Map()
    layouts.set(input.context, entries)
    entries.delete(layoutKey)
    entries.set(layoutKey, { keys: current, cache, bytes: JSON.stringify([current, cache]).length * 2 })
    let bytes = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0)
    for (const [key, entry] of entries) {
      if (bytes <= 4 * 1024 * 1024) break
      entries.delete(key)
      bytes -= entry.bytes
    }
  })
  const pin = () => {
    const indices = new Set<number>()
    const add = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement
      const row = element?.closest<HTMLElement>("[data-display-row]")
      if (row && viewport?.contains(row)) {
        const index = keys().indexOf(row.dataset.displayRow!)
        if (index >= 0) indices.add(index)
      }
    }
    add(document.activeElement)
    const selection = document.getSelection()
    if (selection && !selection.isCollapsed) {
      add(selection.anchorNode)
      add(selection.focusNode)
      if (indices.size === 2) {
        const start = Math.min(...indices),
          end = Math.max(...indices)
        for (const element of viewport?.querySelectorAll<HTMLElement>("[data-display-row]") ?? []) {
          const index = keys().indexOf(element.dataset.displayRow!)
          if (index >= start && index <= end) indices.add(index)
        }
      }
    }
    setRetained([...indices])
  }
  onMount(() => {
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
        pause?.()
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
      identity={`${data.serverUrl}:${data.directory}:${layoutKey}`}
      controls={(value) => {
        pause = value.pause
      }}
      anchor={() => {
        captureAnchor()
        return anchor
      }}
      restoreAnchor={restoreAnchor}
      onScroll={captureAnchor}
      active={input.row().activity?.active ?? false}
      following={!input.context.scrolledUp()}
      revision={entries()
        .map((entry) =>
          entry.kind === "body" ? entry.parts.map((part) => `${part.id}:${part.content.version}`).join(",") : entry.key,
        )
        .join(";")}
      onReading={(value) => input.onReading?.(input.row().key, value)}
      ref={(element) => {
        viewport = element
        setScroll(element)
      }}
    >
      <Show when={scroll()}>
        <Virtualizer
          ref={setHandle}
          data={keys()}
          scrollRef={scroll()}
          overscan={2}
          keepMounted={retained()}
          cache={initialCache}
        >
          {(key) => {
            const row = createMemo<ConversationRow>((previous) => byKey().get(key) ?? previous!, byKey().get(key)!)
            return (
              <ConversationDisplayRow
                context={input.context}
                row={row}
                activityView={input.activityView}
                onExit={() => {}}
                submissionFor={input.submissionFor}
                executionFor={input.executionFor}
                onRestoreChanges={input.onRestoreChanges}
              />
            )
          }}
        </Virtualizer>
      </Show>
    </ProcessViewport>
  )
}
