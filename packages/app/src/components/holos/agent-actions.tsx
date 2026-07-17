import { createStore } from "solid-js/store"
import { For, onCleanup, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useLingui } from "@lingui/solid"
import type { HolosAccountMeta, HolosAgentProfile } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"
import { usePlatform } from "@/context/platform"
import "./agent-actions.css"

type GlobalSDK = ReturnType<typeof useGlobalSDK>
type HolosProfileInput = {
  name: string
  description?: string
  avatarUrl?: string
}

export function useHolosAgentActions(globalSDK: GlobalSDK) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const holos = useHolos()
  const platform = usePlatform()
  let loginMessageHandler: ((event: MessageEvent) => void) | undefined
  let loginMessageTimeout: ReturnType<typeof setTimeout> | undefined

  const callbackUrl = () => new URL("/holos/callback", globalSDK.url).toString()
  const callbackOrigin = () => new URL(globalSDK.url).origin

  const clearLoginMessageHandler = () => {
    if (loginMessageHandler) window.removeEventListener("message", loginMessageHandler)
    if (loginMessageTimeout) clearTimeout(loginMessageTimeout)
    loginMessageHandler = undefined
    loginMessageTimeout = undefined
  }

  onCleanup(clearLoginMessageHandler)

  async function startCreateAgent(profile: HolosProfileInput): Promise<boolean> {
    try {
      const res = await globalSDK.client.holos.login(
        { callbackUrl: callbackUrl(), clientSurface: platform.platform, profile },
        { throwOnError: true },
      )
      const authUrl = res.data?.url
      if (!authUrl) {
        showToast({
          type: "error",
          title: _({ id: "app.holos.loginFailed", message: "Holos login failed" }),
          description: _({ id: "app.holos.noLoginUrl", message: "No login URL returned." }),
        })
        return false
      }

      clearLoginMessageHandler()
      loginMessageHandler = (event: MessageEvent) => {
        if (event.origin !== callbackOrigin()) return
        if (event.data?.type === "holos-login-success") {
          clearLoginMessageHandler()
          void holos.refresh()
          showToast({
            type: "success",
            title: _({ id: "app.holos.connected", message: "Holos connected" }),
            description: _({ id: "app.holos.connectedDesc", message: "Your agent is now linked to Holos." }),
          })
          return
        }
        if (event.data?.type === "holos-login-failed") {
          clearLoginMessageHandler()
          const errMsg = typeof event.data?.error === "string" ? event.data.error : "Please try again."
          showToast({
            type: "error",
            title: _({ id: "app.holos.loginFailed", message: "Holos login failed" }),
            description: errMsg,
          })
        }
      }

      window.addEventListener("message", loginMessageHandler)
      if (platform.platform === "desktop") {
        platform.openLink(authUrl)
        loginMessageTimeout = setTimeout(clearLoginMessageHandler, 300_000)
        return true
      }

      const popup = window.open(authUrl, "holos-login", "width=600,height=700")
      loginMessageTimeout = setTimeout(clearLoginMessageHandler, 300_000)
      if (!popup) {
        clearLoginMessageHandler()
        showToast({
          type: "warning",
          title: _({ id: "app.holos.popupBlocked", message: "Popup blocked" }),
          description: _({
            id: "app.holos.popupBlockedDesc",
            message: "Allow popups for this site to sign in to Holos.",
          }),
          duration: 8000,
        })
        return false
      }
      return true
    } catch (e) {
      showToast({
        type: "error",
        title: _({ id: "app.holos.loginFailed", message: "Holos login failed" }),
        description: getErrorMessage(e, String(e)),
      })
      return false
    }
  }

  function createAgent() {
    dialog.show(() => <DialogCreateHolosAgent onCreate={startCreateAgent} />)
  }

  async function reconnect() {
    try {
      await globalSDK.client.holos.reconnect({ throwOnError: true })
      void holos.refresh()
    } catch (e) {
      showToast({
        type: "error",
        title: _({ id: "app.holos.reconnectFailed", message: "Holos reconnect failed" }),
        description: getErrorMessage(e, "Reconnect failed."),
      })
    }
  }

  async function switchAgent(agentId: string) {
    try {
      await globalSDK.client.holos.accounts.switch({ agentId }, { throwOnError: true })
      void holos.refresh()
      showToast({
        type: "success",
        title: _({ id: "app.holos.agentSwitched", message: "Agent switched" }),
        description: _({
          id: "app.holos.agentSwitchedDesc",
          message: "Switched to {id}",
          values: { id: agentId.slice(0, 8) },
        }),
      })
    } catch (e) {
      showToast({
        type: "error",
        title: _({ id: "app.holos.switchFailed", message: "Agent switch failed" }),
        description: getErrorMessage(e, "Unable to switch agent."),
      })
    }
  }

  async function logoutActiveAgent() {
    try {
      await globalSDK.client.holos.logout({ throwOnError: true })
      void holos.refresh()
      showToast({
        type: "success",
        title: _({ id: "app.holos.agentLoggedOut", message: "Agent logged out" }),
        description: _({
          id: "app.holos.agentLoggedOutDesc",
          message: "The active Holos agent was removed locally.",
        }),
      })
    } catch (e) {
      showToast({
        type: "error",
        title: _({ id: "app.holos.logoutFailed", message: "Logout failed" }),
        description: getErrorMessage(e, "Unable to log out."),
      })
    }
  }

  function importAgent() {
    dialog.show(() => <DialogImportHolosAgent globalSDK={globalSDK} onImported={() => holos.refresh()} />)
  }

  function openAgentSwitcher() {
    const activeAgentId = holos.state.identity.activeAccount?.agentId ?? holos.state.identity.agentId ?? undefined
    dialog.show(() => (
      <DialogSwitchHolosAgent
        accounts={holos.state.identity.accounts}
        activeAgentId={activeAgentId}
        activeProfile={holos.state.social.profile ?? undefined}
        onSwitch={async (agentId) => {
          await switchAgent(agentId)
          dialog.close()
        }}
        onCreate={() => {
          dialog.close()
          createAgent()
        }}
        onImport={() => {
          dialog.close()
          importAgent()
        }}
      />
    ))
  }

  return {
    createAgent,
    importAgent,
    openAgentSwitcher,
    reconnect,
    switchAgent,
    logoutActiveAgent,
  }
}

