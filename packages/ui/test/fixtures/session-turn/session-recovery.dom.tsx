import { I18nProvider } from "@lingui/solid"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { AssistantMessage, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { SessionRecovery } from "../../../src/components/session-recovery"
import { setupI18n } from "../../../src/testing/i18n"

const [status, setStatus] = createSignal<SessionStatus>({ type: "idle" })
const [error, setError] = createSignal<AssistantMessage["error"]>()
const calls: unknown[] = []
let resolve: (() => void) | undefined
const dispose = render(
  () => (
    <I18nProvider i18n={setupI18n()}>
      <SessionRecovery
        sessionID="session"
        rootID="root"
        messageID="message"
        providerID="test"
        current
        status={status()}
        error={error()}
        onAction={(action) => {
          calls.push(action)
          return new Promise<void>((done) => {
            resolve = done
          })
        }}
      />
      <SessionRecovery sessionID="session" rootID="old-root" current={false} status={status()} />
    </I18nProvider>
  ),
  document.querySelector("#root")!,
)
Object.assign(globalThis, {
  __recovery: { setStatus, setError, calls, resolve: () => resolve?.(), dispose },
})
