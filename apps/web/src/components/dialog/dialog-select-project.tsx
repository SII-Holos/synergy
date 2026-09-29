import { useGlobalSDK } from "@/context/global-sdk"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { getScopeLabel } from "@/utils/scope"
import { requestErrorMessage } from "@/utils/error"
import { useProjectDirectoryPicker } from "./project-directory-picker"
import { projectFlowCopy as copy } from "./project-flow-copy"
import "./project-flow.css"

export function DialogSelectProject(props: {
  selected?: string
  onSelect: (scopeID: string) => Promise<void | boolean> | void | boolean
}) {
  const { _ } = useLingui()
  const layout = useLayout()
  const sync = useGlobalSync()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const client = sdk.client
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  createEffect(() => {
    if (sdk.client !== client) dialog.close()
  })
  const picker = useProjectDirectoryPicker()
  const [query, setQuery] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const projects = createMemo(() =>
    sync.data.scope
      .filter(
        (scope) =>
          !scope.time.archived &&
          `${getScopeLabel(scope)} ${scope.local?.worktree ?? ""}`
            .toLocaleLowerCase()
            .includes(query().toLocaleLowerCase()),
      )
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )
  async function choose(scopeID: string) {
    if (pending()) return
    setPending(true)
    setError("")
    try {
      if ((await props.onSelect(scopeID)) !== false) dialog.close()
    } catch (error) {
      setError(requestErrorMessage(error, _(copy.failed)))
    } finally {
      setPending(false)
    }
  }
  async function open() {
    const result = await picker.pickProjectDirectories({ title: _(copy.open), multiple: false })
    if (!result || disposed || client !== sdk.client) return
    setPending(true)
    setError("")
    try {
      const id = await layout.scopes.open(result.directoryPaths[0])
      if (!disposed && client === sdk.client && id && (await props.onSelect(id)) !== false) dialog.close()
    } catch (error) {
      setError(requestErrorMessage(error, _(copy.failed)))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog
      title={_(copy.choose)}
      description={_(copy.description)}
      footer={
        <div data-slot="dialog-actions">
          <Button variant="secondary" disabled={pending()} onClick={() => void open()}>
            <Icon name={getSemanticIcon("workspace.add")} size="small" />
            {_(copy.open)}
          </Button>
        </div>
      }
      size="form"
      dismissible={!pending()}
      action={
        <IconButton
          icon={getSemanticIcon("action.close")}
          aria-label={_(copy.cancel)}
          disabled={pending()}
          onClick={() => dialog.close()}
        />
      }
    >
      <div data-slot="dialog-form" class="project-flow">
        <TextField
          autofocus
          aria-label={_(copy.search)}
          placeholder={_(copy.search)}
          value={query()}
          onChange={setQuery}
        />
        <div class="project-flow-list" role="list" aria-label={_(copy.choose)}>
          <button type="button" class="project-flow-row" disabled={pending()} onClick={() => void choose("home")}>
            <Icon name={getSemanticIcon("navigation.home")} size="small" />
            <span class="project-flow-row-copy">
              <strong>{_(copy.none)}</strong>
              <small>{_(copy.noneDescription)}</small>
            </span>
            <span class="project-flow-check">
              <Show when={props.selected === "home"}>
                <Icon name={getSemanticIcon("state.success")} size="small" />
              </Show>
            </span>
          </button>
          <For each={projects()}>
            {(project) => (
              <button
                type="button"
                class="project-flow-row"
                disabled={pending()}
                onClick={() => void choose(project.id)}
              >
                <Icon name={getSemanticIcon("workspace.main")} size="small" />
                <span class="project-flow-row-copy">
                  <strong>{getScopeLabel(project)}</strong>
                  <small>{project.local?.worktree}</small>
                </span>
                <span class="project-flow-check">
                  <Show when={props.selected === project.id}>
                    <Icon name={getSemanticIcon("state.success")} size="small" />
                  </Show>
                </span>
              </button>
            )}
          </For>
          <Show when={!projects().length}>
            <p role="status">{_(copy.empty)}</p>
          </Show>
        </div>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </div>
    </Dialog>
  )
}
