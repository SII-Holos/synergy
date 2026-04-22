import { createSignal, createMemo, For } from "solid-js"

export type RankItem = {
  id: string
  label: string
  value: number
  detail?: string
  sublabel?: string
}

const ANIMATION_STYLE = `
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
`

export function RankList(props: { title: string; icon: string; items: RankItem[]; defaultTop?: number }) {
  const top = () => props.defaultTop ?? 5
  const [expanded, setExpanded] = createSignal(false)

  const maxValue = createMemo(() => (props.items.length > 0 ? Math.max(...props.items.map((i) => i.value)) : 0))

  const hiddenCount = createMemo(() => Math.max(0, props.items.length - top()))

  const visibleItems = createMemo(() => {
    if (expanded()) return props.items
    return props.items.slice(0, top())
  })

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <div class="mt-5 mb-3 px-1">
        <span class="text-12-medium text-text-weak">
          {props.icon} {props.title}
        </span>
      </div>
      <div class="bg-surface-raised-base rounded-xl p-3">
        <For each={visibleItems()}>
          {(item, index) => {
            const widthPct = createMemo(() => (maxValue() > 0 ? (item.value / maxValue()) * 100 : 0))
            const stagger = () => (expanded() && index() >= top() ? (index() - top()) * 30 : 0)

            return (
              <div
                class="mb-2 last:mb-0"
                style={stagger() > 0 ? { animation: `fadeSlideIn 0.25s ease-out ${stagger()}ms both` } : undefined}
              >
                <div class="text-12-medium text-text-strong truncate">{item.label}</div>
                <div class="flex items-center gap-1">
                  <div class="h-1.5 rounded-full bg-surface-inset-base flex-1 min-w-0">
                    <div
                      class="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${widthPct()}%`,
                        background: "linear-gradient(to right, rgba(99, 102, 241, 0.7), rgba(139, 92, 246, 0.7))",
                      }}
                    />
                  </div>
                  <span class="text-11-medium text-text-base tabular-nums ml-2 shrink-0">
                    {item.value.toLocaleString()}
                  </span>
                </div>
                {(item.sublabel || item.detail) && (
                  <div class="text-10-regular text-text-weakest">
                    {[item.sublabel, item.detail].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
            )
          }}
        </For>
        {hiddenCount() > 0 && (
          <div class="text-center mt-2">
            <button
              class="text-11-medium text-text-interactive-base hover:underline cursor-pointer bg-transparent border-none"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded() ? "▲ Show less" : `▼ Show ${hiddenCount()} more`}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
