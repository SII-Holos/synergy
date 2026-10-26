import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { WorkspaceFileNode } from "@ericsanchezok/synergy-sdk"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useViewActivity } from "@ericsanchezok/synergy-ui/context/view-activity"
import { useFile, useProjectFiles } from "@/context/file"
import { fileWorkspaceLabel } from "@/context/file/workspace"
import { fileWriteErrorMessage } from "@/context/file/errors"
import { fileEntries as M } from "@/locales/messages"
import { resourceMenuKeyDown } from "../workspace/resource-menu"
import { FileDeleteDialog } from "./entry-dialog"
import "./entry-actions.css"

type EntryEdit = {
  kind: "createFile" | "createDirectory" | "rename"
  parent: string
  source?: WorkspaceFileNode
}

const parentPath = (path: string) => path.split("/").slice(0, -1).join("/")
const childPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

/**
 * Explorer interaction reference: https://code.visualstudio.com/docs/editing/getting-started/userinterface#_explorer
 * Inline naming and clipboard gestures retain this product's captured Workspace and entry-version checks.
 */
export function createFileEntryActions(props: {
  selected: () => WorkspaceFileNode | undefined
  prepare: () => void
  focusTree: () => void
  onOpenResource?: () => void
}) {
  const file = useFile()
  const project = useProjectFiles()
  const dialog = useDialog()
  const active = useViewActivity()
  const { _ } = useLingui()
  const [edit, setEdit] = createSignal<EntryEdit>()
  const [name, setName] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [menu, setMenu] = createSignal<{
    node?: WorkspaceFileNode
    rect: { x: number; y: number; width: number; height: number }
  }>()
  let controller: AbortController | undefined
  let disposed = false
  const directory = (node: WorkspaceFileNode | null | undefined) =>
    node?.type === "directory" && !node.symlink ? node.path : parentPath(node?.path ?? "")
  const available = () => !disposed && active() && !pending() && !!file.workspace
  const clipboard = () => project.clipboard.get()
  const canPaste = () => {
    const source = clipboard()
    return available() && !!source?.node.entryVersion && source.resourceKey === file.resourceKey
  }
  const closeMenu = () => setMenu(undefined)

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (!available()) return false
    const request = new AbortController()
    controller = request
    setPending(true)
    setError(undefined)
    try {
      await operation(request.signal)
      return !disposed && active() && !request.signal.aborted
    } catch (cause) {
      if (!disposed && active() && !request.signal.aborted)
        setError(fileWriteErrorMessage(cause) ?? (cause instanceof Error ? cause.message : _(M.failed)))
      return false
    } finally {
      if (!disposed) setPending(false)
      if (controller === request) controller = undefined
    }
  }

  const cancel = () => {
    if (pending()) return
    setEdit(undefined)
    setError(undefined)
    props.focusTree()
  }
  const begin = (kind: EntryEdit["kind"], input: WorkspaceFileNode | null | undefined = props.selected()) => {
    if (!available()) return
    if (kind === "rename" && !input?.entryVersion) {
      setError(_(M.refreshRequired))
      return
    }
    closeMenu()
    props.prepare()
    setError(undefined)
    const parent = kind === "rename" ? parentPath(input!.path) : directory(input)
    setName(kind === "rename" ? input!.name : "")
    setEdit({ kind, parent, source: input ? { ...input } : undefined })
    if (parent) file.explorer.setExpanded(parent, true)
    void file.explorer.reveal(childPath(parent, "__reveal__"))
  }
  async function submit() {
    const entry = edit()
    if (!entry || !available()) return
    const value = name().trim()
    if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
      setError(_(M.invalidName))
      return
    }
    const destination = childPath(entry.parent, value)
    if (entry.kind === "rename" && destination === entry.source?.path) {
      cancel()
      return
    }
    if (file.explorer.node(destination)) {
      setError(_(M.alreadyExists))
      return
    }
    const complete = await run(async (signal) => {
      if (entry.kind === "createDirectory") await file.entries.createDirectory(destination, signal)
      else if (entry.kind === "createFile") await file.entries.createFile(destination, signal)
      else
        await file.entries.move(
          { from: entry.source!.path, to: destination, expectedVersion: entry.source!.entryVersion! },
          signal,
        )
      await file.explorer.loadChildren(entry.parent, { reset: true, force: true })
      if (entry.kind === "createFile") {
        await file.load(destination, { force: true })
        if (disposed || !active() || signal.aborted) return
        file.view.setMode(destination, "source")
        file.draft.begin(destination)
        setEdit(undefined)
        if (await file.openWorkspaceFile(destination)) props.onOpenResource?.()
      }
    })
    if (!complete || edit() !== entry) return
    setEdit(undefined)
    props.focusTree()
  }
  const capture = (operation: "move" | "copy", input = props.selected()) => {
    if (!available() || !input?.entryVersion || !file.workspace) return
    project.clipboard.set({
      resourceKey: file.resourceKey,
      workspace: { ...file.workspace },
      node: { ...input },
      operation,
    })
    closeMenu()
    setError(undefined)
    props.focusTree()
  }
  async function paste(input: WorkspaceFileNode | null | undefined = props.selected()) {
    if (!canPaste()) return
    const source = clipboard()!
    const parent = directory(input)
    let destination = childPath(parent, source.node.name)
    closeMenu()
    if (source.operation === "move" && destination === source.node.path) {
      if (clipboard() === source) project.clipboard.set(undefined)
      return
    }
    if (source.operation === "copy" && (file.explorer.directory(parent)?.items ?? []).includes(destination)) {
      const dot = source.node.type === "file" ? source.node.name.lastIndexOf(".") : -1
      const stem = dot > 0 ? source.node.name.slice(0, dot) : source.node.name
      const extension = dot > 0 ? source.node.name.slice(dot) : ""
      const existing = new Set(file.explorer.directory(parent)?.items ?? [])
      let number = 1
      do {
        const message = number === 1 ? M.copyName : M.copyNameNumbered
        const name = _({ ...message, values: { name: stem, number } })
        destination = childPath(parent, name + extension)
        number++
      } while (existing.has(destination))
    }
    if (destination.startsWith(source.node.path + "/")) {
      setError(_(M.invalidDestination))
      return
    }
    if (parent) file.explorer.setExpanded(parent, true)
    const complete = await run(async (signal) => {
      await file.entries[source.operation](
        { from: source.node.path, to: destination, expectedVersion: source.node.entryVersion! },
        signal,
      )
      if (source.operation === "move" && clipboard() === source) project.clipboard.set(undefined)
      if (!disposed && active()) await file.explorer.loadChildren(parent, { reset: true, force: true })
    })
    if (!complete) return
    props.focusTree()
  }
  const remove = (input = props.selected()) => {
    if (!available() || !input?.entryVersion || !file.workspace) return
    const source = { ...input }
    closeMenu()
    dialog.show(() => (
      <FileDeleteDialog
        actions={file.entries}
        workspacePath={fileWorkspaceLabel(file.workspace!)}
        node={source}
        dirty={file.draft.within(source.path)}
      />
    ))
  }
  const openMenu = (
    node: WorkspaceFileNode | undefined,
    rect: { x: number; y: number; width: number; height: number },
  ) => {
    if (!available()) return
    setError(undefined)
    setMenu({ node: node ? { ...node } : undefined, rect })
  }
  async function copyPath(input: WorkspaceFileNode) {
    closeMenu()
    const result = await copyTextToClipboard(input.path, { notifyFailure: false })
    if (!result.ok && !disposed && active()) setError(_(M.copyPathFailed))
  }
  createEffect(() => {
    if (active()) return
    closeMenu()
    controller?.abort()
    setEdit(undefined)
    setError(undefined)
  })
  onCleanup(() => {
    // A move can remount this panel before its response; the FileProvider owns write disposal.
    disposed = true
  })
  return {
    edit,
    name,
    setName,
    pending,
    error,
    menu,
    closeMenu,
    openMenu,
    available,
    canPaste,
    begin,
    cancel,
    submit,
    capture,
    paste,
    remove,
    copyPath,
  }
}

