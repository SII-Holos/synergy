import { For, createMemo } from "solid-js"
import { Doughnut } from "solid-chartjs"
import { Chart as ChartJS, ArcElement, Tooltip, DoughnutController } from "chart.js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { formatCompact } from "./use-stats"
import { useChartTheme } from "../visualization/use-chart-theme"
import { useLocale } from "@/context/locale"
import { S } from "./stats-i18n"

ChartJS.register(ArcElement, Tooltip, DoughnutController)

type TokenKey = "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite"
type Segment = {
  key: TokenKey
  label: string
  color: string
  note?: string
}

const LEFT_KEYS: TokenKey[] = ["input", "reasoning", "cacheRead"]
const RIGHT_KEYS: TokenKey[] = ["output", "cacheWrite"]

const ANIMATION_STYLE = `
@keyframes tokenRingEnter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`

function tokenValue(tokens: StatsSnapshot["tokenCost"]["tokens"], key: TokenKey) {
  switch (key) {
    case "input":
      return tokens.input
    case "output":
      return tokens.output
    case "reasoning":
      return tokens.reasoning
    case "cacheRead":
      return tokens.cache.read
    case "cacheWrite":
      return tokens.cache.write
  }
}

function Connector(props: { color: string; side: "left" | "right" }) {
  return (
    <div class={`flex min-w-10 items-center ${props.side === "left" ? "justify-end" : "justify-start"}`}>
      <div
        class="h-px w-full rounded-full opacity-70"
        style={{
          background:
            props.side === "left"
              ? `linear-gradient(to right, var(--border-weaker-base), ${props.color})`
              : `linear-gradient(to left, var(--border-weaker-base), ${props.color})`,
        }}
      />
      <span
        class={`h-2 w-2 shrink-0 rounded-full ${props.side === "left" ? "-ml-1" : "-mr-1"}`}
        style={{ "background-color": props.color }}
      />
    </div>
  )
}

function Callout(props: {
  align: "left" | "right"
  segment: Segment & { value: number; share: number }
  shareLabel: string
}) {
  const isLeft = () => props.align === "left"

  return (
    <div class={`flex items-center gap-3 ${isLeft() ? "justify-end" : "justify-start"}`}>
      {isLeft() ? null : <Connector color={props.segment.color} side="right" />}
      <div
        class={`min-w-0 flex-1 rounded-2xl bg-surface-inset-base/40 px-3 py-2.5 ring-1 ring-inset ring-border-weaker-base ${
          isLeft() ? "text-right" : "text-left"
        }`}
      >
        <div class={`flex items-center gap-2 ${isLeft() ? "justify-end" : "justify-start"}`}>
          <span class="text-10-medium uppercase tracking-[0.16em] text-text-weaker">{props.segment.label}</span>
          <span class="h-2 w-2 shrink-0 rounded-full" style={{ "background-color": props.segment.color }} />
        </div>
        <div class="mt-1 text-lg font-semibold tracking-tight text-text-strong tabular-nums">
          {formatCompact(props.segment.value)}
        </div>
        <div class="mt-1 text-10-regular text-text-weak">{props.shareLabel}</div>
        {props.segment.note ? <div class="mt-1 text-10-regular text-text-weaker">{props.segment.note}</div> : null}
      </div>
      {isLeft() ? <Connector color={props.segment.color} side="left" /> : null}
    </div>
  )
}

