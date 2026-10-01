import { createMediaQuery } from "@solid-primitives/media"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { useGlobalSync } from "@/context/global-sync"
import { useServer } from "@/context/server"
import { DialogCreateProject } from "../dialog/dialog-create-project"
import { projectEntryCopy } from "../dialog/project-entry-copy"
import { ProjectMenuContent } from "../dialog/dialog-select-project"
import { createSignal, onCleanup } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useCommand } from "@/context/command"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePrompt } from "@/context/prompt"
import { useConfirm } from "../dialog/confirm-dialog"
import { DialogSelectProject } from "../dialog/dialog-select-project"
import { projectFlowCopy as copy } from "../dialog/project-flow-copy"

export function ProjectTaskButton(props: {
  label: string
  path?: string
  disabled: boolean
  uploading?: boolean
  onSettings?: () => void
}) {
  const { _ } = useLingui()
  const sdk = useSDK()
  const sync = useSync()
  const prompt = usePrompt()
  const params = useParams()
  const navigate = useNavigate()
  const dialog = useDialog()
  const confirm = useConfirm()
  const command = useCommand()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const [opened, setOpened] = createSignal(false)
  const desktop = createMediaQuery("(min-width: 640px)")
  const server = useServer()
  const globalSync = useGlobalSync()
  function closeMenu() {
    setOpened(false)
    if (!desktop()) dialog.close()
    document.querySelector<HTMLButtonElement>("[data-project-task-selector]")?.focus({ preventScroll: true })
  }
  const create = () => {
    closeMenu()
    dialog.show(() => (
      <DialogCreateProject
        onCreated={async (id, url) => {
          if (url !== server.url) {
            server.setActive(url)
            navigate(`/${base64Encode(id)}/session`)
            return
          }
          await globalSync.refreshScopes()
          server.scopes.open(id)
          return select(id)
        }}
      />
    ))
  }
  const settings = props.onSettings
    ? () => {
        closeMenu()
        props.onSettings?.()
      }
    : undefined
  const open = () =>
    desktop()
      ? setOpened(true)
      : dialog.show(() => (
          <DialogSelectProject selected={sdk.scopeID} onSelect={select} onCreate={create} onSettings={settings} />
        ))
  command.register(() => [
    {
      id: "project.create",
      title: _(projectEntryCopy.create),
      disabled: props.disabled || props.uploading,
      onSelect: create,
    },
    {
      id: "project.select",
      title: _(copy.choose),
      disabled: props.disabled || props.uploading,
      onSelect: () => {
        open()
      },
    },
  ])
  async function select(scopeID: string) {
    if (props.disabled || props.uploading || disposed) return false
    const client = sdk.client
    if (!params.id) {
      const transfer = prompt.prepareProjectTransfer(base64Encode(scopeID), sdk.scopeID, sync.data.path.workspace?.path)
      try {
        if (
          transfer.conflict &&
          !(await confirm.ask({
            title: copy.mergeTitle,
            description: copy.mergeDescription,
            confirmLabel: copy.merge,
            tone: "neutral",
          }))
        )
          return false
        if (disposed || sdk.client !== client || props.uploading) return false
        if (!transfer.commit()) throw new Error(_(copy.changed))
      } finally {
        transfer.release()
      }
    }
    navigate(`/${base64Encode(scopeID)}/session`)
  }
  return (
    <Popover
      variant="menu"
      title={_(copy.choose)}
      placement="top-start"
      open={opened()}
      onOpenChange={setOpened}
      class="project-select-popover"
      triggerAs={(attributes) => (
        <Tooltip
          class="session-work-context-project"
          value={
            opened() || dialog.active
              ? ""
              : props.uploading
                ? _(copy.uploading)
                : [sdk.isHome ? undefined : props.label, props.path, params.id ? _(copy.newTask) : _(copy.choose)]
                    .filter(Boolean)
                    .join("\n")
          }
          placement="top"
        >
          <button
            {...attributes}
            type="button"
            class="session-work-context-button"
            data-project-task-selector
            disabled={props.disabled || props.uploading}
            aria-label={
              params.id
                ? _(copy.newTask)
                : sdk.isHome
                  ? _(copy.choose)
                  : _({ ...copy.currentProject, values: { name: props.label } })
            }
            aria-description={props.path}
            onClick={(event) => {
              if (!desktop()) {
                event.preventDefault()
                open()
              } else setOpened((value) => !value)
            }}
          >
            <Icon name={getSemanticIcon("project.main")} size="small" />
            <span>{sdk.isHome ? _(copy.choose) : props.label}</span>
          </button>
        </Tooltip>
      )}
    >
      <ProjectMenuContent
        selected={sdk.scopeID}
        onSelect={select}
        onCreate={create}
        onClose={() => setOpened(false)}
        onSettings={settings}
      />
    </Popover>
  )
}
