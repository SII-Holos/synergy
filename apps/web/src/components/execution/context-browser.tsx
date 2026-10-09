import { createEffect, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { useParams } from "@solidjs/router"
import type {
  ExecutionContextItem,
  ExecutionContextSnapshot,
  ExecutionContextItems,
} from "@ericsanchezok/synergy-sdk/client"
import { createDisclosureMotionRef } from "@ericsanchezok/synergy-ui/hooks"
import { useSDK } from "@/context/sdk"
import { contextCategories, contextRows, D } from "./context-categories"
import { E } from "./i18n"
import { ContextSourceItem } from "./context-item-content"
import { contextSourceChanges } from "./context-chart-model"

export function ContextBrowser(props: {
  selected: string
  previewing?: boolean
  onSelect: (id: string) => void
  snapshot?: ExecutionContextSnapshot
  history: ExecutionContextSnapshot[]
  category: string
  highlight?: string
  onHighlight?: (value: string) => void
  onCategory: (category: string) => void
  active: boolean
}) {
  const { _, i18n } = useLingui()
  const [search, setSearch] = createSignal("")
  const [query, setQuery] = createSignal("")
  const rows = () => contextRows(props.snapshot?.usage ?? undefined).filter((row) => row.category !== "overhead")
  const changes = () => contextSourceChanges(props.snapshot, props.history)
  const number = (value: number) =>
    new Intl.NumberFormat(i18n().locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
  const signed = (value: number) =>
    new Intl.NumberFormat(i18n().locale, {
      notation: "compact",
      maximumFractionDigits: 1,
      signDisplay: "exceptZero",
    }).format(value)
  createEffect(
    on(search, (value) => {
      const timer = setTimeout(() => setQuery(value), 150)
      onCleanup(() => clearTimeout(timer))
    }),
  )
  return (
    <section class="context-browser" aria-label={_(D.content)}>
      <div class="context-section-heading">
        <h3>{_(D.content)}</h3>
        <MenuField
          value={props.previewing ? (props.snapshot?.callID ?? props.selected) : props.selected}
          ariaLabel={_(D.requestPicker)}
          options={[
            { value: "", label: _(D.latest) },
            ...props.history.map((entry) => ({
              value: entry.callID,
              label: _({ ...D.requestIdentity, values: { round: entry.roundNumber, request: entry.requestNumber } }),
            })),
            ...(props.selected && !props.history.some((entry) => entry.callID === props.selected) && props.snapshot
              ? [
                  {
                    value: props.selected,
                    label: _({
                      ...D.requestIdentity,
                      values: { round: props.snapshot.roundNumber, request: props.snapshot.requestNumber },
                    }),
                  },
                ]
              : []),
          ]}
          onChange={props.onSelect}
        />
      </div>
      <Show when={props.snapshot}>
        {(snapshot) => (
          <div class="context-source-caption">
            <strong>{_({ ...D.historical, values: { number: snapshot().requestNumber } })}</strong>
            <span>
              {_(D.input)} {snapshot().inputTokens == null ? "—" : number(snapshot().inputTokens!)}
            </span>
          </div>
        )}
      </Show>
      <div class="context-source-strip" aria-hidden="true">
        <For each={contextRows(props.snapshot?.usage ?? undefined)}>
          {(row) => (
            <span
              style={{
                width:
                  (props.snapshot?.inputTokens ? (row.attributedTokens / props.snapshot.inputTokens) * 100 : 0) + "%",
                background: row.color,
              }}
            />
          )}
        </For>
      </div>
      <label class="context-source-search">
        <input
          type="search"
          value={search()}
          onInput={(event) => setSearch(event.currentTarget.value)}
          placeholder={_(D.sourceSearch)}
          aria-label={_(D.sourceSearch)}
        />
      </label>
      <Show
        when={rows().length}
        fallback={<p class="context-note">{_(props.snapshot ? D.sourceUnavailable : D.noRequests)}</p>}
      >
        <For each={rows().map((row) => row.category)}>
          {(category) => {
            const row = () => rows().find((entry) => entry.category === category)!
            const change = () => changes()?.get(category)
            const open = () => props.category === row().category && row().items !== 0
            const [visited, setVisited] = createSignal(false)
            createEffect(() => {
              if (open()) setVisited(true)
            })
            const id = createUniqueId()
            const motion = createDisclosureMotionRef({ visible: open, animate: () => true, observeResize: true })
            return (
              <div class="context-category-group">
                <button
                  type="button"
                  class="context-category-heading"
                  data-context-category={category}
                  data-highlighted={props.highlight === category}
                  onMouseEnter={() => props.onHighlight?.(category)}
                  onMouseLeave={() => props.onHighlight?.("")}
                  onFocus={() => props.onHighlight?.(category)}
                  onBlur={() => props.onHighlight?.("")}
                  aria-expanded={open()}
                  aria-controls={id}
                  disabled={row().items === 0}
                  onClick={() => props.onCategory(open() ? "" : row().category)}
                >
                  <span class="context-chevron" data-open={open()} aria-hidden="true">
                    <Show when={row().items !== 0}>
                      <Icon name={getSemanticIcon("navigation.expand")} size="small" />
                    </Show>
                  </span>
                  <span class="context-dot" style={{ background: row().color }} />
                  <span class="context-category-label">
                    <span>{_(contextCategories[category].label)}</span>
                    <small>{_({ ...D.items, values: { count: row().items ?? "—" } })}</small>
                    <Show when={change()?.tokens}>
                      <span
                        class="context-source-change"
                        data-direction={change()!.tokens > 0 ? "increase" : "decrease"}
                        title={_({
                          ...D.sourceChange,
                          values: {
                            tokens: signed(change()!.tokens),
                            items: change()?.items == null ? "—" : signed(change()!.items!),
                          },
                        })}
                      >
                        {signed(change()!.tokens)}
                      </span>
                    </Show>
                  </span>
                  <strong>{number(row().attributedTokens)}</strong>
                  <small class="context-category-percent">
                    {new Intl.NumberFormat(i18n().locale, { style: "percent", maximumFractionDigits: 1 }).format(
                      props.snapshot?.inputTokens ? row().attributedTokens / props.snapshot.inputTokens : 0,
                    )}
                  </small>
                </button>
                <div id={id} ref={motion} class="context-category-contents">
                  <div>
                    <Show when={visited() && props.snapshot}>
                      {(snapshot) => (
                        <Show
                          when={row().precision !== "legacy"}
                          fallback={<p class="context-note">{_(D.sourceUnavailable)}</p>}
                        >
                          <ContextCategoryItems
                            snapshot={snapshot()}
                            category={row().category as ExecutionContextItem["category"]}
                            query={query()}
                            active={open() && props.active}
                          />
                        </Show>
                      )}
                    </Show>
                  </div>
                </div>
              </div>
            )
          }}
        </For>
      </Show>
      <Show when={changes()?.size}>
        <p class="context-note context-source-comparison">{_(D.comparedPrevious)}</p>
      </Show>
    </section>
  )
}

function ContextCategoryItems(props: {
  snapshot: ExecutionContextSnapshot
  category: ExecutionContextItem["category"]
  query: string
  active: boolean
}) {
  const sdk = useSDK()
  const params = useParams()
  const { _ } = useLingui()
  const [state, setState] = createStore<{
    items: ExecutionContextItem[]
    version: string | null
    next: string | null
    status: ExecutionContextItems["status"]
    loading: boolean
    error: boolean
    truncated: boolean
  }>({ items: [], version: null, next: null, status: "available", loading: false, error: false, truncated: false })
  const [selected, setSelected] = createSignal("")
  let request = 0
  let abort: AbortController | undefined
  const load = async (more = false) => {
    const sessionID = params.id
    if (!sessionID || !props.active) return
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    const version = ++request
    setState({ loading: true, error: false })
    try {
      const response = await sdk.client.session.executionContextItems(
        {
          sessionID,
          callID: props.snapshot.callID,
          category: props.category,
          query: props.query || undefined,
          cursor: more ? (state.next ?? undefined) : undefined,
          version: more ? (state.version ?? undefined) : undefined,
          limit: 30,
        },
        { signal: controller.signal, throwOnError: true },
      )
      if (version !== request || controller.signal.aborted) return
      const page = response.data
      const combined = more ? [...state.items, ...page.items] : page.items
      const pinned = state.items.find((item) => item.id === selected())
      const retained = combined.slice(-120)
      if (pinned && !retained.some((item) => item.id === pinned.id)) retained.unshift(pinned)
      setState("items", reconcile(retained, { key: "id" }))
      setState({ version: page.contentVersion, next: page.nextCursor, status: page.status, truncated: page.truncated })
    } catch {
      if (version === request && !controller.signal.aborted) setState("error", true)
    } finally {
      if (version === request) setState("loading", false)
    }
  }
  createEffect(
    on([() => props.snapshot.callID, () => props.category, () => props.query, () => params.id], () => {
      request++
      abort?.abort()
      setSelected("")
      setState({ items: [], version: null, next: null })
      void load()
    }),
  )
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (!active) {
          request++
          abort?.abort()
          setState("loading", false)
        } else if (!state.items.length && !state.loading) void load()
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    request++
    abort?.abort()
  })
  const source = (item: ExecutionContextItem) =>
    item.source === item.category || item.source === "system" ? _(contextCategories[item.category].label) : item.source
  return (
    <div class="context-items">
      <Show when={state.status === "available"} fallback={<p class="context-note">{_(D.sourceUnavailable)}</p>}>
        <For each={state.items}>
          {(item) => (
            <ContextSourceItem
              client={sdk.client}
              sessionID={params.id!}
              snapshot={props.snapshot}
              item={item}
              version={state.version}
              title={source(item)}
              open={selected() === item.id}
              active={props.active}
              onToggle={() => setSelected(selected() === item.id ? "" : item.id)}
            />
          )}
        </For>
        <Show when={!state.items.length && !state.loading && !state.error}>
          <p class="context-note">{_(D.noItems)}</p>
        </Show>
        <Show when={state.truncated}>
          <p class="context-note">{_(D.indexTruncated)}</p>
        </Show>
        <Show when={state.next}>
          <button class="context-link" disabled={state.loading} onClick={() => void load(true)}>
            {_(D.moreItems)}
          </button>
        </Show>
      </Show>
      <Show when={state.loading}>
        <p class="context-note" role="status">
          {_(D.loading)}
        </p>
      </Show>
      <Show when={state.error}>
        <p class="context-note" role="alert">
          {_(D.error)}{" "}
          <button class="context-link" onClick={() => void load()}>
            {_(E.retry)}
          </button>
        </p>
      </Show>
    </div>
  )
}
