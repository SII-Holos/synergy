import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { createMemo, Show } from "solid-js"
import { useLocale } from "@/context/locale"
import { useLocal } from "@/context/local"
import { getAgentVisual } from "@/components/agent-visual"
import { translateDescriptor } from "@/locales/translate"
import { PI } from "./prompt-input-i18n"

export function AgentSelector(props: { hasMessages: () => boolean }) {
  const local = useLocal()
  const { i18n } = useLocale()
  const label = () => translateDescriptor(getAgentVisual(local.agent.current()).label, i18n)
  const options = createMemo(() =>
    local.agent
      .list()
      .filter((agent) => !agent.hidden)
      .map((agent) => {
        const visual = getAgentVisual(agent)
        return {
          value: agent.name,
          label: translateDescriptor(visual.label, i18n),
          description: visual.description ? translateDescriptor(visual.description, i18n) : undefined,
          disabled: props.hasMessages() && !!agent.external,
        }
      }),
  )

  return (
    <MenuField
      value={local.agent.current()?.name ?? ""}
      options={options()}
      onChange={(value) => local.agent.set(value)}
      ariaLabel={i18n._(PI.selectAgent)}
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
          >
            <span class="text-12-medium text-text-base whitespace-nowrap">{label()}</span>
          </button>
        </Tooltip>
      )}
      surfaceClass="w-72!"
      placement="top-start"
    >
      {(option) => (
        <Tooltip placement="right" value={option.disabled ? i18n._(PI.externalAgentBlocked) : undefined}>
          <div class="min-w-0 text-left">
            <div class="text-13-medium text-text-base truncate">{option.label}</div>
            <Show when={options().find((entry) => entry.value === option.value)?.description}>
              {(description) => (
                <div class="mt-0.5 text-12-regular text-text-weak leading-snug whitespace-normal">{description()}</div>
              )}
            </Show>
          </div>
        </Tooltip>
      )}
    </MenuField>
  )
}
