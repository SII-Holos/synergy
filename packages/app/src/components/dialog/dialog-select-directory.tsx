import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import {
  createInitialDirectoryBrowserState,
  directoryBrowserCanSubmit,
  directoryBrowserClearDraft,
  directoryBrowserSetDraft,
  directoryBrowserSubmitError,
  directoryBrowserSubmitStart,
  directoryBrowserSubmitSuccess,
} from "./project-directory-browser-model"
import "./dialog-select-directory.css"

export interface DialogSelectDirectoryResult {
  directory: string | string[]
}

interface DialogSelectDirectoryProps {
  title?: string
  multiple?: boolean
  onSelect: (result: DialogSelectDirectoryResult | null) => void
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const dialog = useDialog()

  const home = createMemo(() => sync.data.paths.home)
  const [state, setState] = createStore(createInitialDirectoryBrowserState(home() ?? "/"))
  const canSubmit = createMemo(() => directoryBrowserCanSubmit(state, home()))
  const stateTitle = createMemo(() => {
    if (state.status === "loading") return "Searching..."
    if (state.status === "empty") return "No matching folders"
    if (state.status === "error") return "Search failed"
    return "Search to choose a folder"
  })
  const stateDescription = createMemo(() => {
    if (state.status === "empty") return "Try a fuller folder path or a different project name."
    if (state.status === "error") return state.error ?? "Check the path and try again."
    return undefined
  })
  const stateIcon = createMemo(() => {
    if (state.status === "error") return "state.error"
    if (state.status === "empty") return "state.empty"
    return "action.search"
  })

  function display(abs: string) {
    const h = home()
    if (!h) return abs
    if (abs === h) return "~"
    if (abs.startsWith(h + "/") || abs.startsWith(h + "\\")) {
      return "~" + abs.slice(h.length)
    }
    return abs
  }

  async function submitSearch(event?: SubmitEvent) {
    event?.preventDefault()
    if (!canSubmit()) return
    const next = directoryBrowserSubmitStart(state, home())
    if (next === state) return
    const requestID = next.requestID
    setState(next)
    try {
      const response: { data?: string[] | null } = await sdk.client.global.filesystem.browse({
        path: next.resolved.path,
        query: next.resolved.query,
        limit: 50,
      })
      const data = response.data ?? []
      const current = { ...state }
      setState(directoryBrowserSubmitSuccess(current, requestID, data))
    } catch (error) {
      const current = { ...state }
      setState(directoryBrowserSubmitError(current, requestID, error))
    }
  }

  function clearDraft() {
    setState(directoryBrowserClearDraft({ ...state }, home() ?? "/"))
  }

  function retry() {
    void submitSearch()
  }

  function resolve(abs: string) {
    props.onSelect({
      directory: props.multiple ? [abs] : abs,
    })
    dialog.close()
  }

  return (
    <Dialog
      class="project-directory-dialog"
      size="list"
      title={
        <div class="project-directory-title">
          <span class="project-directory-title-icon" aria-hidden="true">
            <Icon name={getSemanticIcon("settings.configFiles")} size="small" />
          </span>
          <span>{props.title ?? "Open project"}</span>
        </div>
      }
      description="Choose a folder to show in the sidebar."
    >
      <div class="project-directory-body">
        <form class="project-directory-search-card" onSubmit={submitSearch}>
          <div class="project-directory-search-field">
            <Icon name={getSemanticIcon("action.search")} size="small" class="project-directory-search-icon" />
            <TextField
              autofocus
              variant="ghost"
              type="text"
              label="Project folder"
              hideLabel
              value={state.draft}
              onChange={(value: string) => setState(directoryBrowserSetDraft({ ...state }, value))}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === "Enter") void submitSearch(event as unknown as SubmitEvent)
              }}
              placeholder="Search folders or paste a path"
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="project-directory-input"
            />
          </div>
          <Show when={state.draft || state.status !== "idle"}>
            <IconButton
              type="button"
              icon={getSemanticIcon("action.clear")}
              variant="ghost"
              aria-label="Clear search"
              onClick={clearDraft}
            />
          </Show>
          <Button
            type="submit"
            variant="primary"
            size="normal"
            icon={getSemanticIcon("action.search")}
            disabled={!canSubmit()}
            class="project-directory-search-button"
          >
            Search
          </Button>
        </form>

        <div class="project-directory-results" data-status={state.status}>
          <Show
            when={state.status === "ready"}
            fallback={
              <div class="project-directory-state">
                <div class="project-directory-state-icon" data-status={state.status}>
                  <Show
                    when={state.status === "loading"}
                    fallback={<Icon name={getSemanticIcon(stateIcon())} size="normal" />}
                  >
                    <Spinner class="project-directory-spinner" />
                  </Show>
                </div>
                <div class="project-directory-state-copy">
                  <h3>{stateTitle()}</h3>
                  <Show when={stateDescription()}>
                    <p>{stateDescription()}</p>
                  </Show>
                  <Show when={state.status === "error"}>
                    <Button type="button" variant="secondary" size="small" onClick={retry} disabled={!canSubmit()}>
                      Retry
                    </Button>
                  </Show>
                </div>
              </div>
            }
          >
            <div class="project-directory-result-list" role="listbox" aria-label="Server folders">
              <For each={state.results}>
                {(abs, index) => {
                  const shown = display(abs)
                  return (
                    <button
                      type="button"
                      class="project-directory-row"
                      role="option"
                      aria-label={`Select ${shown}`}
                      title={abs}
                      style={{ "--row-index": index() }}
                      onClick={() => resolve(abs)}
                    >
                      <FileIcon node={{ path: abs, type: "directory" }} class="project-directory-row-icon" />
                      <span class="project-directory-row-path">
                        <span class="project-directory-row-parent">{getDirectory(shown)}</span>
                        <span class="project-directory-row-name">{getFilename(shown)}</span>
                      </span>
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
