import { List } from "@ericsanchezok/synergy-ui/list"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Show } from "solid-js"
import { useLocale } from "@/context/locale"
import { useLocal } from "@/context/local"
import { getAgentVisual } from "@/components/agent-visual"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { translateDescriptor } from "@/locales/translate"
import { PI } from "./prompt-input-i18n"

/** Agent picker shared by the desktop toolbar and the compact mobile chip row.
 *  Both surfaces need the same list, the same external-agent block and the same
 *  labels; only the trigger styling differs. */
export function AgentSelector(props: { hasMessages: () => boolean; compact?: boolean }) {
  const local = useLocal()
  const { i18n } = useLocale()
  const label = () => translateDescriptor(getAgentVisual(local.agent.current()).label, i18n)

  return (
    <ToolbarSelectorPopover
      triggerAs={(triggerProps) => (
        <Tooltip
          value={i18n._(PI.selectAgent)}
          placement="top"
          open={String(triggerProps["aria-expanded"]) === "true" ? false : undefined}
        >
          <button
            {...triggerProps}
            type="button"
            aria-label={`${i18n._(PI.selectAgent)}: ${label()}`}
            class="prompt-input-toolbar-button flex items-center gap-1.5"
            classList={{ "prompt-input-toolbar-chip": props.compact }}
          >
            <span class="text-12-medium text-text-base whitespace-nowrap">{label()}</span>
          </button>
        </Tooltip>
      )}
      title={i18n._(PI.selectAgent)}
      contentClass="w-72 max-h-80"
      placement="top-start"
    >
      {(close) => (
        <List
          class="p-1 [&_[data-slot=list-item]]:relative [&_[data-slot=list-item]:focus-visible]:bg-surface-raised-base-hover [&_[data-slot=list-item-selected-icon]]:absolute [&_[data-slot=list-item-selected-icon]]:right-3"
          items={local.agent.list().filter((a) => !a.hidden)}
          key={(x) => x.name}
          current={local.agent.current()}
          filterKeys={["name"]}
          onSelect={(x) => {
            if (!x) return
            if (props.hasMessages() && x.external) return
            local.agent.set(x.name)
            close()
          }}
        >
          {(agent) => {
            const visual = getAgentVisual(agent)
            return (
              <Tooltip
                placement="right"
                value={props.hasMessages() && agent.external ? i18n._(PI.externalAgentBlocked) : undefined}
              >
                <div
                  classList={{
                    "min-w-0 flex-1 pr-6 text-left": true,
                    "opacity-45": props.hasMessages() && !!agent.external,
                  }}
                >
                  <div class="min-w-0">
                    <div class="text-13-medium text-text-base truncate">{translateDescriptor(visual.label, i18n)}</div>
                    <Show when={visual.description}>
                      {(description) => (
                        <div class="mt-0.5 text-12-regular text-text-weak leading-snug whitespace-normal">
                          {translateDescriptor(description(), i18n)}
                        </div>
                      )}
                    </Show>
                  </div>
                </div>
              </Tooltip>
            )
          }}
        </List>
      )}
    </ToolbarSelectorPopover>
  )
}
