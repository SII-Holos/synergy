import { onCleanup } from "solid-js"
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

export function ProjectTaskButton(props: { label: string; disabled: boolean; uploading?: boolean }) {
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
  const open = () => dialog.show(() => <DialogSelectProject selected={sdk.scopeID} onSelect={select} />)
  command.register(() => [
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
    <Tooltip value={props.uploading ? _(copy.uploading) : params.id ? _(copy.newTask) : _(copy.choose)} placement="top">
      <button
        type="button"
        class="session-work-context-button"
        data-project-task-selector
        disabled={props.disabled || props.uploading}
        aria-label={params.id ? _(copy.newTask) : _(copy.choose)}
        onClick={open}
      >
        <Icon name={getSemanticIcon("workspace.main")} size="small" />
        <span>{sdk.isHome ? _(copy.choose) : props.label}</span>
      </button>
    </Tooltip>
  )
}
