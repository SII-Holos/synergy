import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import type { OrgCurrentSession } from "@ericsanchezok/synergy-sdk/organization"
import { type AuthorizationPage } from "./authorization"
import { createOrganizationApproval, OrganizationApprovalError } from "./approval"
import { organizationAuthMessages as messages } from "./messages"
import "./page.css"
import { OrganizationOnboarding, onboardingMessages } from "./onboarding"

export function OrganizationAuthorizationPage(props: { page?: AuthorizationPage }) {
  const { _ } = useLingui()
  const title = () => (props.page && "token" in props.page ? _(onboardingMessages[props.page.kind]) : _(messages.title))
  onMount(() => {
    document.title = title()
  })
  return (
    <main class="organization-auth">
      <section class="organization-auth-content" aria-labelledby="organization-auth-title">
        <p class="organization-auth-brand">{_({ id: "app.name.synergy", message: "Synergy" })}</p>
        <h1 id="organization-auth-title">{title()}</h1>
        <Show when={props.page} fallback={<p role="alert">{_(messages.invalid)}</p>}>
          {(page) => (
            <Show
              when={"token" in page()}
              fallback={
                <Show
                  when={page().kind === "authorize"}
                  fallback={<Callback page={page() as Extract<AuthorizationPage, { kind: "callback" }>} />}
                >
                  <Approval page={page() as Extract<AuthorizationPage, { kind: "authorize" }>} />
                </Show>
              }
            >
              {(_token) => <OrganizationOnboarding page={page() as Extract<AuthorizationPage, { token: string }>} />}
            </Show>
          )}
        </Show>
      </section>
    </main>
  )
}

function Approval(props: { page: Extract<AuthorizationPage, { kind: "authorize" }> }) {
  const { _ } = useLingui()
  const abort = new AbortController()
  const api = createOrganizationApproval({
    request: props.page.request,
    origin: window.location.origin,
    signal: abort.signal,
  })
  const [session, setSession] = createSignal<OrgCurrentSession>()
  const [loaded, setLoaded] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<keyof typeof messages>()
  const [loginName, setLoginName] = createSignal("")
  const [password, setPassword] = createSignal("")
  const request = props.page.request
  const destination = () =>
    request.redirectUri.startsWith("https:") ? new URL(request.redirectUri).origin : _(messages.desktop)

  async function run(action: () => Promise<void>, login = false) {
    if (busy() || abort.signal.aborted) return
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (error) {
      if (abort.signal.aborted) return
      const code = error instanceof OrganizationApprovalError ? error.code : "unavailable"
      if (code === "sign_in_required") setSession(undefined)
      setError(
        code === "invalid_request" || code === "invalid_response"
          ? "invalid"
          : code === "sign_in_required"
            ? login
              ? "signInFailed"
              : "expired"
            : "unavailable",
      )
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  async function load() {
    await run(async () => {
      const current = await api.load()
      if (abort.signal.aborted) return
      setSession(current)
      setLoaded(true)
    })
  }
  onMount(() => void load())
  onCleanup(() => {
    abort.abort()
    setPassword("")
  })

  return (
    <>
      <p class="organization-auth-origin">{request.issuer}</p>
      <Show when={error()}>{(error) => <p role="alert">{_(messages[error()])}</p>}</Show>
      <Show
        when={loaded()}
        fallback={
          <>
            <Show when={busy()} fallback={<Button onClick={() => void load()}>{_(messages.retry)}</Button>}>
              <p role="status">{_(messages.loading)}</p>
            </Show>
          </>
        }
      >
        <Show
          when={session()}
          fallback={
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const secret = password()
                void run(async () => {
                  try {
                    const current = await api.login({ loginName: loginName(), password: secret })
                    if (!abort.signal.aborted) setSession(current)
                  } finally {
                    setPassword("")
                  }
                }, true)
              }}
            >
              <fieldset disabled={busy()}>
                <TextField
                  label={_(messages.loginName)}
                  name="username"
                  autocomplete="username"
                  required
                  maxLength={128}
                  value={loginName()}
                  onChange={setLoginName}
                />
                <TextField
                  label={_(messages.password)}
                  name="password"
                  type="password"
                  autocomplete="current-password"
                  required
                  maxLength={1024}
                  value={password()}
                  onChange={setPassword}
                />
                <Button type="submit" size="large" variant="primary" disabled={busy()}>
                  {busy() ? _(messages.working) : _(messages.signIn)}
                </Button>
              </fieldset>
            </form>
          }
        >
          {(current) => (
            <div class="organization-auth-account">
              <div>
                <strong>{current().account.displayName}</strong>
                <p>{current().account.loginName}</p>
              </div>
              <p>{_(messages.destination.id, { client: destination() })}</p>
              <div class="organization-auth-actions">
                <Button
                  size="large"
                  variant="primary"
                  disabled={busy()}
                  onClick={() =>
                    void run(async () => {
                      const url = await api.approve()
                      if (!abort.signal.aborted) window.location.replace(url)
                    })
                  }
                >
                  {busy() ? _(messages.working) : _(messages.continue)}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy()}
                  onClick={() =>
                    void run(async () => {
                      await api.logout()
                      if (!abort.signal.aborted) setSession(undefined)
                    })
                  }
                >
                  {_(messages.signOut)}
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </>
  )
}

function Callback(props: { page: Extract<AuthorizationPage, { kind: "callback" }> }) {
  const { _ } = useLingui()
  const [sent, setSent] = createSignal(false)
  onMount(() => {
    if (props.page.code.expiresAt <= Date.now() || !window.opener || window.opener.closed) return
    try {
      window.opener.postMessage(
        { type: "synergy.organization.authorization", code: props.page.code },
        window.location.origin,
      )
      setSent(true)
    } catch {
      setSent(false)
    }
  })
  return (
    <>
      <p role="status">{sent() ? _(messages.returning) : _(messages.missingWindow)}</p>
      <Button variant="secondary" onClick={() => window.close()}>
        {_(messages.close)}
      </Button>
    </>
  )
}
