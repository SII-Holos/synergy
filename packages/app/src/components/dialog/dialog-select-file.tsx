import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { useFile } from "@/context/file"

export function DialogSelectFile(props: { onSelect?: (path: string) => void }) {
  const file = useFile()
  const dialog = useDialog()
  return (
    <Dialog title="Select file" size="list">
      <List
        search={{ placeholder: "Search files", autofocus: true }}
        emptyMessage="No files found"
        items={(query) =>
          file
            .searchFiles(query)
            .then((response) =>
              (response?.items ?? [])
                .filter((item) => item.kind === "file" && item.type === "file")
                .map((item) => item.path),
            )
        }
        key={(x) => x}
        onSelect={(path) => {
          if (path) {
            props.onSelect?.(path)
          }
          dialog.close()
        }}
      >
        {(i) => (
          <div class="w-full flex items-center justify-between rounded-md">
            <div class="flex items-center gap-x-3 grow min-w-0">
              <FileIcon node={{ path: i, type: "file" }} class="shrink-0 size-4" />
              <div class="flex items-center text-14-regular">
                <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                  {getDirectory(i)}
                </span>
                <span class="text-text-strong whitespace-nowrap">{getFilename(i)}</span>
              </div>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}
