import { Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { useConfirm } from "@/components/dialog"
import { LatticeConfigDialog, type LatticeEnableConfig } from "@/components/lattice/lattice-config-dialog"
import { LatticePanel } from "@/components/lattice/lattice-panel"
import { useSDK } from "@/context/sdk"

export function LatticeWorkbenchContent() {
  const params = useParams()
  const sdk = useSDK()
  const dialog = useDialog()
  const confirm = useConfirm()
  const { _ } = useLingui()

  const applyConfig = async (sessionID: string, config: LatticeEnableConfig) => {
    await sdk.client.workflow.session.set({
      id: sessionID,
      workflowSetInput: {
        kind: "lattice",
        mode: config.mode,
        maxModelCalls: config.maxModelCalls,
        goal: config.goal,
      },
    })
  }

  const openConfig = (options?: { confirmRestart?: boolean }) => {
    const sessionID = params.id
    if (!sessionID) return
    dialog.show(() => (
      <LatticeConfigDialog
        sdk={sdk}
        sessionID={sessionID}
        onEnable={(config) => {
          if (!options?.confirmRestart) return applyConfig(sessionID, config)
          window.setTimeout(() => {
            confirm.show({
              title: { id: "app.lattice.restart.title", message: "Start a new Lattice run?" },
              description: {
                id: "app.lattice.restart.description",
                message:
                  "A new run will replace the current Session pointer with a fresh Pathway and model-call count. The previous run and its history will remain available.",
              },
              confirmLabel: { id: "app.lattice.restart.confirm", message: "Start new run" },
              cancelLabel: { id: "app.lattice.restart.cancel", message: "Keep current run" },
              tone: "neutral",
              onConfirm: () => applyConfig(sessionID, config),
            })
          }, 0)
        }}
      />
    ))
  }

  return (
    <Show
      when={params.id}
      fallback={
        <div class="flex size-full items-center justify-center px-6 text-center text-12-regular text-text-weak">
          {_({ id: "app.lattice.workspace.sessionRequired", message: "Open a Session to use Lattice." })}
        </div>
      }
    >
      {(sessionID) => <LatticePanel sdk={sdk} sessionID={sessionID()} onConfigure={openConfig} />}
    </Show>
  )
}
