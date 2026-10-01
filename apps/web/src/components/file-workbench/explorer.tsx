import { fileWorkspaceLabel, type FileWorkspace } from "@/context/file/workspace"
import { useLingui } from "@lingui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { VList, type VListHandle } from "virtua/solid"
import { useFile, useProjectFiles, FileWorkspaceProvider } from "@/context/file"
import { fileExplorer as X, fileEntries as A } from "@/locales/messages"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { FileEntryDialog, type FileEntryOperation } from "./entry-dialog"

type TreeNodeRow = { kind: "node"; path: string; level: number; parent: string }
type TreeStateRow = { kind: "loading" | "error" | "more"; path: string; level: number }
type TreeRow = TreeNodeRow | TreeStateRow

function gitStatus(status: string | undefined) {
  if (status === "modified") return "M"
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  if (status === "renamed") return "R"
  if (status === "untracked") return "U"
  return undefined
}

export function FileExplorer(props: { onClose: () => void; onOpenResource?: () => void }) {
  const project = useProjectFiles()
  const file = useFile()
  const [chosen, setChosen] = createSignal<string>()
  const root = createMemo(
    () =>
      project.roots().find((item) => item.id === chosen()) ??
      project.roots().find((item) => item.id === file.workspace?.id) ??
      project.roots()[0],
  )
  return (
    <Show
      when={root()}
      keyed
      fallback={<SingleFileExplorer onClose={props.onClose} onOpenResource={props.onOpenResource} />}
    >
      {(workspace) => (
        <FileWorkspaceProvider workspace={workspace}>
          <SingleFileExplorer
            onClose={props.onClose}
            onOpenResource={props.onOpenResource}
            folders={project.roots()}
            onFolderChange={setChosen}
          />
        </FileWorkspaceProvider>
      )}
    </Show>
  )
}

