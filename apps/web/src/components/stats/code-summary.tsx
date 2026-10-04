import { createMemo } from "solid-js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { useLocale } from "@/context/locale"
import { formatCompact } from "./use-stats"
import { S } from "./stats-i18n"

function formatSignedCompact(value: number) {
  if (value > 0) return `+${formatCompact(value)}`
  if (value < 0) return `-${formatCompact(Math.abs(value))}`
  return "0"
}

function ratio(value: number, total: number) {
  if (total <= 0 || value <= 0) return 0
  return Math.max(0, Math.min(100, (value / total) * 100))
}

function CompactStat(props: { label: string; value: string; hint: string }) {
  return (
    <div class="stats-code-detail">
      <div class="app-panel-caption font-medium text-text-weaker">{props.label}</div>
      <div class="mt-1 app-panel-section-title tabular-nums tracking-tight text-text-base">{props.value}</div>
      <div class="mt-1 app-panel-caption leading-4 text-text-weak">{props.hint}</div>
    </div>
  )
}

function CompositionRow(props: { label: string; value: string; share: number; tone: "add" | "delete" }) {
  const { i18n } = useLocale()
  const tone = () => (props.tone === "add" ? "text-text-diff-add-base" : "text-text-diff-delete-base")
  return (
    <div class="stats-code-detail">
      <div class="flex items-center justify-between gap-3">
        <span class="app-panel-caption font-medium text-text-base">{props.label}</span>
        <span class={`app-panel-control tabular-nums ${tone()}`}>{props.value}</span>
      </div>
      <p class="mt-1 app-panel-caption text-text-weak">
        {i18n._(S.codeShareTotal.id, { pct: String(Math.round(props.share)) })}
      </p>
    </div>
  )
}

export function CodeSummary(props: { codeChanges: StatsSnapshot["codeChanges"] }) {
  const { i18n } = useLocale()
  const added = () => props.codeChanges.totalAdditions
  const removed = () => props.codeChanges.totalDeletions
  const net = () => Math.abs(props.codeChanges.netLines)

  const totalChanged = createMemo(() => props.codeChanges.totalAdditions + props.codeChanges.totalDeletions)
  const addShare = createMemo(() => ratio(props.codeChanges.totalAdditions, totalChanged()))
  const removeShare = createMemo(() => ratio(props.codeChanges.totalDeletions, totalChanged()))
  const averagePerDay = createMemo(() => formatSignedCompact(Math.round(props.codeChanges.dailyAdditions)))
  const averageRemovedPerDay = createMemo(() => formatSignedCompact(-Math.round(props.codeChanges.dailyDeletions)))
  const throughput = createMemo(() => {
    const files = Math.max(props.codeChanges.totalFiles, 1)
    return formatCompact(Math.round(totalChanged() / files))
  })
  const growthLine = createMemo(() => {
    if (props.codeChanges.netLines > 0) return i18n._(S.codeGrowthOutpaced.id)
    if (props.codeChanges.netLines < 0) return i18n._(S.codeCleanupOutpaced.id)
    return i18n._(S.codeBalanced.id)
  })
  const compositionLine = createMemo(() => {
    const changed = totalChanged()
    if (changed <= 0) return i18n._(S.codeNoMovement.id)
    return i18n._(S.codeMovedOverall.id, { count: formatCompact(changed) })
  })

  return (
    <section class="stats-code-summary">
      <h3 class="app-panel-section-title text-text-strong">{i18n._(S.codeHeader.id)}</h3>
      <div class="stats-code-layout">
        <div class="stats-code-main">
          <div class="stats-code-growth">
            <div class="min-w-0">
              <div class="app-panel-caption font-medium text-text-weak">{i18n._(S.codeNetGrowth.id)}</div>
              <div class="mt-2 app-panel-value tabular-nums text-text-strong">
                {props.codeChanges.netLines >= 0 ? "+" : "-"}
                {formatCompact(net())}
              </div>
              <p class="mt-1 app-panel-caption text-text-weak">{growthLine()}</p>
            </div>
            <div class="min-w-0">
              <div class="app-panel-caption font-medium text-text-weak">{i18n._(S.codeFlow.id)}</div>
              <p class="mt-1 app-panel-copy text-text-base">{compositionLine()}</p>
            </div>
          </div>
          <div class="stats-code-composition">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="app-panel-caption font-medium text-text-weak">{i18n._(S.codeAddedVsRemoved.id)}</div>
                <p class="mt-1 app-panel-caption text-text-weak">{i18n._(S.codeBreakdownSubtitle.id)}</p>
              </div>
              <div class="app-panel-caption text-text-weak">
                <div>{i18n._(S.codeSharePct.id, { pct: String(Math.round(addShare())) })}</div>
                <div>{i18n._(S.codeRemovePct.id, { pct: String(Math.round(removeShare())) })}</div>
              </div>
            </div>
            <div class="stats-code-composition-track">
              <div class="bg-surface-diff-add-strong" style={{ width: `${addShare()}%` }} />
              <div class="bg-surface-diff-delete-strong" style={{ width: `${removeShare()}%` }} />
            </div>
          </div>
          <div class="stats-code-breakdown">
            <CompositionRow
              label={i18n._(S.codeLinesAdded.id)}
              tone="add"
              value={`+${formatCompact(added())}`}
              share={addShare()}
            />
            <CompositionRow
              label={i18n._(S.codeLinesRemoved.id)}
              tone="delete"
              value={`-${formatCompact(removed())}`}
              share={removeShare()}
            />
          </div>
        </div>
        <div class="stats-code-detail-grid">
          <CompactStat
            label={i18n._(S.codeFilesTouched.id)}
            value={formatCompact(props.codeChanges.totalFiles)}
            hint={i18n._(S.codeFilesHint.id)}
          />
          <CompactStat label={i18n._(S.codeAddsPerDay.id)} value={averagePerDay()} hint={i18n._(S.codeAddsHint.id)} />
          <CompactStat
            label={i18n._(S.codeRemovalsPerDay.id)}
            value={averageRemovedPerDay()}
            hint={i18n._(S.codeRemovalsHint.id)}
          />
          <CompactStat
            label={i18n._(S.codeLinesPerFile.id)}
            value={throughput()}
            hint={i18n._(S.codeLinesPerFileHint.id)}
          />
        </div>
      </div>
    </section>
  )
}
