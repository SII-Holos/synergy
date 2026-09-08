import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSessionDataView } from "@/context/session-data-view"
import { useLocale } from "@/context/locale"
import { PermissionDock } from "./permission-dock"
import { QuestionPrompt } from "./question-prompt"

const decisionLabel = { id: "session.decisions.label", message: "Session decision required" }

export function SessionDecisionSurface(props: { sessionId?: string }) {
  const view = useSessionDataView()
  const dialog = useDialog()
  const { i18n } = useLocale()
  const question = () => (props.sessionId ? view().questionsFor(props.sessionId)[0] : undefined)
  const pending = createMemo(() => {
    const id = props.sessionId
    if (!id) return false
    return (
      Boolean(question()) ||
      view().permissionsFor(id).length > 0 ||
      view()
        .sessions()
        .some((child) => child.parentID === id && view().permissionsFor(child.id).length > 0)
    )
  })
  let dialogId: string | undefined
  const close = () => {
    if (dialogId) dialog.close(dialogId)
    dialogId = undefined
  }
  createEffect(
    on(
      () => [props.sessionId, pending()] as const,
      ([id, required]) => {
        close()
        if (!id || !required) return
        dialogId = dialog.push(
          () => (
            <Dialog ariaLabel={i18n._(decisionLabel)} dismissible={false} size="wide">
              <PermissionDock sessionID={id} />
              <Show when={question()}>{(request) => <QuestionPrompt request={request()} />}</Show>
            </Dialog>
          ),
          undefined,
          { protected: true },
        )
      },
    ),
  )
  onCleanup(close)
  return null
}
