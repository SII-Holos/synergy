import type { SessionWorkspaceTransitionRequest } from "../session/worktree-session"
import { WorktreeEnterConfirmDialog } from "../session/worktree-transition-dialog"
import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLayout } from "@/context/layout"
import { resolveProjectScope } from "@/utils/scope"
import type { PromptStartOptionGroup } from "../prompt-input/start-options"
import { DialogWorkspace } from "./dialog-workspace"
import { DialogEnvironment } from "./dialog-environment"
import { DialogExecutionLocation } from "./dialog-execution-location"
import { DialogScopeEdit } from "./dialog-scope-edit"
import { locationCopy as copy } from "./task-location-copy"
import "./project-flow.css"

export function DialogWorkingLocation(props: {
  onWorkspaceTransition?: (request: SessionWorkspaceTransitionRequest) => void
  running?: boolean
  sessionID?: string
  summary: string
  nativeFiles: boolean
  profile?: string | null
  environmentID?: string | null
  mainWorkspaceID?: string | null
  selection?: SessionWorkspaceSelection
  onWorkspaceSelect?: (selection: SessionWorkspaceSelection) => void
  onProfileChange?: (value: string | null | undefined) => void
  onEnvironmentChange?: (value: string | null | undefined) => void
  groups: PromptStartOptionGroup[]
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const layout = useLayout()
  const project = () => resolveProjectScope(sdk.scopeKey, sync.scope, layout.scopes.list())
  const labels = () => ({
    "workspace.local": _(copy.files),
    "workspace.worktree": _(copy.planned),
    "workspace.directory": _(copy.chooseFiles),
    "workspace.existing": _(copy.continueCopy),
  })
  return (
    <Dialog title={_(copy.title)} description={props.summary} size="form">
      <div data-slot="dialog-form" class="project-flow">
        <section class="project-flow-section">
          <h3>{_(copy.files)}</h3>
          <p>{_(copy.fileDescription)}</p>
          <Show
            when={!props.sessionID}
            fallback={
              <div class="project-flow-section">
                <Button
                  variant="secondary"
                  disabled={props.running}
                  onClick={() =>
                    dialog.push(() => <DialogWorkspace target={{ kind: "session", sessionID: props.sessionID! }} />)
                  }
                >
                  {_(copy.chooseFiles)}
                </Button>
                <Show
                  when={sync.scope?.local?.vcs === "git" && props.onWorkspaceTransition && sync.data.path.directory}
                >
                  <Button
                    variant="secondary"
                    disabled={props.running}
                    onClick={() =>
                      dialog.push(() => (
                        <WorktreeEnterConfirmDialog
                          sessionID={props.sessionID!}
                          directory={sync.data.path.directory!}
                          onConfirm={props.onWorkspaceTransition!}
                        />
                      ))
                    }
                  >
                    {_(copy.createCopy)}
                  </Button>
                </Show>
              </div>
            }
          >
            <div class="project-flow-list">
              <For each={props.groups.flatMap((group) => group.options)}>
                {(option) => (
                  <button
                    type="button"
                    class="project-flow-row"
                    aria-pressed={option.selected}
                    disabled={option.disabled}
                    title={option.tooltip}
                    onClick={() => {
                      dialog.close()
                      option.onSelect()
                    }}
                  >
                    <Icon name={option.icon} size="small" />
                    <span class="project-flow-row-copy">
                      <strong>{labels()[option.id as keyof ReturnType<typeof labels>] ?? option.label}</strong>
                    </span>
                    <span class="project-flow-check">
                      <Show when={option.selected}>
                        <Icon name={getSemanticIcon("state.success")} size="small" />
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </section>
        <section class="project-flow-section">
          <h3>{_(copy.execution)}</h3>
          <p>{_(props.running ? copy.running : copy.executionDescription)}</p>
          <Button
            variant="secondary"
            disabled={props.running}
            onClick={() =>
              dialog.push(() => (
                <DialogExecutionLocation
                  sessionID={props.sessionID}
                  running={props.running}
                  profile={props.profile}
                  nativeFiles={props.nativeFiles}
                  onSelect={props.onProfileChange}
                />
              ))
            }
          >
            {_(copy.execution)}
          </Button>
        </section>
        <Show when={!sdk.isHome && project()}>
          {(scope) => (
            <Button
              variant="ghost"
              onClick={() => dialog.push(() => <DialogScopeEdit scope={{ ...scope(), expanded: true }} />)}
            >
              {_(copy.manage)}
            </Button>
          )}
        </Show>
        <details>
          <summary>{_(copy.advanced)}</summary>
          <div class="project-flow-section">
            <Button
              variant="ghost"
              onClick={() =>
                dialog.push(() =>
                  props.sessionID ? (
                    <DialogWorkspace target={{ kind: "session", sessionID: props.sessionID }} />
                  ) : props.onWorkspaceSelect ? (
                    <DialogWorkspace
                      target={{ kind: "draft", selection: props.selection, onSelect: props.onWorkspaceSelect }}
                      environmentProfile={props.profile}
                      environmentID={props.environmentID}
                      mainWorkspaceID={props.mainWorkspaceID}
                    />
                  ) : (
                    <DialogWorkspace mode="manage" />
                  ),
                )
              }
            >
              {_(copy.manageFiles)}
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                dialog.push(() => (
                  <DialogEnvironment sessionID={props.sessionID} onSelect={props.onEnvironmentChange} />
                ))
              }
            >
              {_(copy.manageExecution)}
            </Button>
          </div>
        </details>
      </div>
    </Dialog>
  )
}
