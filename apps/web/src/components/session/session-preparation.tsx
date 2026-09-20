import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useParams, useNavigate } from "@solidjs/router"
import type { StorageSessionPreparation } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useLocale } from "@/context/locale"
import { createSessionPreparationController } from "./session-preparation-controller"

export function SessionPreparation(props: { children: JSX.Element }) {
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useGlobalSDK()
  const server = useServer()
  const { i18n } = useLocale()
  const [status, setStatus] = createSignal<StorageSessionPreparation>()
  const [failed, setFailed] = createSignal(false)
  let retry: (() => Promise<void>) | undefined
  createEffect(() => {
    server.url
    const sessionID = params.id
    setStatus(undefined)
    setFailed(false)
    if (!sessionID) return
    const controller = createSessionPreparationController({
      prepare: async (signal) =>
        (await sdk.client.storage.prepareSession({ sessionID }, { signal, throwOnError: true })).data!,
      poll: async (signal) =>
        (await sdk.client.storage.upgradeSession({ sessionID }, { signal, throwOnError: true })).data!,
      retry: async (signal) =>
        (await sdk.client.storage.retrySession({ sessionID }, { signal, throwOnError: true })).data!,
      publish: (value) => {
        setFailed(false)
        setStatus(value)
      },
      failed: () => setFailed(true),
      hidden: () => document.hidden,
    })
    retry = controller.retry
    void controller.start()
    onCleanup(() => {
      controller.dispose()
      retry = undefined
    })
  })
  const ready = () => !params.id || (status()?.sessionID === params.id && status()?.state === "ready")
  const blocked = () => status()?.state === "blocked" || status()?.error?.category === "integrity"
  const error = () => failed() || status()?.state === "failed" || blocked()
  return (
    <Show
      when={ready()}
      fallback={
        <div class="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6 text-text-base">
          <Show when={!error()}>
            <Spinner class="size-6" />
          </Show>
          <div role="status" aria-live="polite" class="max-w-lg text-center space-y-2">
            <p class="text-ui-large font-medium">
              {error()
                ? i18n._({ id: "app.upgrade.sessionAttention", message: "This conversation needs attention" })
                : i18n._({ id: "app.upgrade.sessionPreparing", message: "Preparing this conversation" })}
            </p>
            <p class="text-ui-regular text-text-weak">
              {blocked()
                ? i18n._({
                    id: "app.upgrade.sessionRepair",
                    message:
                      "Verification found a problem. Your original data and recovery files are preserved. Check storage diagnostics before retrying.",
                  })
                : error()
                  ? i18n._({
                      id: "app.upgrade.sessionRetryHelp",
                      message:
                        "Preparation could not finish. Check the connection and available disk space, then retry.",
                    })
                  : i18n._({
                      id: "app.upgrade.sessionWait",
                      message:
                        "Your history is being checked and upgraded. You can leave this page and continue with other conversations.",
                    })}
            </p>
            <Show when={status()?.files}>
              <p class="text-ui-small text-text-weak">
                {i18n._({
                  id: "app.upgrade.sessionFiles",
                  message: "{count} files prepared",
                  values: { count: status()!.files },
                })}
              </p>
            </Show>
          </div>
          <div class="flex gap-2">
            <Button variant="secondary" onClick={() => navigate("../")}>
              {i18n._({ id: "app.upgrade.leave", message: "Back to workspace" })}
            </Button>
            <Show when={error() && !blocked()}>
              <Button
                onClick={() => {
                  setFailed(false)
                  void retry?.()
                }}
              >
                {i18n._({ id: "app.upgrade.retry", message: "Retry" })}
              </Button>
            </Show>
          </div>
        </div>
      }
    >
      {props.children}
    </Show>
  )
}
