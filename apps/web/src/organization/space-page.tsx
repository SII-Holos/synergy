import { createSignal, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { useSpace } from "@/context/space"
import { usePlatform } from "@/context/platform"
import { SpaceSwitcher } from "@/components/sidebar/space-switcher"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { organizationSpaceMessages as messages } from "./space-messages"
import { OrganizationWorkspace } from "./workspace"
import "./space-page.css"

export function SpaceAccess() {
  const platform = usePlatform()
  return (
    <div class="organization-space-footer">
      <SpaceSwitcher expanded onRepository={() => platform.openLink("https://github.com/SII-Holos/synergy")} />
    </div>
  )
}

function connectionError(error: unknown): keyof typeof messages {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  if (code === "origin_not_allowed") return "originNotAllowed"
  if (code === "invalid_request") return "invalidRequest"
  if (code === "storage_unavailable" || code === "credentials_unavailable" || code === "credentials_invalid")
    return "storage"
  if (code === "identity_changed" || code === "invalid_response") return "identityChanged"
  if (code === "popup_unavailable") return "popup"
  if (code === "secure_context_required") return "secure"
  if (code === "sign_out_pending") return "signOutPending"
  return "unavailable"
}

export function OrganizationSpace() {
  const space = useSpace()
  const platform = usePlatform()
  const { _ } = useLingui()
  const confirm = useConfirm()
  onMount(() => window.dispatchEvent(new Event("synergy:app-surface-ready")))
  const title = () => space.connection()?.name ?? space.connection()?.issuer ?? _(messages.connect)
  const ready = () => space.current()?.identity.kind === "organization" && space.current()
  function signOut() {
    const key = space.selected()
    if (!key) return
    confirm.show({
      title: messages.signOut,
      description: messages.signOutDescription,
      confirmLabel: messages.signOut,
      tone: "warning",
      onConfirm: () => {
        void space.signOut(key).catch(() => {})
      },
    })
  }
  return (
    <div
      class="organization-space"
      classList={{
        "organization-space--connecting": space.selected() === "connect",
        "organization-space--desktop": platform.platform === "desktop",
      }}
    >
      <Show when={space.selected() !== "connect" && !ready()}>
        <header class="organization-space-header">
          <div>
            <p class="organization-space-brand">{_({ id: "app.name.synergy", message: "Synergy" })}</p>
            <h1>{title()}</h1>
            <Show when={space.connection()}>
              {(entry) => (
                <p class="organization-space-account">
                  {entry().account.displayName} · {entry().account.loginName}
                </p>
              )}
            </Show>
          </div>
          <Show when={space.connection()?.state === "ready"}>
            <Button variant="ghost" onClick={signOut}>
              {_(messages.signOut)}
            </Button>
          </Show>
        </header>
      </Show>
      <main class="organization-space-content" classList={{ "organization-space-content--workspace": !!ready() }}>
        <Show when={space.error()}>
          {(error) => (
            <p role="alert" class="organization-space-error">
              {_(messages[connectionError(error())])}
            </p>
          )}
        </Show>
        <Show
          when={space.selected() === "connect"}
          fallback={
            <Show
              when={space.connection()}
              fallback={
                <div class="organization-space-state">
                  <h2>{_(messages.missing)}</h2>
                  <Button onClick={space.add}>{_(messages.connect)}</Button>
                </div>
              }
            >
              {(entry) => (
                <Show
                  when={space.current()?.identity.kind === "organization" && space.current()}
                  keyed
                  fallback={
                    <div class="organization-space-state">
                      <h2>
                        {_(
                          entry().state === "sign_out_pending"
                            ? messages.signOutPending
                            : entry().state === "signed_out"
                              ? messages.signedOut
                              : messages.disconnected,
                        )}
                      </h2>
                      <Button
                        disabled={space.busy()}
                        onClick={() => {
                          const key = space.selected()!
                          void (entry().state === "sign_out_pending" ? space.signOut(key) : space.restore(key)).catch(
                            () => {},
                          )
                        }}
                      >
                        {_(
                          space.busy()
                            ? messages.connecting
                            : entry().state === "sign_out_pending"
                              ? messages.finishSignOut
                              : messages.restore,
                        )}
                      </Button>
                    </div>
                  }
                >
                  {(_view) => <OrganizationWorkspace footer={<SpaceAccess />} signOut={signOut} />}
                </Show>
              )}
            </Show>
          }
        >
          <Connect />
        </Show>
      </main>
      <Show when={!ready()}>
        <SpaceAccess />
      </Show>
    </div>
  )
}

function Connect() {
  const space = useSpace()
  const { _ } = useLingui()
  const [issuer, setIssuer] = createSignal(space.origins.length === 1 ? space.origins[0]! : "")
  const [clientID, setClientID] = createSignal(space.desktop ? "desktop" : "web")
  const [failed, setFailed] = createSignal(false)
  return (
    <form
      class="organization-space-form organization-connect-panel"
      onSubmit={(event) => {
        event.preventDefault()
        if (space.busy()) return
        setFailed(false)
        void space
          .connect({ issuer: issuer().trim().replace(/\/+$/, ""), clientID: clientID().trim() })
          .catch(() => setFailed(true))
      }}
    >
      <div class="organization-connect-identity">
        <img src={brandAssetPath(BRAND_ASSETS.synergy.productIcon)} alt="" />
        <span>{_({ id: "app.name.synergy", message: "Synergy" })}</span>
      </div>
      <div class="organization-connect-intro">
        <h1>{_(messages.connect)}</h1>
        <p>{_(messages.connectDescription)}</p>
      </div>
      <Show when={!space.desktop && !space.origins.length}>
        <p role="alert">{_(messages.originNotAllowed)}</p>
      </Show>
      <Show when={failed() && !space.error()}>
        <p role="alert">{_(messages.unavailable)}</p>
      </Show>
      <fieldset disabled={space.busy()}>
        <TextField
          label={_(messages.address)}
          value={issuer()}
          onChange={setIssuer}
          type="url"
          placeholder="https://team.example.com"
          required
          autocomplete="url"
        />
        <details class="organization-connect-advanced">
          <summary>{_(messages.advanced)}</summary>
          <TextField
            label={_(messages.client)}
            value={clientID()}
            onChange={setClientID}
            required
            autocomplete="off"
            description={_(messages.clientHint)}
          />
        </details>
        <Button type="submit" size="large" variant="primary" disabled={!space.desktop && !space.origins.length}>
          {_(space.busy() ? messages.connecting : messages.connect)}
        </Button>
        <p class="organization-connect-hint">{_(messages.authorizationHint)}</p>
      </fieldset>
      <Button type="button" variant="ghost" size="large" onClick={space.personal}>
        {_(messages.personalBack)}
      </Button>
    </form>
  )
}
