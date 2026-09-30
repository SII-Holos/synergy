import { createSignal, For, Show, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { projectEntryCopy as copy } from "./project-entry-copy"

export function ProjectFolderFields(props: {
  folders: string[]
  main: string
  disabled?: boolean
  computer?: JSX.Element
  onChange: (folders: string[], main: string) => void
  onAdd: () => void
}) {
  const { _ } = useLingui()
  return (
    <section class="project-folder-field">
      <div class="project-field-heading">
        <label>{_(copy.folders)}</label>
        {props.computer}
      </div>
      <Show
        when={props.folders.length}
        fallback={
          <button class="project-folder-empty" type="button" disabled={props.disabled} onClick={props.onAdd}>
            <Icon name={getSemanticIcon("workspace.main")} size="small" />
            {_(copy.chooseFolders)}
          </button>
        }
      >
        <div class="project-folder-list">
          <For each={props.folders}>
            {(folder) => {
              const [open, setOpen] = createSignal(false)
              return (
                <div class="project-folder-row">
                  <Icon name={getSemanticIcon("workspace.main")} size="small" />
                  <Tooltip value={folder} class="project-folder-name">
                    <span class="project-folder-name" tabindex="0">
                      {getFilename(folder) || folder}
                    </span>
                  </Tooltip>
                  <Show when={folder === props.main}>
                    <span class="project-folder-badge">{_(copy.main)}</span>
                  </Show>
                  <Popover
                    variant="menu"
                    title={_(copy.folderActions)}
                    open={open()}
                    onOpenChange={setOpen}
                    placement="bottom-end"
                    class="project-folder-actions"
                    triggerAs={(attributes) => (
                      <button
                        {...attributes}
                        type="button"
                        class="project-icon-button"
                        disabled={props.disabled}
                        aria-label={_(copy.folderActions)}
                      >
                        <Icon name={getSemanticIcon("action.more")} size="small" />
                      </button>
                    )}
                  >
                    <button
                      class="project-flow-row"
                      type="button"
                      disabled={folder === props.main}
                      onClick={() => {
                        props.onChange(props.folders, folder)
                        setOpen(false)
                      }}
                    >
                      {_(copy.setMain)}
                    </button>
                    <Tooltip value={folder === props.main ? _(copy.mainRemove) : ""}>
                      <button
                        class="project-flow-row"
                        type="button"
                        disabled={folder === props.main}
                        onClick={() => {
                          props.onChange(
                            props.folders.filter((item) => item !== folder),
                            props.main,
                          )
                          setOpen(false)
                        }}
                      >
                        {_(copy.remove)}
                      </button>
                    </Tooltip>
                  </Popover>
                </div>
              )
            }}
          </For>
        </div>
        <button class="project-add-folder" type="button" disabled={props.disabled} onClick={props.onAdd}>
          <Icon name={getSemanticIcon("action.add")} size="small" />
          {_(copy.addFolder)}
        </button>
      </Show>
    </section>
  )
}
