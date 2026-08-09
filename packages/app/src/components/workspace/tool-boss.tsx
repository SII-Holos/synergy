import { Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { BossPanel } from "@/components/boss/boss-panel"
import { useSDK } from "@/context/sdk"

export function BossWorkbenchContent() {
  const params = useParams()
  const sdk = useSDK()
  const { _ } = useLingui()

  return (
    <Show
      when={params.id}
      fallback={
        <div class="flex size-full items-center justify-center px-6 text-center text-12-regular text-text-weak">
          {_({ id: "app.boss.workspace.sessionRequired", message: "Open a Session to use Boss Mode." })}
        </div>
      }
    >
      {(sessionID) => <BossPanel sdk={sdk} sessionID={sessionID()} />}
    </Show>
  )
}
