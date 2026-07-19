import { createMemo, Show } from "solid-js"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { ProgressCircle } from "@ericsanchezok/synergy-ui/progress-circle"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useWorkbenchPanels } from "@/context/workbench"
import { useLocale } from "@/context/locale"
import { statusBar as T } from "@/locales/messages"
import {
  buildContextPanelModel,
  createContextPanelPresentation,
  formatContextNumber,
  formatContextPercent,
} from "@/components/workspace/context-model"
import { contextStatusAriaLabel, openContextPanel } from "./context-status-model"

function toneClass(tone: ReturnType<typeof buildContextPanelModel>["statusTone"]) {
  if (tone === "critical") return "text-icon-critical-base"
  if (tone === "warning") return "text-icon-warning-base"
  if (tone === "progress") return "text-text-interactive-base"
  return "text-text-weak"
}

export function ContextStatusButton() {
  const sync = useSync()
  const params = useParams()
  const workbench = useWorkbenchPanels()
  const { i18n, fmt } = useLocale()

  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const providers = createMemo(() =>
    Object.fromEntries(sync.data.provider.all.map((provider) => [provider.id, provider])),
  )
  const context = createMemo(() =>
    buildContextPanelModel({
      session: params.id ? sync.session.get(params.id) : undefined,
      messages: messages(),
      latestMessage: params.id ? sync.session.latestContextMessage(params.id) : null,
      providers: providers(),
      status: params.id ? sync.data.session_status[params.id] : undefined,
      pendingItems: params.id ? (sync.data.inbox[params.id]?.length ?? 0) : 0,
      presentation: createContextPanelPresentation(i18n, fmt),
    }),
  )
  const percentage = createMemo(() => context().usage.contextPercentage)
  const hasContext = createMemo(() => context().usage.exactInputTokens !== null)
  const label = createMemo(() => (percentage() === null ? "?" : Math.min(999, percentage()!).toString()))
  const formattedPercent = createMemo(() => formatContextPercent(percentage(), fmt.percent))
  const ariaLabel = createMemo(() =>
    contextStatusAriaLabel({
      exactInputTokens: context().usage.exactInputTokens,
      contextPercentage: percentage(),
      formatNumber: fmt.number,
      formatPercent: fmt.percent,
      usageUnavailable: i18n._(T.contextUsageUnavailable),
      formatUsage: (percent) => i18n._({ ...T.contextUsageKnown, values: { percent } }),
      formatLabel: (tokens, usage) => i18n._({ ...T.contextOpenAria, values: { tokens, usage } }),
    }),
  )

  const openContext = () =>
    openContextPanel({
      sessionID: params.id,
      openPanel: (panelID, options) => workbench.openPanel(panelID, options),
    })

  return (
    <Show when={hasContext()}>
      <Tooltip
        openDelay={0}
        placement="top"
        value={
          <div class="flex flex-col gap-0.5">
            <div class="flex items-center gap-1.5">
              <span class="text-text-invert-strong">
                {formatContextNumber(context().usage.exactInputTokens, fmt.number)}
              </span>
              <span class="text-text-invert-base">{i18n._(T.contextInputTokens)}</span>
              <Show
                when={percentage() !== null}
                fallback={<span class="text-text-invert-base">· {i18n._(T.contextLimitUnknown)}</span>}
              >
                <span class="text-text-invert-base">
                  · {i18n._({ ...T.contextUsageKnown, values: { percent: formattedPercent() } })}
                </span>
              </Show>
            </div>
            <span class="text-text-invert-base">
              {context().statusSummary} · {i18n._(T.contextClickHint)}
            </span>
          </div>
        }
      >
        <button
          type="button"
          class="relative flex size-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:shadow-xs-border-focus sm:size-7"
          aria-label={ariaLabel()}
          onClick={() => void openContext()}
        >
          <ProgressCircle
            size={28}
            strokeWidth={1.5}
            percentage={percentage() ?? 0}
            class={toneClass(context().statusTone)}
          />
          <span class={`absolute font-mono text-[9px] font-medium leading-none ${toneClass(context().statusTone)}`}>
            {label()}
          </span>
        </button>
      </Tooltip>
    </Show>
  )
}
