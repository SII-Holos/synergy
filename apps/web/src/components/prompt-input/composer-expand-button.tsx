import { Show, createSignal, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import type { PluginInputService } from "@ericsanchezok/synergy-plugin"
import { composerPresentation } from "./composer-presentation"

export function ComposerExpandButton(props: { input: Pick<PluginInputService, "current"> }) {
  const binding = composerPresentation(props.input)
  const { _ } = useLingui()
  const [version, setVersion] = createSignal(0)
  if (binding) onCleanup(binding.state.subscribe(() => setVersion((value) => value + 1)))
  const expanded = () => {
    version()
    return !!binding?.state.expanded
  }
  return (
    <Show when={binding && props.input.current().mode === "normal"}>
      <div class="composer-expand-region">
        <Tooltip
          value={
            expanded()
              ? _({ id: "prompt.long.collapse", message: "Collapse editor" })
              : _({ id: "prompt.long.expand", message: "Expand editor" })
          }
        >
          <button
            type="button"
            class="composer-expand-control"
            aria-label={
              expanded()
                ? _({ id: "prompt.long.collapse", message: "Collapse editor" })
                : _({ id: "prompt.long.expand", message: "Expand editor" })
            }
            aria-expanded={expanded()}
            onClick={() => (expanded() ? binding?.state.collapse() : binding?.state.expand())}
          >
            <Icon name={getSemanticIcon(expanded() ? "action.collapse" : "action.expand")} size="small" />
          </button>
        </Tooltip>
      </div>
    </Show>
  )
}
