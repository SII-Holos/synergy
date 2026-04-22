import { createMemo, For } from "solid-js"

const CELL_STYLE = `
@keyframes cellPop {
  from { opacity: 0; transform: scale(0); }
  to { opacity: 1; transform: scale(1); }
}
`

function cellColor(value: number, thresholds: [number, number, number]): string {
  if (value === 0) return "bg-surface-inset-base/30"
  if (value <= thresholds[0]) return "bg-indigo-400/20"
  if (value <= thresholds[1]) return "bg-indigo-400/40"
  if (value <= thresholds[2]) return "bg-indigo-400/60"
  return "bg-indigo-400/80"
}

function formatHour(h: number): string {
  return `${h.toString().padStart(2, "0")}:00`
}

export function HourlyHeatmap(props: { hourlyActivity: number[] }) {
  const thresholds = createMemo(() => {
    const nonZero = props.hourlyActivity.filter((v) => v > 0)
    if (nonZero.length === 0) return [1, 1, 1] as [number, number, number]
    const sorted = [...nonZero].sort((a, b) => a - b)
    const p25 = sorted[Math.floor(sorted.length * 0.25)]
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p75 = sorted[Math.floor(sorted.length * 0.75)]
    return [p25, p50, p75] as [number, number, number]
  })

  return (
    <>
      <style>{CELL_STYLE}</style>
      <div class="text-12-medium text-text-weak mt-5 mb-3 px-1">⏰ Activity Pattern</div>
      <div class="bg-surface-raised-base rounded-xl p-4 mt-5">
        <div class="flex gap-0.5">
          <For each={props.hourlyActivity}>
            {(count, i) => (
              <div
                class={`w-full aspect-square rounded-sm ${cellColor(count, thresholds())} transition-transform hover:scale-130 cursor-default`}
                style={{ animation: `cellPop 300ms cubic-bezier(0.34, 1.56, 0.64, 1) ${i() * 20}ms both` }}
                title={`${formatHour(i())} — ${count} sessions`}
              />
            )}
          </For>
        </div>
        <div class="grid grid-cols-4 mt-1.5">
          {[0, 6, 12, 18].map((h) => (
            <span class="text-9-regular text-text-weakest text-center">{formatHour(h)}</span>
          ))}
        </div>
      </div>
    </>
  )
}
