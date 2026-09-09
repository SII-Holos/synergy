import { Show } from "solid-js"
import { useSessionDataView } from "@/context/session-data-view"
import { PermissionDock } from "./permission-dock"
import { QuestionPrompt } from "./question-prompt"

export function SessionDecisionSurface(props: { sessionId?: string }) {
  const view = useSessionDataView()
  return (
    <Show when={props.sessionId}>
      {(id) => (
        <>
          <PermissionDock sessionID={id()} />
          <Show when={view().questionsFor(id())[0]}>
            {(request) => (
              <div class="mb-3">
                <QuestionPrompt request={request()} />
              </div>
            )}
          </Show>
        </>
      )}
    </Show>
  )
}
