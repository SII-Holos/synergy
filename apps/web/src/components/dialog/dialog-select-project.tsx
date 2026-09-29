import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { getScopeLabel } from "@/utils/scope"
import { requestErrorMessage } from "@/utils/error"
import { projectFlowCopy as copy } from "./project-flow-copy"
import { projectEntryCopy as entry } from "./project-entry-copy"
import "./project-flow.css"

export function ProjectMenuContent(props: {
  selected?: string
  onSelect: (scopeID: string) => Promise<void | boolean> | void | boolean
  onCreate: () => void
  onClose: () => void
  onSettings?: () => void
}) {
  const { _ } = useLingui()
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const [locations] = createResource(
    () => sync.data.scope.map((scope) => scope.id),
    async (ids) =>
      Object.fromEntries(
        await Promise.all(
          ids.map(async (scopeID) => {
            const value = await sdk.client.project.directories({ scopeID }).then((result) => result.data)
            return [
              scopeID,
              value?.folders.find((folder) => folder.workspaceID === value.mainWorkspaceID)?.path,
            ] as const
          }),
        ),
      ),
  )
  const location = (project: (typeof sync.data.scope)[number]) =>
    locations()?.[project.id] ?? project.local?.worktree ?? ""
  const [query, setQuery] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const projects = createMemo(() =>
    sync.data.scope
      .filter(
        (scope) =>
          scope.type === "project" &&
          !scope.time.archived &&
          `${getScopeLabel(scope)} ${location(scope)}`.toLocaleLowerCase().includes(query().toLocaleLowerCase()),
      )
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )
  async function choose(scopeID: string) {
    if (pending()) return
    setPending(true)
    setError("")
    try {
      if ((await props.onSelect(scopeID)) !== false) props.onClose()
    } catch (failure) {
      setError(requestErrorMessage(failure, _(copy.failed)))
    } finally {
      setPending(false)
    }
  }
  function navigate(event: KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    if (event.target instanceof HTMLInputElement && !event.key.startsWith("Arrow")) return
    const container = event.currentTarget as HTMLElement
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }
  return (
    <div class="project-menu-content" onKeyDown={navigate}>
      <div class="project-menu-search">
        <Icon name={getSemanticIcon("action.search")} size="small" />
        <TextField
          autofocus
          variant="ghost"
          aria-label={_(copy.search)}
          placeholder={_(copy.search)}
          value={query()}
          onChange={setQuery}
        />
      </div>
      <div class="project-flow-list" aria-label={_(copy.choose)}>
        <For each={projects()}>
          {(project) => (
            <Tooltip value={location(project)} placement="top">
              <button
                type="button"
                class="project-flow-row"
                disabled={pending()}
                aria-pressed={props.selected === project.id}
                onClick={() => void choose(project.id)}
              >
                <Icon name={getSemanticIcon("project.main")} size="small" />
                <span class="project-flow-row-copy">
                  <strong>{getScopeLabel(project)}</strong>
                  <small class="project-short-path">
                    {location(project).replaceAll("\\", "/").split("/").filter(Boolean).slice(-3).join("/")}
                  </small>
                </span>
                <span class="project-flow-check">
                  <Show when={props.selected === project.id}>
                    <Icon name={getSemanticIcon("state.success")} size="small" />
                  </Show>
                </span>
              </button>
            </Tooltip>
          )}
        </For>
        <Show when={!projects().length}>
          <p class="project-menu-empty" role="status">
            {_(copy.empty)}
          </p>
        </Show>
      </div>
      <button
        type="button"
        class="project-flow-row"
        disabled={pending()}
        aria-pressed={props.selected === "home"}
        onClick={() => void choose("home")}
      >
        <Icon name={getSemanticIcon("navigation.home")} size="small" />
        <span class="project-flow-row-copy">{_(copy.none)}</span>
        <span class="project-flow-check">
          <Show when={props.selected === "home"}>
            <Icon name={getSemanticIcon("state.success")} size="small" />
          </Show>
        </span>
      </button>
      <div class="project-menu-footer">
        <button type="button" class="project-flow-row" disabled={pending()} onClick={props.onCreate}>
          <Icon name={getSemanticIcon("workspace.add")} size="small" />
          {_(entry.create)}
        </button>
        <Show when={props.onSettings}>
          <button type="button" class="project-flow-row" onClick={props.onSettings}>
            {_(entry.settings)}
          </button>
        </Show>
      </div>
      <Show when={error()}>
        <p class="project-inline-error" role="alert">
          {error()}
        </p>
      </Show>
    </div>
  )
}

export function DialogSelectProject(props: Omit<Parameters<typeof ProjectMenuContent>[0], "onClose">) {
  const { _ } = useLingui()
  const dialog = useDialog()
  return (
    <Dialog title={_(copy.choose)} size="compact" class="project-select-dialog">
      <ProjectMenuContent {...props} onClose={() => dialog.close()} />
    </Dialog>
  )
}
