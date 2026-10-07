import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  Show,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js"
import { useParams, useNavigate } from "@solidjs/router"
import type { StorageSessionPreparation } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useLocale } from "@/context/locale"
import { createSessionPreparationController } from "./session-preparation-controller"

const SessionPreparationContext = createContext<{
  ready: Accessor<boolean>
  status: Accessor<StorageSessionPreparation | undefined>
  failed: Accessor<boolean>
  retry: () => void
}>()

export function useSessionPreparation() {
  return useContext(SessionPreparationContext) ?? { ready: () => true }
}

export function SessionPreparation(props: { children: JSX.Element }) {
  const params = useParams()
  const sdk = useGlobalSDK()
  const server = useServer()
  const [status, setStatus] = createSignal<{ server: string; value: StorageSessionPreparation }>()
  const [failed, setFailed] = createSignal(false)
  const [mounted, setMounted] = createSignal(!params.id)
  let retry: (() => Promise<void>) | undefined
  createEffect(() => {
    const url = server.url
    const sessionID = params.id
    const cached = sessionID ? sdk.sessionPreparation.get(url, sessionID) : undefined
    setStatus(cached ? { server: url, value: cached } : undefined)
    setFailed(false)
    if (!sessionID || cached) return
    const controller = createSessionPreparationController({
      prepare: async (signal) =>
        (await sdk.client.storage.prepareSession({ sessionID }, { signal, throwOnError: true })).data!,
      poll: async (signal) =>
        (await sdk.client.storage.upgradeSession({ sessionID }, { signal, throwOnError: true })).data!,
      retry: async (signal) =>
        (await sdk.client.storage.retrySession({ sessionID }, { signal, throwOnError: true })).data!,
      publish: (value) => {
        sdk.sessionPreparation.set(url, value)
        setFailed(false)
        setStatus({ server: url, value })
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
  const currentStatus = () =>
    status()?.server === server.url && status()?.value.sessionID === params.id
      ? status()?.value
      : params.id
        ? sdk.sessionPreparation.get(server.url, params.id)
        : undefined
  const ready = () => !params.id || currentStatus()?.state === "ready"
  createEffect(() => {
    if (ready()) setMounted(true)
  })
  return (
    <SessionPreparationContext.Provider
      value={{
        ready,
        status: currentStatus,
        failed,
        retry: () => {
          setFailed(false)
          void retry?.()
        },
      }}
    >
      <Show when={mounted()} fallback={<SessionPreparationNotice />}>
        {props.children}
      </Show>
    </SessionPreparationContext.Provider>
  )
}

export function SessionPreparationNotice() {
  const preparation = useContext(SessionPreparationContext)!
  const navigate = useNavigate()
  const { i18n } = useLocale()
  const status = preparation.status
  const blocked = () => status()?.state === "blocked" || status()?.error?.category === "integrity"
  const error = () => preparation.failed() || status()?.state === "failed" || blocked()
  return (
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
                  message: "Preparation could not finish. Check the connection and available disk space, then retry.",
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
          <Button onClick={preparation.retry}>{i18n._({ id: "app.upgrade.retry", message: "Retry" })}</Button>
        </Show>
      </div>
    </div>
  )
}