function SingleFileExplorer(props: {
  onClose: () => void
  onOpenResource?: () => void
  folders?: FileWorkspace[]
  onFolderChange?: (id: string) => void
}) {
  const file = useFile()
  const project = useProjectFiles()
  const lingui = useLingui()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const [searching, setSearching] = createSignal(false)
  const [searchError, setSearchError] = createSignal<string>()
  const [searchResults, setSearchResults] = createSignal<
    Array<{ path: string; name: string; workspace: FileWorkspace }>
  >([])
  const [focusedPath, setFocusedPath] = createSignal<string>()
  let searchController: AbortController | undefined
  let debounce: number | undefined
  let listHandle: VListHandle | undefined
  async function openDocument(path: string, newTab = false) {
    if (await file.openWorkspaceFile(path, { newTab })) props.onOpenResource?.()
  }

  const rows = createMemo(() => {
    const result: TreeRow[] = []
    const append = (parent: string, level: number) => {
      const directory = file.explorer.directory(parent)
      for (const path of directory?.items ?? []) {
        result.push({ kind: "node", path, level, parent })
        const node = file.explorer.node(path)
        if (node?.type === "directory" && file.explorer.isExpanded(path)) append(path, level + 1)
      }
      if (directory?.loading && directory.items.length === 0) result.push({ kind: "loading", path: parent, level })
      if (directory?.error) result.push({ kind: "error", path: parent, level })
      else if (directory?.nextCursor) result.push({ kind: "more", path: parent, level })
    }
    append("", 1)
    return result
  })

  const visibleNodeRows = createMemo(() => rows().filter((row): row is TreeNodeRow => row.kind === "node"))
  const selectedPath = () => file.activePath()
  const activeHidden = createMemo(() => {
    if (file.explorer.showHidden()) return false
    const path = file.activePath()
    if (!path) return false
    const node = file.get(path)?.node ?? file.explorer.node(path)
    return node?.hidden || node?.ignored
  })

  onMount(() => {
    void file.explorer.loadChildren("")
    for (const path of file.explorer.expanded()) void file.explorer.loadChildren(path)
  })

  createEffect(() => {
    const value = query().trim()
    window.clearTimeout(debounce)
    searchController?.abort()
    if (!value) {
      setSearching(false)
      setSearchError(undefined)
      setSearchResults([])
      return
    }
    debounce = window.setTimeout(() => {
      const controller = new AbortController()
      searchController = controller
      setSearching(true)
      setSearchError(undefined)
      void project
        .search(value, controller.signal)
        .then((results) => {
          if (!controller.signal.aborted) setSearchResults(results)
        })
        .catch((error) => {
          if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, 120)
  })

  onCleanup(() => {
    window.clearTimeout(debounce)
    searchController?.abort()
  })

  const focusIndex = (index: number) => {
    const nodes = visibleNodeRows()
    if (nodes.length === 0) return
    const target = Math.max(0, Math.min(nodes.length - 1, index))
    setFocusedPath(nodes[target]!.path)
    const rowIndex = rows().findIndex((row) => row.kind === "node" && row.path === nodes[target]!.path)
    if (rowIndex >= 0) listHandle?.scrollToIndex(rowIndex, { align: "nearest" })
  }

  const openActions = (path = focusedPath() ?? selectedPath(), operation?: FileEntryOperation) => {
    const node = path ? (file.explorer.node(path) ?? file.get(path)?.node) : undefined
    const actions = file.entries
    if (!file.workspace) return
    const workspacePath = fileWorkspaceLabel(file.workspace)
    const dirty = path ? file.draft.within(path) : false
    dialog.show(() => (
      <FileEntryDialog
        actions={actions}
        workspacePath={workspacePath}
        node={node}
        operation={operation}
        dirty={dirty}
      />
    ))
  }

  const handleTreeKey = (event: KeyboardEvent) => {
    const nodes = visibleNodeRows()
    if (nodes.length === 0) return
    const current = Math.max(
      0,
      nodes.findIndex((row) => row.path === focusedPath()),
    )
    const row = nodes[current]!
    const node = file.explorer.node(row.path)
    if (event.key === "ArrowDown") focusIndex(current + 1)
    else if (event.key === "ArrowUp") focusIndex(current - 1)
    else if (event.key === "Home") focusIndex(0)
    else if (event.key === "End") focusIndex(nodes.length - 1)
    else if (event.key === "ArrowRight" && node?.type === "directory") {
      if (!file.explorer.isExpanded(row.path)) file.explorer.setExpanded(row.path, true)
      else focusIndex(current + 1)
    } else if (event.key === "ArrowLeft") {
      if (node?.type === "directory" && file.explorer.isExpanded(row.path)) file.explorer.setExpanded(row.path, false)
      else {
        const parent = row.path.split("/").slice(0, -1).join("/")
        const parentIndex = nodes.findIndex((candidate) => candidate.path === parent)
        if (parentIndex >= 0) focusIndex(parentIndex)
      }
    } else if (event.key === "Enter") {
      if (node?.type === "directory") file.explorer.setExpanded(row.path, !file.explorer.isExpanded(row.path))
      else void openDocument(row.path, event.metaKey || event.ctrlKey)
    } else if (event.key === "F2") openActions(row.path, "move")
    else if (event.key === "Delete") openActions(row.path, "remove")
    else return
    event.preventDefault()
  }

  const loadMoreOnMount = (path: string) => {
    onMount(() => void file.explorer.loadChildren(path))
    return <span>{lingui._({ id: X.loadingMore.id, message: X.loadingMore.message })}</span>
  }

  return (
    <aside
      class="file-explorer"
      aria-label={lingui._({ id: X.label.id, message: X.label.message })}
      style={{ width: `${file.explorer.width()}px` }}
    >
      <ResizeHandle
        direction="horizontal"
        edge="start"
        aria-label={lingui._({ id: X.resize.id, message: X.resize.message })}
        size={file.explorer.width()}
        min={208}
        max={420}
        collapseThreshold={180}
        onResize={file.explorer.setWidth}
        onCollapse={props.onClose}
      />
      <div class="file-explorer-header">
        <span class="file-explorer-title">{lingui._({ id: X.title.id, message: X.title.message })}</span>
        <div class="file-explorer-actions">
          <IconButton
            icon={getSemanticIcon("action.more")}
            variant="ghost"
            aria-label={lingui._(A.title)}
            onClick={() => openActions()}
          />
          <IconButton
            icon={getSemanticIcon(file.explorer.showHidden() ? "action.hide" : "action.view")}
            variant="ghost"
            aria-label={lingui._({ id: X.showHidden.id, message: X.showHidden.message })}
            aria-pressed={file.explorer.showHidden()}
            onClick={() => file.explorer.setShowHidden(!file.explorer.showHidden())}
          />
          <IconButton
            icon={getSemanticIcon("action.refresh")}
            variant="ghost"
            aria-label={lingui._({ id: X.refresh.id, message: X.refresh.message })}
            onClick={file.explorer.refresh}
          />
          <IconButton
            icon={getSemanticIcon("navigation.collapse")}
            variant="ghost"
            aria-label={lingui._({ id: X.collapseAll.id, message: X.collapseAll.message })}
            onClick={file.explorer.collapseAll}
          />
          <IconButton
            icon={getSemanticIcon("action.close")}
            variant="ghost"
            aria-label={lingui._({ id: X.closeTree.id, message: X.closeTree.message })}
            onClick={props.onClose}
          />
        </div>
      </div>
      <Show when={(props.folders?.length ?? 0) > 1}>
        <select
          class="file-explorer-folder"
          aria-label={lingui._({ id: "project.entry.folders", message: "Folders" })}
          value={file.workspace?.id}
          onChange={(event) => props.onFolderChange?.(event.currentTarget.value)}
        >
          <For each={props.folders}>{(folder) => <option value={folder.id}>{fileWorkspaceLabel(folder)}</option>}</For>
        </select>
      </Show>
      <div class="file-explorer-search">
        <Icon name={getSemanticIcon("action.search")} size="small" />
        <input
          class="file-explorer-search-input"
          type="search"
          value={query()}
          placeholder={lingui._({ id: X.searchPlaceholder.id, message: X.searchPlaceholder.message })}
          aria-label={lingui._({ id: X.searchLabel.id, message: X.searchLabel.message })}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return
            if (!query()) return
            event.preventDefault()
            event.stopPropagation()
            setQuery("")
          }}
        />
        <Show when={searching()}>
          <Spinner class="size-3.5" />
        </Show>
      </div>
      <Show when={activeHidden()}>
        <div class="file-explorer-hidden-notice">
          <span>{lingui._({ id: X.hiddenNotice.id, message: X.hiddenNotice.message })}</span>
          <button type="button" onClick={() => file.explorer.setShowHidden(true)}>
            {lingui._({ id: X.showIt.id, message: X.showIt.message })}
          </button>
        </div>
      </Show>
      <div class="file-explorer-list">
        <Show
          when={query().trim()}
          fallback={
            <div
              class="file-tree"
              role="tree"
              aria-label={lingui._({ id: X.workspaceFiles.id, message: X.workspaceFiles.message })}
              tabIndex={0}
              onKeyDown={handleTreeKey}
            >
              <VList
                ref={(handle) => (listHandle = handle)}
                data={rows()}
                itemSize={32}
                overscan={10}
                style={{ height: "100%" }}
              >
                {(row) => (
                  <Show
                    when={row.kind === "node" ? row : undefined}
                    fallback={
                      <div class="file-tree-state" style={{ "padding-left": `${row.level * 14 + 8}px` }}>
                        <Show when={row.kind === "loading"}>
                          <Spinner class="size-3.5" />{" "}
                          <span>{lingui._({ id: X.loading.id, message: X.loading.message })}</span>
                        </Show>
                        <Show when={row.kind === "more"}>{loadMoreOnMount(row.path)}</Show>
                        <Show when={row.kind === "error"}>
                          <button type="button" onClick={() => file.explorer.loadChildren(row.path, { force: true })}>
                            {lingui._({ id: X.retryLoadingFolder.id, message: X.retryLoadingFolder.message })}
                          </button>
                        </Show>
                      </div>
                    }
                  >
                    {(nodeRow) => {
                      const node = () => file.explorer.node(nodeRow().path)
                      const directory = () => node()?.type === "directory"
                      const expanded = () => directory() && file.explorer.isExpanded(nodeRow().path)
                      return (
                        <div
                          class="file-tree-row"
                          classList={{
                            "file-tree-row--selected": selectedPath() === nodeRow().path,
                            "file-tree-row--focused": focusedPath() === nodeRow().path,
                          }}
                          role="treeitem"
                          aria-level={nodeRow().level}
                          aria-expanded={directory() ? expanded() : undefined}
                          aria-selected={selectedPath() === nodeRow().path}
                          data-path={nodeRow().path}
                          style={{ "padding-left": `${(nodeRow().level - 1) * 14 + 6}px` }}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            setFocusedPath(nodeRow().path)
                            openActions(nodeRow().path)
                          }}
                          onMouseDown={() => setFocusedPath(nodeRow().path)}
                          onClick={(event) => {
                            if (directory()) file.explorer.setExpanded(nodeRow().path, !expanded())
                            else void openDocument(nodeRow().path, event.metaKey || event.ctrlKey)
                          }}
                        >
                          <span class="file-tree-disclosure">
                            <Show when={directory()}>
                              <Icon
                                name={getSemanticIcon(expanded() ? "navigation.collapse" : "navigation.expand")}
                                size="small"
                              />
                            </Show>
                          </span>
                          <FileIcon
                            node={{ path: nodeRow().path, type: directory() ? "directory" : "file" }}
                            expanded={expanded()}
                            class="file-tree-icon"
                          />
                          <span class="file-tree-name">{node()?.name ?? nodeRow().path.split("/").at(-1)}</span>
                          <Show when={!directory()}>
                            <IconButton
                              class="file-tree-new-tab"
                              icon={getSemanticIcon("action.open")}
                              variant="ghost"
                              aria-label={lingui._({ id: "workspace.document.newTab", message: "Open in new tab" })}
                              onClick={(event) => {
                                event.stopPropagation()
                                void openDocument(nodeRow().path, true)
                              }}
                            />
                          </Show>
                          <Show when={node()?.symlink}>
                            <span
                              class="file-tree-link"
                              aria-label={lingui._({ id: X.symbolicLink.id, message: X.symbolicLink.message })}
                            >
                              ↗
                            </span>
                          </Show>
                          <Show when={gitStatus(node()?.gitStatus)}>
                            {(status) => <span class="file-tree-git">{status()}</span>}
                          </Show>
                        </div>
                      )
                    }}
                  </Show>
                )}
              </VList>
            </div>
          }
        >
          <div
            class="file-search-results"
            role="listbox"
            aria-label={lingui._({ id: X.searchResults.id, message: X.searchResults.message })}
          >
            <Show when={!searchError()} fallback={<div class="file-explorer-message">{searchError()}</div>}>
              <For
                each={searchResults()}
                fallback={
                  <Show when={!searching()}>
                    <div class="file-explorer-message">
                      {lingui._({ id: X.noMatchingFiles.id, message: X.noMatchingFiles.message })}
                    </div>
                  </Show>
                }
              >
                {(result) => (
                  <button
                    type="button"
                    class="file-search-result"
                    role="option"
                    onClick={(event) =>
                      void project
                        .open(result.workspace, result.path, { newTab: event.metaKey || event.ctrlKey })
                        .then((tab) => {
                          if (tab) props.onOpenResource?.()
                        })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        void project.open(result.workspace, result.path, { newTab: true }).then((tab) => {
                          if (tab) props.onOpenResource?.()
                        })
                      }
                    }}
                  >
                    <FileIcon node={{ path: result.path, type: "file" }} class="file-tree-icon" />
                    <span class="file-search-copy">
                      <span class="file-search-name">{result.name}</span>
                      <span class="file-search-parent">
                        {[fileWorkspaceLabel(result.workspace), result.path.split("/").slice(0, -1).join("/")]
                          .filter(Boolean)
                          .join("/")}
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </aside>
  )
}
