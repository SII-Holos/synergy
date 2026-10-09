import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useLingui } from "@lingui/solid"
import type { ExecutionContextSnapshot, ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { contextHistoryBars } from "./context-chart-model"
import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import { E } from "./i18n"
import { D } from "./context-categories"

export function ContextHistoryChart(props: {
  items: ExecutionContextSnapshot[]
  selectedSnapshot?: ExecutionContextSnapshot
  rounds?: ExecutionSummary["rounds"]
  onPreview?: (id: string) => void
  onInspect?: (snapshot: ExecutionContextSnapshot) => void
  selected: string
  onSelect: (id: string) => void
  grouping: "request" | "round"
  onGrouping: (value: "request" | "round") => void
  delta: boolean
  onDelta: (value: boolean) => void
}) {
  const { _, i18n } = useLingui()
  const [hovered, setHovered] = createSignal("")
  const [timing, setTiming] = createSignal(true)
  const bars = createMemo(() => contextHistoryBars(props.items, props.grouping, props.delta))
  const maximum = createMemo(() =>
    Math.max(
      1,
      ...bars().flatMap((bar) => [
        bar.values.reduce((sum, value) => sum + Math.max(0, value.tokens), 0),
        bar.values.reduce((sum, value) => sum + Math.max(0, -value.tokens), 0),
      ]),
    ),
  )
  const timingMaximum = createMemo(() => Math.max(1, ...bars().map((bar) => bar.snapshot.elapsedMs ?? 0)))
  const timingPath = createMemo(() => {
    let previous: { x: number; y: number } | undefined
    return bars()
      .map((bar, index) => {
        const elapsed = bar.snapshot.elapsedMs
        if (elapsed == null) {
          previous = undefined
          return ""
        }
        const point = { x: ((index + 0.5) / bars().length) * 100, y: 100 - (elapsed / timingMaximum()) * 94 }
        const mid = previous ? (previous.x + point.x) / 2 : point.x
        const segment = previous
          ? `C${mid},${previous.y} ${mid},${point.y} ${point.x},${point.y}`
          : `M${point.x},${point.y}`
        previous = point
        return segment
      })
      .join(" ")
  })
  const number = (value: number) =>
    new Intl.NumberFormat(i18n().locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
  const label = (index: number) =>
    _({
      ...(props.grouping === "request" ? D.request : D.round),
      values: {
        number:
          props.grouping === "request" ? bars()[index].snapshot.requestNumber : bars()[index].snapshot.roundNumber,
      },
    })
  const preview = createMemo(() => {
    const hoveredBar = bars().find((bar) => bar.snapshot.callID === hovered())
    if (hoveredBar) return hoveredBar
    const selected = props.selectedSnapshot ?? props.items.find((entry) => entry.callID === props.selected)
    if (!selected) return bars().at(-1)
    return contextHistoryBars(
      [...props.items.filter((entry) => entry.callID !== selected.callID), selected],
      "request",
      props.delta,
    ).find((bar) => bar.snapshot.callID === selected.callID)
  })
  return (
    <section class="context-history" aria-label={_(D.growth)}>
      <div class="context-section-heading">
        <h3>{_(D.growth)}</h3>
        <div class="context-chart-controls">
          <div class="context-segmented" role="group" aria-label={_(D.growth)}>
            <button aria-pressed={props.grouping === "request"} onClick={() => props.onGrouping("request")}>
              {_(D.byRequest)}
            </button>
            <button aria-pressed={props.grouping === "round"} onClick={() => props.onGrouping("round")}>
              {_(D.byRound)}
            </button>
          </div>
          <div class="context-segmented" role="group" aria-label={_(D.composition)}>
            <button aria-pressed={!props.delta} onClick={() => props.onDelta(false)}>
              {_(D.total)}
            </button>
            <button aria-pressed={props.delta} onClick={() => props.onDelta(true)}>
              {_(D.delta)}
            </button>
          </div>
          <Button
            size="small"
            variant="ghost"
            class="context-timing-toggle"
            aria-pressed={timing()}
            onClick={() => setTiming(!timing())}
          >
            {_(E.elapsed)}
          </Button>
        </div>
      </div>
      <div class="context-history-plot" data-delta={props.delta}>
        <div class="context-chart-scale" aria-hidden="true">
          <span>{number(maximum())}</span>
          <span>{props.delta ? "0" : number(maximum() / 2)}</span>
          <span>{props.delta ? number(-maximum()) : "0"}</span>
        </div>
        <div
          class="context-chart-bars"
          onMouseLeave={() => {
            setHovered("")
            props.onPreview?.("")
          }}
        >
          <For each={bars().map((bar) => bar.snapshot.callID)}>
            {(id, index) => {
              const bar = () => bars().find((entry) => entry.snapshot.callID === id)!
              return (
                <Tooltip
                  class="context-history-target"
                  placement="top"
                  openDelay={120}
                  value={
                    <span class="context-chart-tooltip">
                      <strong>{label(index())}</strong>
                      <span>
                        {_(D.input)} {bar().snapshot.inputTokens == null ? "—" : number(bar().snapshot.inputTokens!)}
                      </span>
                      <span>
                        {_(E.elapsed)}{" "}
                        {bar().snapshot.elapsedMs == null ? "—" : executionDuration(bar().snapshot.elapsedMs!, false)}
                      </span>
                    </span>
                  }
                >
                  <button
                    type="button"
                    class="context-history-bar"
                    data-selected={bar().snapshot.callID === props.selected}
                    data-gap={bar().gap}
                    data-preview={hovered() === id}
                    aria-pressed={bar().snapshot.callID === props.selected}
                    aria-label={
                      label(index()) +
                      " · " +
                      (bar().total == null ? _(D.unavailable) : number(bar().total!)) +
                      (bar().snapshot.compactedBefore ? " · " + _(D.compaction) : "")
                    }
                    onMouseEnter={() => {
                      setHovered(bar().snapshot.callID)
                      props.onPreview?.(bar().snapshot.callID)
                    }}
                    onFocus={() => {
                      setHovered(bar().snapshot.callID)
                      props.onPreview?.(bar().snapshot.callID)
                    }}
                    onBlur={() => {
                      setHovered("")
                      props.onPreview?.("")
                    }}
                    onClick={() => props.onSelect(bar().snapshot.callID)}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                      event.preventDefault()
                      const target = event.currentTarget.closest(".context-history-target")
                      const neighbor =
                        event.key === "ArrowLeft" ? target?.previousElementSibling : target?.nextElementSibling
                      neighbor?.querySelector<HTMLButtonElement>(".context-history-bar")?.focus()
                    }}
                  >
                    <span class="context-bar-positive" aria-hidden="true">
                      <For each={bar().values.filter((value) => value.tokens > 0)}>
                        {(value) => (
                          <span
                            style={{
                              height: (value.tokens / maximum()) * 100 + "%",
                              background: value.color,
                            }}
                          />
                        )}
                      </For>
                    </span>
                    <Show when={props.delta}>
                      <span class="context-bar-negative" aria-hidden="true">
                        <For each={bar().values.filter((value) => value.tokens < 0)}>
                          {(value) => (
                            <span
                              style={{
                                height: (-value.tokens / maximum()) * 100 + "%",
                                background: value.color,
                              }}
                            />
                          )}
                        </For>
                      </span>
                    </Show>
                    <Show when={bar().snapshot.compactedBefore}>
                      <span class="context-compaction-mark" aria-hidden="true">
                        ◇
                      </span>
                    </Show>
                  </button>
                </Tooltip>
              )
            }}
          </For>
          <Show when={timing()}>
            <svg class="context-timing-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <path d={timingPath()} />
              <For each={bars()}>
                {(bar, index) => (
                  <Show when={bar.snapshot.elapsedMs != null}>
                    <path
                      class="context-timing-point"
                      d={`M${((index() + 0.5) / bars().length) * 100},${100 - (bar.snapshot.elapsedMs! / timingMaximum()) * 94} l0,0`}
                      data-active={bar.snapshot.callID === hovered() || bar.snapshot.callID === props.selected}
                    />
                  </Show>
                )}
              </For>
            </svg>
          </Show>
        </div>
        <Show when={timing()}>
          <div class="context-chart-scale context-time-scale" aria-hidden="true">
            <span>{executionDuration(timingMaximum(), false)}</span>
            <span>0</span>
          </div>
        </Show>
      </div>
      <div class="context-chart-caption">
        <span>{bars().length ? label(0) : "—"}</span>
        <span>{bars().length ? label(bars().length - 1) : "—"}</span>
      </div>
      <div class="context-history-preview">
        <Show when={preview()}>
          {(bar) => (
            <>
              <div class="context-request-heading">
                <strong>
                  {_({
                    ...D.requestIdentity,
                    values: { round: bar().snapshot.roundNumber, request: bar().snapshot.requestNumber },
                  })}
                </strong>
                <time>
                  {new Intl.DateTimeFormat(i18n().locale, {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  }).format(bar().snapshot.started)}
                </time>
              </div>
              <dl class="context-request-metrics">
                <div>
                  <dt>{_(E.input)}</dt>
                  <dd>{bar().snapshot.inputTokens == null ? "—" : number(bar().snapshot.inputTokens!)}</dd>
                </div>
                <div>
                  <dt>{_(E.output)}</dt>
                  <dd>{bar().snapshot.outputTokens == null ? "—" : number(bar().snapshot.outputTokens!)}</dd>
                </div>
                <div>
                  <dt>{_(E.cacheHit)}</dt>
                  <dd>
                    {bar().snapshot.cacheHit == null
                      ? "—"
                      : new Intl.NumberFormat(i18n().locale, { style: "percent", maximumFractionDigits: 1 }).format(
                          bar().snapshot.cacheHit!,
                        )}
                  </dd>
                </div>
                <div>
                  <dt>{_(E.elapsed)}</dt>
                  <dd>
                    {bar().snapshot.elapsedMs == null ? "—" : executionDuration(bar().snapshot.elapsedMs!, false)}
                  </dd>
                </div>
              </dl>
              <Show when={props.rounds?.find((round) => round.id === bar().snapshot.runID)?.title}>
                {(title) => (
                  <div class="context-request-prompt">
                    <span>{_(D.roundPrompt)}</span>
                    <p title={title()}>{title()}</p>
                  </div>
                )}
              </Show>
              <div class="context-request-footer">
                <span>{bar().snapshot.modelID}</span>
                <Show when={props.onInspect}>
                  <Button size="small" variant="ghost" onClick={() => props.onInspect?.(bar().snapshot)}>
                    {_(D.requestDetails)}
                  </Button>
                </Show>
              </div>
              <Show when={bar().snapshot.compactedBefore}>
                <p class="context-note">{_(D.compaction)}</p>
              </Show>
            </>
          )}
        </Show>
      </div>
    </section>
  )
}
