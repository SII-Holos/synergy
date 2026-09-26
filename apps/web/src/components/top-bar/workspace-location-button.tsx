import { createSignal, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { workspaceCopy } from "@/components/dialog/workspace-dialog-copy"
import type { workspaceLocation } from "./workspace-location"

export function WorkspaceLocationButton(props: {
  project: string
  location: ReturnType<typeof workspaceLocation>
  onChoose: () => void
  disabled?: boolean
}) {
  const { _ } = useLingui()
  const [open, setOpen] = createSignal(false)
  const stateLabel = () =>
    props.location.state === "none"
      ? _(workspaceCopy.none)
      : props.location.state === "unavailable"
        ? _({ id: "workspace.location.unavailable", message: "Directory unavailable" })
        : props.location.state === "planned"
          ? _({ id: "workspace.location.planned", message: "Worktree pending" })
          : props.location.isolated
            ? _({ id: "workspace.location.isolated", message: "Isolated worktree" })
            : _({ id: "workspace.location.directory", message: "Local directory" })
  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-start"
      triggerAs={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          class="stb-selector-btn stb-location-btn"
          aria-label={_({
            id: "workspace.location.open",
            message: "Working location: {project}, {state}",
            values: { project: props.project, state: stateLabel() },
          })}
        >
          <Icon
            name={getSemanticIcon(props.location.isolated ? "workspace.worktree" : "workspace.main")}
            size="small"
            class="stb-folder"
          />
          <span class="stb-location-caption">
            <span class="stb-project-name">{props.project}</span>
            <span class="text-text-weak text-10-regular">{stateLabel()}</span>
          </span>
        </button>
      )}
    >
      <div class="flex flex-col gap-3 w-72 max-w-full">
        <div class="text-13-medium text-text-strong">{props.project}</div>
        <div class="text-12-regular text-text-weak">{stateLabel()}</div>
        <Show when={props.location.path}>
          <div class="text-12-regular break-all">{props.location.path}</div>
        </Show>
        <p class="text-12-regular text-text-weak">
          {_({
            id: "workspace.location.explanation",
            message:
              "File operations and commands use this session's working directory. Open files keep their original Workspace.",
          })}
        </p>
        <Button
          disabled={props.disabled}
          onClick={() => {
            setOpen(false)
            props.onChoose()
          }}
        >
          {_(workspaceCopy.title)}
        </Button>
      </div>
    </Popover>
  )
}
