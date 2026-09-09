import { createContext, createSignal, onCleanup, onMount, Show, useContext, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import { PortalStyleOwner, UIStyleProvider } from "@ericsanchezok/synergy-ui/context/ui-style"
import { useSessionDataView } from "@/context/session-data-view"
import { PermissionDock } from "./permission-dock"
import { QuestionPrompt } from "./question-prompt"

export function SessionDecisionSurface(props: { sessionId?: string }) {
  const view = useSessionDataView()
  return (
    <Show when={props.sessionId}>
      {(id) => (
        <div data-session-decision-stack style={{ "max-height": "min(50dvh, 32rem)", overflow: "auto" }}>
          <PermissionDock sessionID={id()} />
          <Show when={view().questionsFor(id())[0]}>
            {(request) => (
              <div class="mb-3">
                <QuestionPrompt request={request()} />
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

const DecisionOutletContext = createContext<(element: HTMLDivElement) => () => void>()

export function SessionDecisionOutlet() {
  const register = useContext(DecisionOutletContext)
  let element!: HTMLDivElement
  let release: (() => void) | undefined
  onMount(() => {
    release = register?.(element)
  })
  onCleanup(() => release?.())
  return <div ref={element} data-session-decision-outlet />
}

export function SessionDecisionHost(props: ParentProps<{ sessionId?: string }>) {
  const [outlet, setOutlet] = createSignal<HTMLDivElement>()
  return (
    <DecisionOutletContext.Provider
      value={(element) => {
        setOutlet(element)
        return () => setOutlet((current) => (current === element ? undefined : current))
      }}
    >
      {props.children}
      <UIStyleProvider reset>
        <Portal mount={outlet()}>
          <PortalStyleOwner>
            <div
              data-session-decision-host
              style={
                outlet()
                  ? undefined
                  : {
                      position: "fixed",
                      bottom: "1rem",
                      left: "50%",
                      transform: "translateX(-50%)",
                      width: "min(48rem, calc(100vw - 2rem))",
                      "z-index": 1000,
                    }
              }
            >
              <SessionDecisionSurface sessionId={props.sessionId} />
            </div>
          </PortalStyleOwner>
        </Portal>
      </UIStyleProvider>
    </DecisionOutletContext.Provider>
  )
}
