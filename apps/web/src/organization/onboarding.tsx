import { createSignal, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import type { AuthorizationPage } from "./authorization"

export const onboardingMessages = {
  invite: { id: "organization.onboarding.invite", message: "Join your organization" },
  reset: { id: "organization.onboarding.reset", message: "Reset your password" },
  setup: { id: "organization.onboarding.setup", message: "Set up your organization" },
  organization: { id: "organization.onboarding.organization", message: "Organization name" },
  login: { id: "organization.onboarding.login", message: "Account name" },
  displayName: { id: "organization.onboarding.displayName", message: "Your name" },
  password: { id: "organization.onboarding.password", message: "New password" },
  passwordHint: {
    id: "organization.onboarding.passwordHint",
    message: "Use at least 12 characters. This account belongs only to this organization.",
  },
  create: { id: "organization.onboarding.create", message: "Create account" },
  save: { id: "organization.onboarding.save", message: "Save password" },
  working: { id: "organization.onboarding.working", message: "Setting up…" },
  done: { id: "organization.onboarding.done", message: "You're ready to go" },
  doneHint: {
    id: "organization.onboarding.doneHint",
    message: "Return to Synergy and connect this organization with your account.",
  },
  resetDone: {
    id: "organization.onboarding.resetDone",
    message: "Your password has been changed. Return to Synergy to sign in again.",
  },
  failed: {
    id: "organization.onboarding.failed",
    message: "This request could not be completed. Check the link and your connection, then try again.",
  },
  used: {
    id: "organization.onboarding.used",
    message: "This one-time link has already been used. Ask your administrator for a new link.",
  },
  taken: { id: "organization.onboarding.taken", message: "This account name is already in use. Choose another name." },
}

export function OrganizationOnboarding(props: { page: Extract<AuthorizationPage, { token: string }> }) {
  const { _ } = useLingui()
  const api = createOrganizationClient({ baseUrl: window.location.origin, credentials: "include", redirect: "error" })
  const abort = new AbortController()
  const options = { throwOnError: true, signal: abort.signal } as const
  const [organization, setOrganization] = createSignal("")
  const [login, setLogin] = createSignal("")
  const [displayName, setDisplayName] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [done, setDone] = createSignal(false)
  const [error, setError] = createSignal<keyof typeof onboardingMessages>()
  let requestID: string | undefined
  onCleanup(() => {
    abort.abort()
    setPassword("")
  })
  async function submit() {
    if (busy() || abort.signal.aborted) return
    setBusy(true)
    setError(undefined)
    requestID ??= generateSecureUUID()
    try {
      const shared = { token: props.page.token, requestID, password: password() }
      if (props.page.kind === "reset") await api.orgAuth.reset({ orgResetConsume: shared }, options)
      else {
        const identity = { ...shared, loginName: login().trim(), displayName: displayName().trim() }
        if (props.page.kind === "setup")
          await api.orgSetup.bootstrap(
            { orgBootstrapInput: { ...identity, organizationName: organization().trim() } },
            options,
          )
        else await api.orgInvites.consume({ orgInviteConsume: identity }, options)
        await api.orgAuth.login(
          { orgLoginInput: { loginName: identity.loginName, password: identity.password } },
          options,
        )
      }
      setPassword("")
      if (!abort.signal.aborted) setDone(true)
    } catch (error) {
      if (abort.signal.aborted) return
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined
      setError(code === "TOKEN_CONSUMED" ? "used" : code === "LOGIN_NAME_TAKEN" ? "taken" : "failed")
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  return (
    <>
      <p class="organization-auth-origin">{window.location.origin}</p>
      <Show
        when={done()}
        fallback={
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <Show when={error()}>{(error) => <p role="alert">{_(onboardingMessages[error()])}</p>}</Show>
            <fieldset disabled={busy()}>
              <Show when={props.page.kind === "setup"}>
                <TextField
                  label={_(onboardingMessages.organization)}
                  value={organization()}
                  onChange={setOrganization}
                  maxLength={200}
                  required
                />
              </Show>
              <Show when={props.page.kind !== "reset"}>
                <TextField
                  label={_(onboardingMessages.login)}
                  value={login()}
                  onChange={setLogin}
                  maxLength={128}
                  autocomplete="username"
                  required
                />
                <TextField
                  label={_(onboardingMessages.displayName)}
                  value={displayName()}
                  onChange={setDisplayName}
                  maxLength={200}
                  autocomplete="name"
                  required
                />
              </Show>
              <TextField
                label={_(onboardingMessages.password)}
                value={password()}
                onChange={setPassword}
                type="password"
                autocomplete="new-password"
                minLength={12}
                maxLength={1024}
                description={_(onboardingMessages.passwordHint)}
                required
              />
              <Button size="large" variant="primary" type="submit" disabled={busy()}>
                {_(
                  busy()
                    ? onboardingMessages.working
                    : props.page.kind === "reset"
                      ? onboardingMessages.save
                      : onboardingMessages.create,
                )}
              </Button>
            </fieldset>
          </form>
        }
      >
        <div role="status">
          <strong>{_(onboardingMessages.done)}</strong>
          <p>{_(props.page.kind === "reset" ? onboardingMessages.resetDone : onboardingMessages.doneHint)}</p>
        </div>
      </Show>
    </>
  )
}
