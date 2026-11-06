import { fileWorkspaceLabel, type FileWorkspace } from "@/context/file/workspace"
import { useLingui } from "@lingui/solid"
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useViewActivity } from "@ericsanchezok/synergy-ui/context/view-activity"
import { VList, type VListHandle } from "virtua/solid"
import { useFile, useProjectFiles } from "@/context/file"
import { fileExplorer as X, fileEntries as A } from "@/locales/messages"
import { createFileEntryActions, FileEntryMenu, FileEntryName } from "./entry-actions"

type TreeNodeRow = { kind: "node"; path: string; level: number; parent: string }
type TreeStateRow = { kind: "loading" | "error" | "more" | "entry"; path: string; level: number }
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
  const file = useFile()
  const project = useProjectFiles()
  const lingui = useLingui()
  const active = useViewActivity()
  const [query, setQuery] = createSignal("")
  const [searching, setSearching] = createSignal(false)
  const [searchError, setSearchError] = createSignal<string>()
  const [searchResults, setSearchResults] = createSignal<
    Array<{ path: string; name: string; workspace: FileWorkspace }>
  >([])
  const [focusedPath, setFocusedPath] = createSignal<string>()
  let expansionController = new AbortController()
  const canCollapseAll = () => file.explorer.expandingAll() || file.explorer.expanded().length > 0
  let searchController: AbortController | undefined
  let debounce: number | undefined
  let listHandle: VListHandle | undefined
  let treeElement: HTMLDivElement | undefined
  const treeID = createUniqueId()
  const focusTree = (path?: string) => {
    if (!active() || !treeElement?.isConnected) return
    if (path) {
      setFocusedPath(path)
      const index = rows().findIndex((row) => row.kind === "node" && row.path === path)
      if (index >= 0) listHandle?.scrollToIndex(index, { align: "nearest" })
    }
    treeElement.focus({ preventScroll: true })
  }
  const entryActions = createFileEntryActions({
    selected: () => {
      const path = focusedPath() ?? file.activePath()
      return path ? (file.explorer.node(path) ?? file.get(path)?.node) : undefined
    },
    prepare: () => setQuery(""),
    focusTree,
    onOpenResource: props.onOpenResource,
  })
  async function openDocument(path: string, newTab = false) {
    if (await file.openWorkspaceFile(path, { newTab })) props.onOpenResource?.()
  }

  const rows = createMemo(() => {
    const result: TreeRow[] = []
    const append = (parent: string, level: number) => {
      const directory = file.explorer.directory(parent)
      const entry = entryActions.edit()
      if (entry && entry.kind !== "rename" && entry.parent === parent)
        result.push({ kind: "entry", path: parent, level })
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
  const selectedPath = () => focusedPath() ?? file.activePath()
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
    if (active()) return
    expansionController.abort()
    expansionController = new AbortController()
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
    expansionController.abort()
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

  createEffect(() => {
    const entry = entryActions.edit()
    if (!entry || !active()) return
    const index = rows().findIndex((row) =>
      entry.kind === "rename"
        ? row.kind === "node" && row.path === entry.source?.path
        : row.kind === "entry" && row.path === entry.parent,
    )
    if (index < 0) return
    queueMicrotask(() => {
      if (active() && entryActions.edit() === entry) listHandle?.scrollToIndex(index, { align: "nearest" })
    })
  })

  const handleTreeKey = (event: KeyboardEvent) => {
    if (
      !active() ||
      event.defaultPrevented ||
      (event.target as HTMLElement).closest("button, a, input, textarea, [contenteditable='true']")
    )
      return
    const key = event.key.toLowerCase()
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      (key === "x" || key === "c" || key === "v")
    ) {
      if (key === "x") entryActions.capture("move")
      else if (key === "c") entryActions.capture("copy")
      else void entryActions.paste()
      event.preventDefault()
      return
    }
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
    } else if (event.key === "F2") entryActions.begin("rename", node)
    else if (event.key === "Delete") entryActions.remove(node)
    else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const rect = treeElement
        ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.path)}"]`)
        ?.getBoundingClientRect()
      if (rect) entryActions.openMenu(node, { x: rect.x, y: rect.bottom, width: rect.width, height: 0 })
    } else return
    event.preventDefault()
  }

  const loadMoreOnMount = (path: string) => {
    onMount(() => void file.explorer.loadChildren(path))
    return <span>{lingui._({ id: X.loadingMore.id, message: X.loadingMore.message })}</span>
  }

  return (
    <aside class="file-explorer" aria-label={lingui._({ id: X.label.id, message: X.label.message })}>
      <div class="file-explorer-header">
        <span class="file-explorer-title">{lingui._({ id: X.title.id, message: X.title.message })}</span>
        <div class="file-explorer-actions">
          <For each={["createFile", "createDirectory"] as const}>
            {(kind) => (
              <button
                type="button"
                class="file-entry-create"
                aria-label={lingui._(kind === "createFile" ? A.createFile : A.createDirectory)}
                disabled={!entryActions.available()}
                onClick={() => entryActions.begin(kind)}
              >
                <FileIcon
                  node={{
                    path: kind === "createFile" ? "file" : "folder",
                    type: kind === "createFile" ? "file" : "directory",
                  }}
                  class="size-4"
                />
                <span class="file-entry-create-mark">
                  <Icon name={getSemanticIcon("action.add")} size="small" />
                </span>
              </button>
            )}
          </For>
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
            icon={getSemanticIcon(canCollapseAll() ? "review.fold" : "review.unfold")}
            variant="ghost"
            aria-label={lingui._(canCollapseAll() ? X.collapseAll : X.expandAll)}
            aria-busy={file.explorer.expandingAll()}
            onClick={() => {
              if (canCollapseAll()) file.explorer.collapseAll()
              else void file.explorer.expandAll(expansionController.signal)
            }}
          />
          <IconButton
            icon={getSemanticIcon("action.close")}
            variant="ghost"
            aria-label={lingui._({ id: X.closeTree.id, message: X.closeTree.message })}
            onClick={props.onClose}
          />
        </div>
      </div>
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
      <Show when={entryActions.error()}>
        {(message) => (
          <div class="file-entry-error" role="alert">
            {message()}
          </div>
        )}
      </Show>
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
              ref={treeElement}
              class="file-tree"
              role="tree"
              aria-activedescendant={focusedPath() ? `${treeID}-${encodeURIComponent(focusedPath()!)}` : undefined}
              aria-label={lingui._({ id: X.workspaceFiles.id, message: X.workspaceFiles.message })}
              tabIndex={0}
              onKeyDown={handleTreeKey}
              onContextMenu={(event) => {
                if (event.defaultPrevented || (event.target as HTMLElement).closest("input")) return
                event.preventDefault()
                setFocusedPath(undefined)
                entryActions.openMenu(undefined, { x: event.clientX, y: event.clientY, width: 0, height: 0 })
              }}
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
                        <Show when={row.kind === "entry"}>
                          <FileIcon
                            node={{
                              path: "file",
                              type: entryActions.edit()?.kind === "createDirectory" ? "directory" : "file",
                            }}
                            class="file-tree-icon"
                          />
                          <FileEntryName actions={entryActions} />
                        </Show>
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
                            "file-tree-row--cut":
                              project.clipboard.get()?.resourceKey === file.resourceKey &&
                              project.clipboard.get()?.operation === "move" &&
                              project.clipboard.get()?.node.path === nodeRow().path,
                          }}
                          role="treeitem"
                          id={`${treeID}-${encodeURIComponent(nodeRow().path)}`}
                          aria-level={nodeRow().level}
                          aria-expanded={directory() ? expanded() : undefined}
                          aria-selected={selectedPath() === nodeRow().path}
                          data-path={nodeRow().path}
                          style={{ "padding-left": `${(nodeRow().level - 1) * 14 + 6}px` }}
                          onContextMenu={(event) => {
                            if ((event.target as HTMLElement).closest("input")) return
                            event.preventDefault()
                            setFocusedPath(nodeRow().path)
                            entryActions.openMenu(node(), { x: event.clientX, y: event.clientY, width: 0, height: 0 })
                          }}
                          onMouseDown={() => setFocusedPath(nodeRow().path)}
                          onFocus={() => setFocusedPath(nodeRow().path)}
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
                          <Show
                            when={
                              entryActions.edit()?.kind === "rename" &&
                              entryActions.edit()?.source?.path === nodeRow().path
                            }
                            fallback={
                              <span class="file-tree-name">{node()?.name ?? nodeRow().path.split("/").at(-1)}</span>
                            }
                          >
                            <FileEntryName actions={entryActions} />
                          </Show>
                          <IconButton
                            class="file-tree-entry-menu"
                            icon={getSemanticIcon("action.more")}
                            variant="ghost"
                            aria-label={lingui._(A.title)}
                            aria-haspopup="menu"
                            aria-expanded={entryActions.menu()?.node?.path === nodeRow().path}
                            onClick={(event) => {
                              event.stopPropagation()
                              setFocusedPath(nodeRow().path)
                              const rect = event.currentTarget.getBoundingClientRect()
                              entryActions.openMenu(node(), {
                                x: rect.left,
                                y: rect.bottom,
                                width: rect.width,
                                height: 0,
                              })
                            }}
                          />
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
      <FileEntryMenu actions={entryActions} focusTree={focusTree} />
    </aside>
  )
}
