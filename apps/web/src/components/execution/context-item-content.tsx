import { createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, Show } from "solid-js"
import { createDisclosureMotionRef } from "@ericsanchezok/synergy-ui/hooks"
import { useLingui } from "@lingui/solid"
import type { ExecutionContextItem, ExecutionContextSnapshot, SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { D } from "./context-categories"
import { E } from "./i18n"
import { EvidenceBlock } from "./block"

export function ContextSourceItem(props: {
  client: SynergyClient
  sessionID: string
  snapshot: ExecutionContextSnapshot
  item: ExecutionContextItem
  version: string | null
  title: string
  open: boolean
  active: boolean
  onToggle: () => void
}) {
  const { _, i18n } = useLingui()
  const [mounted, setMounted] = createSignal(false)
  createEffect(() => {
    if (props.open) setMounted(true)
  })
  const id = createUniqueId()
  const motion = createDisclosureMotionRef({
    visible: () => props.open,
    animate: () => true,
    observeResize: true,
    onHidden: () => setMounted(false),
  })
  return (
    <div class="context-item" data-open={props.open}>
      <button
        type="button"
        class="context-item-heading"
        aria-controls={id}
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span class="context-item-title">{props.title}</span>
        <small>
          {_({
            ...D.characters,
            values: {
              count: new Intl.NumberFormat(i18n().locale, { notation: "compact" }).format(props.item.characters),
            },
          })}
        </small>
        <span class="context-item-action">{_(props.open ? D.hideContent : D.viewContent)}</span>
      </button>
      <div id={id} ref={motion} class="context-item-disclosure">
        <div>
          <Show when={mounted() && props.version}>
            {(version) => (
              <ContextItemContent
                client={props.client}
                sessionID={props.sessionID}
                snapshot={props.snapshot}
                item={props.item}
                version={version()}
                label={props.title}
                active={props.active && props.open}
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
function selectedValue(text: string, item: ExecutionContextItem, complete: boolean): unknown {
  if (!complete) return undefined
  try {
    let value: unknown = JSON.parse(text)
    for (const key of item.selector ?? []) value = Array.isArray(value) ? value[Number(key)] : object(value)?.[key]
    if (item.range && typeof value === "string") value = value.slice(item.range!.start, item.range!.end)
    const output = object(value)
    if (output && (output.type === "text" || output.type === "error-text" || output.type === "json"))
      return output.value
    return value
  } catch {
    return undefined
  }
}
export function ContextItemContent(props: {
  client: SynergyClient
  sessionID: string
  snapshot: ExecutionContextSnapshot
  item: ExecutionContextItem
  version: string
  label?: string
  active: boolean
}) {
  const { _ } = useLingui()
  const [text, setText] = createSignal("")
  const [offset, setOffset] = createSignal(props.item.offset)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  let abort: AbortController | undefined
  let disposed = false
  let generation = 0
  const end = () => props.item.offset + props.item.bytes
  const complete = () => offset() >= end()
  const bounded = () => offset() - props.item.offset >= 256 * 1024
  const load = async () => {
    const sessionID = props.sessionID
    if (!sessionID || !props.active || loading() || complete() || bounded()) return
    const controller = new AbortController()
    abort = controller
    const current = ++generation
    setLoading(true)
    setError(false)
    try {
      const response = await props.client.session.executionContent(
        {
          sessionID,
          nodeID: props.snapshot.nodeID,
          field: "request",
          offset: offset(),
          limit: Math.min(65_536, end() - offset()),
          version: props.version,
        },
        { signal: controller.signal, throwOnError: true },
      )
      if (disposed || current !== generation || controller.signal.aborted) return
      setText((value) => value + response.data.text)
      setOffset(response.data.nextOffset ?? end())
    } catch {
      if (!disposed && current === generation && !controller.signal.aborted) setError(true)
    } finally {
      if (!disposed && current === generation) setLoading(false)
    }
  }
  onMount(() => {
    void load()
  })
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (!active) {
          generation++
          abort?.abort()
          setLoading(false)
        } else if (!text()) void load()
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    disposed = true
    generation++
    abort?.abort()
  })
  const value = createMemo(() => selectedValue(text(), props.item, complete()))
  const display = () =>
    typeof value() === "string"
      ? (value() as string)
      : value() === undefined
        ? text()
        : JSON.stringify(value(), null, 2)
  return (
    <div class="context-item-body">
      <Show when={text()}>
        <EvidenceBlock
          label={props.label ?? props.item.source}
          text={display()}
          language={typeof value() === "string" ? "text" : "json"}
        />
      </Show>
      <Show when={!complete() && !bounded()}>
        <button class="context-link" disabled={loading()} onClick={() => void load()}>
          {_(D.moreContent)}
        </button>
      </Show>
      <Show when={bounded() && !complete()}>
        <p class="context-note">{_(D.contentLimit)}</p>
      </Show>
      <Show when={loading()}>
        <p class="context-note" role="status">
          {_(D.loading)}
        </p>
      </Show>
      <Show when={error()}>
        <p class="context-note" role="alert">
          {_(E.contentError)}{" "}
          <button class="context-link" onClick={() => void load()}>
            {_(E.retry)}
          </button>
        </p>
      </Show>
    </div>
  )
}
