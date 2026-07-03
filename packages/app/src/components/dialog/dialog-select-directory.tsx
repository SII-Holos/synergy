import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getDirectory, getFilename, resolvePathInput } from "@ericsanchezok/synergy-util/path"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"

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

  const [filter, setFilter] = createSignal("")

  const home = createMemo(() => sync.data.paths.home)

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
    return resolvePathInput(input, home() ?? "/")
  }

  const [results] = createResource(
    () => filter(),
    async (f) => {
      const { path, query } = resolveInput(f)
      const data = await sdk.client.global.filesystem
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
    })
    dialog.close()
  }

  return (
    <Dialog title={props.title ?? "Open project"} size="list">
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
        </div>
        <List
          class="flex-1 min-h-0"
          emptyMessage={results.loading ? "Searching..." : "No folders found"}
          items={results() ?? []}
          key={(x) => x}
          filter={resolveInput(filter()).query}
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
