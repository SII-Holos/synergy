import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { useLingui } from "@lingui/solid"
import { dialog } from "@/locales/messages"
import { useProjectFiles } from "@/context/file"

export function DialogSelectFile(props: { onSelect?: (path: string) => void }) {
  const files = useProjectFiles()
  const dialogContext = useDialog()
  const { _ } = useLingui()
  return (
    <Dialog title={_(dialog.selectFile)} size="list">
      <List
        search={{ placeholder: _(dialog.searchFiles), autofocus: true }}
        emptyMessage={_(dialog.noFilesFound)}
        items={(query) =>
          files
            .search(query)
            .then((items) =>
              items.map((item) =>
                item.workspace.path ? `${item.workspace.path.replace(/\/$/, "")}/${item.path}` : item.path,
              ),
            )
        }
        key={(x) => x}
        onSelect={(path) => {
          if (path) {
            props.onSelect?.(path)
          }
          dialogContext.close()
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
