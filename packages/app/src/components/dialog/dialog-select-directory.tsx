import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"

export interface DialogSelectDirectoryResult {
  directory: string | string[]
  initGit: boolean
}

interface DialogSelectDirectoryProps {
  title?: string
  multiple?: boolean
  showInitGit?: boolean
  onSelect: (result: DialogSelectDirectoryResult | null) => void
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const dialog = useDialog()

  const [initGit, setInitGit] = createSignal(false)
  const [filter, setFilter] = createSignal("")

  const home = createMemo(() => sync.data.path.home)

  function display(abs: string) {
    const h = home()
    if (!h) return abs
    if (abs === h) return "~"
    if (abs.startsWith(h + "/") || abs.startsWith(h + "\\")) {
      return "~" + abs.slice(h.length)
    }
    return abs
  }

  function resolveInput(input: string): { path: string; query: string } {
    const trimmed = input.trim()
    if (!trimmed) return { path: home() || "/", query: "" }

    let expanded = trimmed
    if (expanded.startsWith("~/")) {
      expanded = (home() || "") + expanded.slice(1)
    } else if (expanded === "~") {
      expanded = home() || "/"
    }

    if (expanded.startsWith("/")) {
      const lastSlash = expanded.lastIndexOf("/")
      const parentDir = expanded.slice(0, lastSlash) || "/"
      const basename = expanded.slice(lastSlash + 1)
      return { path: parentDir, query: basename }
    }

    return { path: home() || "/", query: expanded }
  }

  const [results] = createResource(
    () => filter(),
    async (f) => {
      const { path, query } = resolveInput(f)
      const data = await sdk.client.find
        .browse({ path, query, limit: 50 })
        .then((x) => x.data ?? [])
        .catch(() => [])
      return data
    },
    { initialValue: [] },
  )

  function resolve(abs: string) {
    props.onSelect({
      directory: props.multiple ? [abs] : abs,
      initGit: initGit(),
    })
    dialog.close()
  }

  return (
    <Dialog title={props.title ?? "Open project"}>
      <div class="flex flex-col flex-1 min-h-0">
        <div class="px-3 py-2 text-12-regular text-text-weak border-b border-border-weak-base/40">
          Browsing server directory
        </div>
        <div class="flex items-center gap-2 px-3 py-2 border-b border-border-weak-base/40">
          <Icon name="search" class="text-icon-dim-base shrink-0" />
          <TextField
            autofocus
            variant="ghost"
            type="text"
            value={filter()}
            onChange={setFilter}
            placeholder="Search folders (e.g. ~/projects, /opt/data)"
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            class="flex-1"
          />
          <Show when={filter()}>
            <IconButton icon="circle-x" variant="ghost" onClick={() => setFilter("")} />
          </Show>
          <Show when={props.showInitGit}>
            <div class="border-l border-border-weak-base/40 pl-2 ml-1">
              <Tooltip value="Initialize git repository if not present">
                <div class="flex items-center gap-2">
                  <Icon name="git-branch" class={initGit() ? "text-icon-success-base" : "text-icon-dim-base"} />
                  <Switch checked={initGit()} onChange={setInitGit} />
                </div>
              </Tooltip>
            </div>
          </Show>
        </div>
        <List
          class="flex-1 min-h-0"
          emptyMessage={results.loading ? "Searching..." : "No folders found"}
          items={results() ?? []}
          key={(x) => x}
          onSelect={(path) => {
            if (!path) return
            resolve(path)
          }}
        >
          {(abs) => {
            const path = display(abs)
            return (
              <div class="w-full flex items-center justify-between rounded-md">
                <div class="flex items-center gap-x-3 grow min-w-0">
                  <FileIcon node={{ path: abs, type: "directory" }} class="shrink-0 size-4 text-icon-weak-base" />
                  <div class="flex items-center text-14-regular min-w-0">
                    <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                      {getDirectory(path)}
                    </span>
                    <span class="text-text-strong whitespace-nowrap">{getFilename(path)}</span>
                  </div>
                </div>
              </div>
            )
          }}
        </List>
      </div>
    </Dialog>
  )
}