export function TokenRing(props: { tokens: StatsSnapshot["tokenCost"]["tokens"]; cacheHitRate: number }) {
  const theme = useChartTheme()
  const { i18n } = useLocale()

  const segments = createMemo<Segment[]>(() => {
    const colors = theme().series
    return [
      { key: "input", label: i18n._(S.tokenInput.id), color: colors[0]! },
      { key: "output", label: i18n._(S.tokenOutput.id), color: colors[1]! },
      { key: "reasoning", label: i18n._(S.tokenReasoning.id), color: colors[2]! },
      {
        key: "cacheRead",
        label: i18n._(S.tokenCacheRead.id),
        note: i18n._(S.tokenCacheReadNote.id),
        color: colors[3]!,
      },
      {
        key: "cacheWrite",
        label: i18n._(S.tokenCacheWrite.id),
        note: i18n._(S.tokenCacheWriteNote.id),
        color: colors[4]!,
      },
    ]
  })

  const segmentData = createMemo(() => {
    const total = segments().reduce((sum, segment) => sum + tokenValue(props.tokens, segment.key), 0)

    return segments().map((segment) => {
      const value = tokenValue(props.tokens, segment.key)
      return {
        ...segment,
        value,
        share: total > 0 ? value / total : 0,
      }
    })
  })

  const total = createMemo(() => segmentData().reduce((sum, segment) => sum + segment.value, 0))
  const leftSegments = createMemo(() => segmentData().filter((segment) => LEFT_KEYS.includes(segment.key)))
  const rightSegments = createMemo(() => segmentData().filter((segment) => RIGHT_KEYS.includes(segment.key)))
  const cacheEfficiency = createMemo(() => Math.max(0, Math.min(100, Math.round(props.cacheHitRate * 100))))

  const formatShare = (share: number): string => {
    const pct = share * 100
    if (!Number.isFinite(pct) || pct <= 0) return i18n._(S.tokenShareTotal.id, { pct: "0" })
    if (pct < 1) return i18n._(S.tokenShareSubOne.id)
    const rounded = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)
    return i18n._(S.tokenShareTotal.id, { pct: `${rounded}%` })
  }

  const chartData = createMemo(() => ({
    labels: segmentData().map((segment) => segment.label),
    datasets: [
      {
        data: segmentData().map((segment) => segment.value),
        backgroundColor: segmentData().map((segment) => segment.color),
        borderWidth: 3,
        borderColor: theme().background,
        hoverBorderColor: theme().grid,
        spacing: 4,
      },
    ],
  }))

  const chartOptions = createMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    cutout: "72%" as const,
    animation: {
      animateRotate: true,
      duration: 900,
      easing: "easeOutQuart" as const,
    },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        callbacks: {
          label: (ctx: { label?: string; raw: number | string }) => {
            const raw = Number(ctx.raw ?? 0)
            const pct = total() > 0 ? ((raw / total()) * 100).toFixed(raw > 0 && raw / total() < 0.1 ? 1 : 0) : "0"
            return `${ctx.label}: ${formatCompact(raw)} (${pct}%)`
          },
        },
      },
    },
  }))

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <section
        class="rounded-2xl bg-surface-raised-base px-4 py-5"
        style={{ animation: "tokenRingEnter 0.38s cubic-bezier(0.34, 1.56, 0.64, 1) 220ms both" }}
      >
        <div class="grid items-center gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div class="order-2 grid gap-2.5 lg:order-1">
            <For each={leftSegments()}>
              {(segment) => <Callout align="left" segment={segment} shareLabel={formatShare(segment.share)} />}
            </For>
          </div>

          <div class="order-1 flex justify-center lg:order-2">
            <div class="relative rounded-full bg-surface-inset-base/35 p-3 ring-1 ring-inset ring-border-weaker-base">
              <div class="relative h-40 w-40 sm:h-44 sm:w-44">
                <Doughnut data={chartData()} options={chartOptions()} />
                <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-7 text-center">
                  <span class="text-10-medium uppercase tracking-[0.18em] text-text-weaker">
                    {i18n._(S.tokenCacheEfficiency.id)}
                  </span>
                  <span class="mt-1 text-24-semibold text-text-strong tabular-nums">{cacheEfficiency()}%</span>
                  <span class="mt-1 text-10-regular leading-4 text-text-weak">
                    {i18n._(S.tokenCacheEfficiencyNote.id)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="order-3 grid gap-2.5">
            <For each={rightSegments()}>
              {(segment) => <Callout align="right" segment={segment} shareLabel={formatShare(segment.share)} />}
            </For>
          </div>
        </div>
      </section>
    </>
  )
}