export function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }
  return fallback
}

function validateUrl(value: string, _: ReturnType<typeof useLingui>["_"]): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    new URL(trimmed)
    return undefined
  } catch {
    return _({ id: "app.holos.form.urlInvalid", message: "Enter a valid URL" })
  }
}

export function DialogSwitchHolosAgent(props: {
  accounts: HolosAccountMeta[]
  activeAgentId?: string
  activeProfile?: HolosAgentProfile
  onSwitch: (agentId: string) => Promise<void>
  onCreate: () => void
  onImport: () => void
}) {
  const { _ } = useLingui()

  function shortID(agentId: string) {
    return agentId.slice(0, 8)
  }

  function isActive(account: HolosAccountMeta) {
    return account.agentId === props.activeAgentId
  }

  function profile(account: HolosAccountMeta) {
    return account.profile ?? (isActive(account) ? props.activeProfile : undefined)
  }

  function label(account: HolosAccountMeta) {
    return profile(account)?.name || `Agent ${shortID(account.agentId)}`
  }

  function description(account: HolosAccountMeta) {
    const accountDesc = profile(account)?.description?.trim()
    if (accountDesc) return accountDesc
    if (account.profileError) return _({ id: "app.holos.profileUnavailable", message: "Profile unavailable" })
    return isActive(account)
      ? _({ id: "app.holos.currentAgent", message: "Current Holos agent" })
      : _({ id: "app.holos.savedAgent", message: "Saved on this device" })
  }

  function avatarUrl(account: HolosAccountMeta) {
    return profile(account)?.avatarUrl ?? undefined
  }

  return (
    <Dialog
      title={_({ id: "app.holos.switchAgent.title", message: "Switch Agent" })}
      description={_({
        id: "app.holos.switchAgent.description",
        message: "Choose which saved Holos agent Synergy should use.",
      })}
      class="holos-agent-switch-dialog"
    >
      <div class="holos-agent-switch">
        <Show
          when={props.accounts.length > 0}
          fallback={
            <div class="holos-agent-switch-empty">
              <Icon name={getSemanticIcon("settings.account")} size="normal" />
              <span>{_({ id: "app.holos.noSavedAgents", message: "No saved agents" })}</span>
            </div>
          }
        >
          <div class="holos-agent-switch-list">
            <For each={props.accounts}>
              {(account) => (
                <button
                  type="button"
                  class="holos-agent-switch-row"
                  data-active={isActive(account)}
                  disabled={isActive(account)}
                  onClick={() => void props.onSwitch(account.agentId)}
                >
                  <span class="holos-agent-switch-avatar">
                    <Show
                      when={avatarUrl(account)}
                      fallback={
                        <Icon
                          name={isActive(account) ? getSemanticIcon("state.success") : getSemanticIcon("state.empty")}
                          size="small"
                        />
                      }
                    >
                      {(src) => <img src={src()} alt="" />}
                    </Show>
                  </span>
                  <span class="holos-agent-switch-copy">
                    <span class="holos-agent-switch-name">{label(account)}</span>
                    <span class="holos-agent-switch-description">{description(account)}</span>
                    <span class="holos-agent-switch-id">{shortID(account.agentId)}</span>
                  </span>
                  <Show when={!isActive(account)}>
                    <span class="holos-agent-switch-status">{_({ id: "app.holos.switch", message: "Switch" })}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="holos-agent-switch-actions">
          <Button type="button" variant="secondary" size="large" onClick={props.onImport}>
            {_({ id: "app.holos.importAgent", message: "Import Agent" })}
          </Button>
          <Button type="button" variant="primary" size="large" onClick={props.onCreate}>
            {_({ id: "app.holos.createAgent", message: "Create Agent" })}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function DialogCreateHolosAgent(props: { onCreate: (profile: HolosProfileInput) => Promise<boolean> }) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const [form, setForm] = createStore({
    name: "",
    description: "",
    avatarUrl: "",
    nameError: undefined as string | undefined,
    avatarUrlError: undefined as string | undefined,
    submitting: false,
  })

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    const name = form.name.trim()
    const description = form.description.trim()
    const avatarUrl = form.avatarUrl.trim()
    const avatarUrlError = validateUrl(avatarUrl, _)

    setForm("nameError", name ? undefined : _({ id: "app.holos.form.nameRequired", message: "Name is required" }))
    setForm("avatarUrlError", avatarUrlError)
    if (!name || avatarUrlError) return

    setForm("submitting", true)
    try {
      const started = await props.onCreate({
        name,
        ...(description ? { description } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      })
      if (started) dialog.close()
    } finally {
      setForm("submitting", false)
    }
  }

  return (
    <Dialog
      title={_({ id: "app.holos.createAgent.title", message: "Create Agent" })}
      description={_({
        id: "app.holos.createAgent.description",
        message: "Choose how this agent should appear in Holos.",
      })}
      size="form"
      class="holos-agent-form-dialog"
    >
      <form onSubmit={handleSubmit} class="holos-agent-form">
        <div class="holos-agent-form-fields">
          <TextField
            autofocus
            label={_({ id: "app.holos.form.name", message: "Name" })}
            type="text"
            placeholder={_({ id: "app.holos.form.namePlaceholder", message: "Agent name" })}
            value={form.name}
            onChange={(value) => {
              setForm("name", value)
              if (value.trim()) setForm("nameError", undefined)
            }}
            validationState={form.nameError ? "invalid" : undefined}
            error={form.nameError}
          />
          <TextField
            label={_({ id: "app.holos.form.description", message: "Description" })}
            multiline
            placeholder={_({ id: "app.holos.form.descriptionPlaceholder", message: "Optional description" })}
            value={form.description}
            onChange={(value) => setForm("description", value)}
          />
          <TextField
            label={_({ id: "app.holos.form.avatarUrl", message: "Avatar URL" })}
            type="url"
            placeholder={_({ id: "app.holos.form.avatarUrlPlaceholder", message: "Optional image URL" })}
            value={form.avatarUrl}
            onChange={(value) => {
              setForm("avatarUrl", value)
              setForm("avatarUrlError", validateUrl(value, _))
            }}
            validationState={form.avatarUrlError ? "invalid" : undefined}
            error={form.avatarUrlError}
          />
        </div>
        <div class="holos-agent-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {_({ id: "app.holos.cancel", message: "Cancel" })}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={form.submitting}>
            {form.submitting
              ? _({ id: "app.holos.opening", message: "Opening..." })
              : _({ id: "app.holos.continue", message: "Continue" })}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function DialogImportHolosAgent(props: { globalSDK: GlobalSDK; onImported?: () => void | Promise<void> }) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const [form, setForm] = createStore({
    agentSecret: "",
    agentSecretError: undefined as string | undefined,
    submitting: false,
  })

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    const agentSecret = form.agentSecret.trim()

    setForm(
      "agentSecretError",
      agentSecret ? undefined : _({ id: "app.holos.form.secretRequired", message: "Agent secret is required" }),
    )
    if (!agentSecret) return

    setForm("submitting", true)
    try {
      const res = await props.globalSDK.client.holos.credentials({ agentSecret }, { throwOnError: true })
      await props.onImported?.()
      const agentId = res.data?.agentId
      const name = res.data?.profile.name || agentId?.slice(0, 8) || "Holos agent"
      showToast({
        type: "success",
        title: _({ id: "app.holos.agentImported", message: "Agent imported" }),
        description: _({
          id: "app.holos.agentImportedDesc",
          message: "Imported {name}",
          values: { name },
        }),
      })
      dialog.close()
    } catch (err) {
      showToast({
        type: "error",
        title: _({ id: "app.holos.importFailed", message: "Import failed" }),
        description: getErrorMessage(err, "Check the agent ID and secret, then try again."),
      })
    } finally {
      setForm("submitting", false)
    }
  }

  return (
    <Dialog
      title={_({ id: "app.holos.importAgent.title", message: "Import Agent" })}
      description={_({
        id: "app.holos.importAgent.description",
        message: "Paste the secret for an existing Holos agent.",
      })}
      size="form"
      class="holos-agent-form-dialog"
    >
      <form onSubmit={handleSubmit} class="holos-agent-form">
        <div class="holos-agent-form-fields">
          <TextField
            autofocus
            label={_({ id: "app.holos.form.agentSecret", message: "Agent Secret" })}
            type="password"
            placeholder={_({ id: "app.holos.form.agentSecretPlaceholder", message: "Paste agent secret" })}
            value={form.agentSecret}
            onChange={(value) => {
              setForm("agentSecret", value)
              if (value.trim()) setForm("agentSecretError", undefined)
            }}
            validationState={form.agentSecretError ? "invalid" : undefined}
            error={form.agentSecretError}
          />
        </div>
        <div class="holos-agent-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {_({ id: "app.holos.cancel", message: "Cancel" })}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={form.submitting}>
            {form.submitting
              ? _({ id: "app.holos.importing", message: "Importing..." })
              : _({ id: "app.holos.import", message: "Import" })}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