export type FileEntryActions = ReturnType<typeof createFileEntryActions>

export function FileEntryName(props: { actions: FileEntryActions }) {
  const { _ } = useLingui()
  const entry = props.actions.edit()!
  let input!: HTMLInputElement
  onMount(() => {
    queueMicrotask(() => {
      if (!input.isConnected || props.actions.edit() !== entry) return
      input.focus({ preventScroll: true })
      const extension = props.actions.name().lastIndexOf(".")
      input.setSelectionRange(0, extension > 0 ? extension : props.actions.name().length)
    })
  })
  return (
    <form
      class="file-entry-form"
      aria-busy={props.actions.pending()}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault()
        void props.actions.submit()
      }}
    >
      <input
        ref={input}
        aria-label={_(M.name)}
        aria-invalid={!!props.actions.error()}
        value={props.actions.name()}
        disabled={props.actions.pending()}
        onInput={(event) => props.actions.setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key !== "Escape") return
          event.preventDefault()
          props.actions.cancel()
        }}
      />
    </form>
  )
}

export function FileEntryMenu(props: { actions: FileEntryActions; focusTree: () => void }) {
  const { _ } = useLingui()
  let body: HTMLDivElement | undefined
  const target = () => props.actions.menu()?.node ?? null
  return (
    <Popover
      open={!!props.actions.menu()}
      onOpenChange={(open) => {
        if (!open) props.actions.closeMenu()
      }}
      getAnchorRect={() => props.actions.menu()?.rect}
      placement="bottom-start"
      variant="menu"
      class="file-entry-popover"
      trigger={<span hidden />}
      contentProps={{
        role: "menu",
        "aria-label": _(M.title),
        onCloseAutoFocus: (event: Event) => {
          event.preventDefault()
          if (document.activeElement === document.body || body?.contains(document.activeElement)) props.focusTree()
        },
        onOpenAutoFocus: (event: Event) => {
          event.preventDefault()
          body?.querySelector<HTMLElement>("button:not(:disabled)")?.focus()
        },
      }}
    >
      <div ref={body} class="file-entry-menu" onKeyDown={resourceMenuKeyDown}>
        <button role="menuitem" type="button" onClick={() => props.actions.begin("createFile", target())}>
          {_(M.createFile)}
        </button>
        <button role="menuitem" type="button" onClick={() => props.actions.begin("createDirectory", target())}>
          {_(M.createDirectory)}
        </button>
        <Show when={target()}>
          {(node) => (
            <>
              <hr />
              <button
                role="menuitem"
                type="button"
                disabled={!node().entryVersion}
                onClick={() => props.actions.begin("rename", node())}
              >
                <Icon name={getSemanticIcon("action.rename")} size="small" />
                {_(M.rename)}
              </button>
              <button
                role="menuitem"
                type="button"
                disabled={!node().entryVersion}
                onClick={() => props.actions.capture("move", node())}
              >
                {_(M.cut)}
              </button>
              <button
                role="menuitem"
                type="button"
                disabled={!node().entryVersion}
                onClick={() => props.actions.capture("copy", node())}
              >
                <Icon name={getSemanticIcon("action.copy")} size="small" />
                {_(M.copy)}
              </button>
            </>
          )}
        </Show>
        <button
          role="menuitem"
          type="button"
          disabled={!props.actions.canPaste()}
          onClick={() => void props.actions.paste(target())}
        >
          {_(M.paste)}
        </button>
        <Show when={target()}>
          {(node) => (
            <>
              <button role="menuitem" type="button" onClick={() => void props.actions.copyPath(node())}>
                {_(M.copyPath)}
              </button>
              <hr />
              <button
                role="menuitem"
                type="button"
                disabled={!node().entryVersion}
                onClick={() => props.actions.remove(node())}
              >
                <Icon name={getSemanticIcon("action.remove")} size="small" />
                {_(M.remove)}
              </button>
            </>
          )}
        </Show>
      </div>
    </Popover>
  )
}
