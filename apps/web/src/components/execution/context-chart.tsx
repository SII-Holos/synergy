import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useLingui } from "@lingui/solid"
import type { ExecutionContextSnapshot, ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { contextHistoryBars } from "./context-chart-model"
import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import { E } from "./i18n"
import { D } from "./context-categories"

const windowSize = 24
const tickFractions = [0, 0.25, 0.5, 0.75, 1]

export function ContextHistoryChart(props: {
  windowStart: string
  onWindowStart: (id: string) => void
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
  const history = createMemo(() => contextHistoryBars(props.items, props.grouping, props.delta))
  const lastStart = () => Math.max(0, history().length - windowSize)
  const start = createMemo(() => {
    if (!props.windowStart) return lastStart()
    const anchor = props.items.find((entry) => entry.callID === props.windowStart)
    const index = history().findIndex(
      (bar) =>
        bar.snapshot.callID === props.windowStart ||
        (props.grouping === "round" && bar.snapshot.runID === anchor?.runID),
    )
    return Math.max(0, Math.min(index, lastStart()))
  })
  let scroller!: HTMLDivElement
  let scrollAnchor = props.windowStart
  const [width, setWidth] = createSignal(0)
  const [fraction, setFraction] = createSignal(0)
  const bars = createMemo(() => history().slice(start(), start() + windowSize + (fraction() > 0.01 ? 1 : 0)))
  onMount(() => {
    const observer = new ResizeObserver(() => setWidth(scroller.clientWidth))
    observer.observe(scroller)
    setWidth(scroller.clientWidth)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => {
    if (scrollAnchor !== props.windowStart) {
      scrollAnchor = props.windowStart
      setFraction(0)
    }
    const left = ((start() + fraction()) * width()) / windowSize
    if (scroller && Math.abs(scroller.scrollLeft - left) > 0.5) scroller.scrollLeft = left
  })
  const scroll = () => {
    if (!width()) return
    const measured = Math.min(lastStart(), (scroller.scrollLeft * windowSize) / width())
    const nearest = Math.round(measured)
    const position = Math.abs(measured - nearest) <= windowSize / width() ? nearest : measured
    if (Math.abs(position - start() - fraction()) < windowSize / width()) return
    const index = Math.floor(position + 0.0001)
    const latest = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft < 1
    scrollAnchor = latest ? "" : (history()[index]?.snapshot.callID ?? "")
    batch(() => {
      setFraction(latest ? 0 : position - index)
      props.onWindowStart(scrollAnchor)
      setHovered("")
      props.onPreview?.("")
      if (latest) props.onSelect("")
    })
  }
  const moveWindow = (index: number) => {
    setFraction(0)
    setHovered("")
    props.onPreview?.("")
    props.onWindowStart(index >= lastStart() ? "" : (history()[Math.max(0, index)]?.snapshot.callID ?? ""))
  }
  let revealed = props.windowStart ? props.selected : ""
  createEffect(() => {
    const id = props.selected
    const entries = history()
    if (!id) {
      revealed = ""
      return
    }
    if (id === revealed) return
    const selected = props.selectedSnapshot ?? props.items.find((entry) => entry.callID === id)
    const index = entries.findIndex(
      (bar) => bar.snapshot.callID === id || (props.grouping === "round" && bar.snapshot.runID === selected?.runID),
    )
    if (index < 0) return
    revealed = id
    if (index < start() || index >= start() + windowSize) moveWindow(index)
    if (!props.windowStart && history().length > windowSize) props.onWindowStart(bars()[0].snapshot.callID)
  })
  const selectedID = () => props.selected || props.selectedSnapshot?.callID
  const tokenMaximum = createMemo(() => {
    const divisions = props.delta ? 2 : 4
    const maximum = Math.max(
      1,
      ...bars().flatMap((bar) => [
        bar.values.reduce((sum, value) => sum + Math.max(0, value.tokens), 0),
        bar.values.reduce((sum, value) => sum + Math.max(0, -value.tokens), 0),
      ]),
    )
    return Math.ceil(maximum / divisions) * divisions
  })
  const timingMaximum = createMemo(
    () => Math.max(1, Math.ceil(Math.max(0, ...bars().map((bar) => bar.snapshot.elapsedMs ?? 0)) / 4000)) * 4000,
  )
  const timingPath = createMemo(() => {
    let previous: { x: number; y: number; ordinal: number; sessionID: string } | undefined
    return history()
      .map((bar, index) => {
        const elapsed = bar.snapshot.elapsedMs
        if (elapsed == null) {
          previous = undefined
          return ""
        }
        const ordinal = props.grouping === "request" ? bar.snapshot.requestNumber : bar.snapshot.roundNumber
        if (previous && (previous.ordinal + 1 !== ordinal || previous.sessionID !== bar.snapshot.sessionID))
          previous = undefined
        const point = {
          x: ((index + 0.5) / history().length) * 100,
          y: 100 - (elapsed / timingMaximum()) * 100,
          ordinal,
          sessionID: bar.snapshot.sessionID,
        }
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
          props.grouping === "request"
            ? history()[index].snapshot.requestNumber
            : history()[index].snapshot.roundNumber,
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
      <div class="context-history-plot" data-delta={props.delta} data-timing={timing()}>
        <div class="context-chart-scale" aria-hidden="true">
          <For each={tickFractions}>
            {(fraction) => <span>{number(tokenMaximum() * (1 - fraction * (props.delta ? 2 : 1)))}</span>}
          </For>
        </div>
        <div ref={scroller} class="context-chart-scroll" onScroll={scroll}>
          <div
            class="context-chart-bars"
            style={{ width: `${Math.max(1, history().length / windowSize) * 100}%` }}
            onMouseLeave={() => {
              setHovered("")
              props.onPreview?.("")
            }}
          >
            <For each={history().map((bar) => bar.snapshot.callID)}>
              {(id, index) => {
                const bar = () => history().find((entry) => entry.snapshot.callID === id)!
                return (
                  <Tooltip
                    class="context-history-target"
                    placement="top"
                    openDelay={120}
                    value={
                      <span class="context-chart-tooltip">
                        <strong>{label(index())}</strong>
                        <span>
                          {_(D.input)}{" "}
                          {bar().display.total == null
                            ? "—"
                            : (bar().display.estimated ? "≈" : "") + number(bar().display.total!)}
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
                      data-selected={bar().snapshot.callID === selectedID()}
                      data-gap={bar().gap}
                      data-preview={hovered() === id}
                      aria-pressed={bar().snapshot.callID === selectedID()}
                      aria-label={
                        label(index()) +
                        " · " +
                        (bar().total == null ? "—" : (bar().display.estimated ? "≈" : "") + number(bar().total!)) +
                        (bar().snapshot.compactedBefore ? " · " + _(D.compaction) : "")
                      }
                      onMouseEnter={() => {
                        setHovered(bar().snapshot.callID)
                        props.onPreview?.(bar().snapshot.callID)
                      }}
                      onFocus={() => {
                        if (index() < start()) moveWindow(index())
                        else if (index() >= start() + windowSize) moveWindow(index() - windowSize + 1)
                        if (!props.windowStart && history().length > windowSize)
                          props.onWindowStart(bars()[0].snapshot.callID)
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
                        neighbor
                          ?.querySelector<HTMLButtonElement>(".context-history-bar")
                          ?.focus({ preventScroll: true })
                      }}
                    >
                      <span class="context-bar-positive" aria-hidden="true">
                        <For
                          each={bar()
                            .values.filter((value) => value.tokens > 0)
                            .map((value) => value.category)}
                        >
                          {(category) => (
                            <span
                              style={{
                                height:
                                  ((bar().values.find((value) => value.category === category)?.tokens ?? 0) /
                                    tokenMaximum()) *
                                    100 +
                                  "%",
                                background: bar().values.find((value) => value.category === category)?.color,
                              }}
                            />
                          )}
                        </For>
                      </span>
                      <Show when={props.delta}>
                        <span class="context-bar-negative" aria-hidden="true">
                          <For
                            each={bar()
                              .values.filter((value) => value.tokens < 0)
                              .map((value) => value.category)}
                          >
                            {(category) => (
                              <span
                                style={{
                                  height:
                                    (-(bar().values.find((value) => value.category === category)?.tokens ?? 0) /
                                      tokenMaximum()) *
                                      100 +
                                    "%",
                                  background: bar().values.find((value) => value.category === category)?.color,
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
                <For each={history()}>
                  {(bar, index) => (
                    <Show when={bar.snapshot.elapsedMs != null}>
                      <path
                        class="context-timing-point"
                        d={`M${((index() + 0.5) / history().length) * 100},${100 - (bar.snapshot.elapsedMs! / timingMaximum()) * 100} l0,0`}
                        data-active={bar.snapshot.callID === hovered() || bar.snapshot.callID === selectedID()}
                      />
                    </Show>
                  )}
                </For>
              </svg>
            </Show>
          </div>
        </div>
        <Show when={timing()}>
          <div class="context-chart-scale context-time-scale" aria-hidden="true">
            <For each={tickFractions}>
              {(fraction) => (
                <span>{fraction === 1 ? "0" : executionDuration(timingMaximum() * (1 - fraction), false)}</span>
              )}
            </For>
          </div>
        </Show>
        <div class="context-chart-caption">
          <span>{bars().length ? label(start()) : "—"}</span>
          <span>{bars().length ? label(start() + bars().length - 1) : "—"}</span>
        </div>
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
                  <dd>
                    {bar().display.total == null
                      ? "—"
                      : (bar().display.estimated ? "≈" : "") + number(bar().display.total!)}
                  </dd>
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
