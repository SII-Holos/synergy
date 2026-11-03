import { createEffect, createMemo, createSignal, Match, on, Show, Switch } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useParams } from "@/context/session-route"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useViewActivity } from "@/context/view-residency"

export function LongTermSummaryWorkbenchContent() {
  const sync = useSync()
  const sdk = useSDK()
  const params = useParams()
  const active = useViewActivity()
  const { _ } = useLingui()
  const owner = () => JSON.stringify([sdk.url, sdk.scopeKey, params.id])
  const session = () => (params.id ? sync.session.get(params.id) : undefined)
  const memory = () => session()?.longTermMemory
  const [requested, setRequested] = createSignal(0)
  const displayed = createMemo<{ owner: string; revision: number; markdown: string; requested: number } | undefined>(
    (previous) => {
      const target = owner()
      const next = memory()
      const request = requested()
      if (!next) return
      if (previous?.owner === target && previous.requested === request) {
        if (next.revision > previous.revision && next.markdown !== previous.markdown) return previous
        if (next.revision === previous.revision && next.markdown === previous.markdown) return previous
      }
      return { owner: target, revision: next.revision, markdown: next.markdown, requested: request }
    },
  )
  const pending = () => {
    const current = memory()
    const saved = displayed()
    return !!current && !!saved && current.revision > saved.revision && current.markdown !== saved.markdown
  }
  const loadPhase = () => params.id && sync.session.loadState(params.id).phase
  const loading = () => !session() && (!sync.ready || ["idle", "loading", "refreshing"].includes(loadPhase() || ""))
  const copy = createCopyController({
    text: () => (active() ? displayed()?.markdown : undefined),
    get copyLabel() {
      return _({ id: "session.longTermSummary.copy", message: "Copy long-term summary" })
    },
    get copiedLabel() {
      return _({ id: "session.execution.copied", message: "Copied" })
    },
    get failedLabel() {
      return _({ id: "session.execution.copyFailed", message: "Copy failed" })
    },
  })
  createEffect(
    on(
      () => [owner(), displayed()?.revision, displayed()?.markdown],
      () => copy.reset(),
    ),
  )
  let viewport: HTMLElement | undefined
  const viewLatest = () => {
    if (!active() || !pending()) return
    setRequested((value) => value + 1)
    if (viewport) {
      viewport.scrollTop = 0
      viewport.focus({ preventScroll: true })
    }
  }
  return (
    <div data-component="long-term-summary" class="flex h-full min-h-0 min-w-0 flex-col text-text-base">
      <header class="shrink-0 px-5 pt-5 pb-4">
        <div class="flex items-center gap-2">
          <Icon name={getSemanticIcon("memory.main")} size="normal" class="shrink-0" />
          <h2 class="min-w-0 flex-1 text-16-medium break-words">
            {_({ id: "session.longTermSummary.title", message: "Session long-term summary" })}
          </h2>
          <Button
            variant="ghost"
            size="small"
            icon={copy.icon()}
            aria-label={_({ id: "session.longTermSummary.copy", message: "Copy long-term summary" })}
            title={copy.tooltip()}
            disabled={!active() || copy.disabled()}
            onClick={() => void copy.copy()}
          />
          <span class="sr-only" role="status">
            {copy.state() === "idle" ? "" : copy.tooltip()}
          </span>
        </div>
      </header>
      <div class="flex min-h-8 shrink-0 items-center px-5 pb-2">
        <Show when={pending()}>
          <Button variant="ghost" size="small" disabled={!active()} onClick={viewLatest}>
            {_({ id: "session.longTermSummary.viewLatest", message: "View latest" })}
          </Button>
        </Show>
      </div>
      <section
        ref={viewport}
        data-slot="long-term-summary-body"
        data-scroll-viewport="vertical"
        aria-label={_({ id: "session.longTermSummary.title", message: "Session long-term summary" })}
        tabindex="0"
        class="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain px-5 pb-5"
      >
        <Switch>
          <Match when={loading()}>
            <p role="status" class="text-14-regular text-text-weak">
              {_({ id: "session.longTermSummary.loading", message: "Loading session…" })}
            </p>
          </Match>
          <Match when={!session() && loadPhase() === "error"}>
            <p role="status" class="text-14-regular text-text-weak">
              {_({ id: "session.longTermSummary.loadFailed", message: "Unable to load session." })}
            </p>
          </Match>
          <Match when={!session()}>
            <p role="status" class="text-14-regular text-text-weak">
              {_({ id: "session.longTermSummary.sessionMissing", message: "Session not found." })}
            </p>
          </Match>
          <Match when={!displayed()?.markdown}>
            <p role="status" class="text-14-regular text-text-weak">
              {_({ id: "session.longTermSummary.empty", message: "No long-term summary yet." })}
            </p>
          </Match>
          <Match when={!!displayed()?.markdown}>
            <div class="mx-auto max-w-[75ch]">
              <Show when={displayed()?.markdown} keyed>
                {(markdown) => <Markdown text={markdown} />}
              </Show>
            </div>
          </Match>
        </Switch>
      </section>
    </div>
  )
}
