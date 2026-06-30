import { createStore } from "solid-js/store"
import { For, onCleanup, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { HolosAccountMeta, HolosAgentProfile } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"

type GlobalSDK = ReturnType<typeof useGlobalSDK>
type HolosProfileInput = {
  name: string
  description?: string
  avatarUrl?: string
}

export function useHolosAgentActions(globalSDK: GlobalSDK) {
  const dialog = useDialog()
  const holos = useHolos()
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
      const res = await globalSDK.client.holos.login({ callbackUrl: callbackUrl(), profile }, { throwOnError: true })
      const authUrl = res.data?.url
      if (!authUrl) {
        showToast({ type: "error", title: "Holos login failed", description: "No login URL returned." })
        return false
      }

      clearLoginMessageHandler()
      loginMessageHandler = (event: MessageEvent) => {
        if (event.origin !== callbackOrigin()) return
        if (event.data?.type === "holos-login-success") {
          clearLoginMessageHandler()
          void holos.refresh()
          showToast({ type: "success", title: "Holos connected", description: "Your agent is now linked to Holos." })
          return
        }
        if (event.data?.type === "holos-login-failed") {
          clearLoginMessageHandler()
          const errMsg = typeof event.data?.error === "string" ? event.data.error : "Please try again."
          showToast({ type: "error", title: "Holos login failed", description: errMsg })
        }
      }

      window.addEventListener("message", loginMessageHandler)
      const popup = window.open(authUrl, "holos-login", "width=600,height=700")
      loginMessageTimeout = setTimeout(clearLoginMessageHandler, 300_000)
      if (!popup) {
        clearLoginMessageHandler()
        showToast({
          type: "warning",
          title: "Popup blocked",
          description: "Allow popups for this site to sign in to Holos.",
          duration: 8000,
        })
        return false
      }
      return true
    } catch (e) {
      showToast({ type: "error", title: "Holos login failed", description: getErrorMessage(e, String(e)) })
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
        title: "Holos reconnect failed",
        description: getErrorMessage(e, "Reconnect failed."),
      })
    }
  }

  async function switchAgent(agentId: string) {
    try {
      await globalSDK.client.holos.accounts.switch({ agentId }, { throwOnError: true })
      void holos.refresh()
      showToast({ type: "success", title: "Agent switched", description: `Switched to ${agentId.slice(0, 8)}` })
    } catch (e) {
      showToast({
        type: "error",
        title: "Agent switch failed",
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
        title: "Agent logged out",
        description: "The active Holos agent was removed locally.",
      })
    } catch (e) {
      showToast({ type: "error", title: "Logout failed", description: getErrorMessage(e, "Unable to log out.") })
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

function validateUrl(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    new URL(trimmed)
    return undefined
  } catch {
    return "Enter a valid URL"
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
  function shortID(agentId: string) {
    return agentId.slice(0, 8)
  }

  function isActive(account: HolosAccountMeta) {
    return account.agentId === props.activeAgentId
  }

  function label(account: HolosAccountMeta) {
    if (!isActive(account)) return `Agent ${shortID(account.agentId)}`
    return props.activeProfile?.name || `Agent ${shortID(account.agentId)}`
  }

  function description(account: HolosAccountMeta) {
    if (!isActive(account)) return "Saved on this device"
    return props.activeProfile?.description || "Current Holos agent"
  }

  function avatarUrl(account: HolosAccountMeta) {
    if (!isActive(account)) return undefined
    return props.activeProfile?.avatarUrl ?? undefined
  }

  return (
    <Dialog
      title="Switch Agent"
      description="Choose which saved Holos agent Synergy should use."
      class="sidebar-agent-switch-dialog-shell"
    >
      <div class="sidebar-agent-switch-dialog">
        <Show
          when={props.accounts.length > 0}
          fallback={
            <div class="sidebar-agent-switch-empty">
              <Icon name="user" size="normal" />
              <span>No saved agents</span>
            </div>
          }
        >
          <div class="sidebar-agent-switch-list">
            <For each={props.accounts}>
              {(account) => (
                <button
                  type="button"
                  class="sidebar-agent-switch-row"
                  classList={{ "sidebar-agent-switch-row-active": isActive(account) }}
                  disabled={isActive(account)}
                  onClick={() => void props.onSwitch(account.agentId)}
                >
                  <span class="sidebar-agent-switch-avatar">
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
                  <span class="sidebar-agent-switch-copy">
                    <span class="sidebar-agent-switch-name">{label(account)}</span>
                    <span class="sidebar-agent-switch-description">{description(account)}</span>
                    <span class="sidebar-agent-switch-id">{shortID(account.agentId)}</span>
                  </span>
                  <Show when={!isActive(account)}>
                    <span class="sidebar-agent-switch-status">Switch</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="sidebar-agent-switch-actions">
          <Button type="button" variant="secondary" size="small" onClick={props.onImport}>
            Import Agent
          </Button>
          <Button type="button" variant="primary" size="small" onClick={props.onCreate}>
            Create Agent
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function DialogCreateHolosAgent(props: { onCreate: (profile: HolosProfileInput) => Promise<boolean> }) {
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
    const avatarUrlError = validateUrl(avatarUrl)

    setForm("nameError", name ? undefined : "Name is required")
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
      title="Create Agent"
      description="Choose how this agent should appear in Holos."
      class="sidebar-agent-import-dialog-shell"
    >
      <form onSubmit={handleSubmit} class="sidebar-agent-import-form">
        <div class="sidebar-agent-import-fields">
          <TextField
            autofocus
            label="Name"
            type="text"
            placeholder="Agent name"
            value={form.name}
            onChange={(value) => {
              setForm("name", value)
              if (value.trim()) setForm("nameError", undefined)
            }}
            validationState={form.nameError ? "invalid" : undefined}
            error={form.nameError}
          />
          <TextField
            label="Description"
            multiline
            placeholder="Optional description"
            value={form.description}
            onChange={(value) => setForm("description", value)}
          />
          <TextField
            label="Avatar URL"
            type="url"
            placeholder="Optional image URL"
            value={form.avatarUrl}
            onChange={(value) => {
              setForm("avatarUrl", value)
              setForm("avatarUrlError", validateUrl(value))
            }}
            validationState={form.avatarUrlError ? "invalid" : undefined}
            error={form.avatarUrlError}
          />
        </div>
        <div class="sidebar-agent-import-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={form.submitting}>
            {form.submitting ? "Opening..." : "Continue"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function DialogImportHolosAgent(props: { globalSDK: GlobalSDK; onImported?: () => void | Promise<void> }) {
  const dialog = useDialog()
  const [form, setForm] = createStore({
    agentSecret: "",
    agentSecretError: undefined as string | undefined,
    submitting: false,
  })

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    const agentSecret = form.agentSecret.trim()

    setForm("agentSecretError", agentSecret ? undefined : "Agent secret is required")
    if (!agentSecret) return

    setForm("submitting", true)
    try {
      const res = await props.globalSDK.client.holos.credentials({ agentSecret }, { throwOnError: true })
      await props.onImported?.()
      const agentId = res.data?.agentId
      const name = res.data?.profile.name || agentId?.slice(0, 8) || "Holos agent"
      showToast({
        type: "success",
        title: "Agent imported",
        description: `Imported ${name}`,
      })
      dialog.close()
    } catch (err) {
      showToast({
        type: "error",
        title: "Import failed",
        description: getErrorMessage(err, "Check the agent ID and secret, then try again."),
      })
    } finally {
      setForm("submitting", false)
    }
  }

  return (
    <Dialog
      title="Import Agent"
      description="Paste the secret for an existing Holos agent."
      class="sidebar-agent-import-dialog-shell"
    >
      <form onSubmit={handleSubmit} class="sidebar-agent-import-form">
        <div class="sidebar-agent-import-fields">
          <TextField
            autofocus
            label="Agent Secret"
            type="password"
            placeholder="Paste agent secret"
            value={form.agentSecret}
            onChange={(value) => {
              setForm("agentSecret", value)
              if (value.trim()) setForm("agentSecretError", undefined)
            }}
            validationState={form.agentSecretError ? "invalid" : undefined}
            error={form.agentSecretError}
          />
        </div>
        <div class="sidebar-agent-import-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={form.submitting}>
            {form.submitting ? "Importing..." : "Import"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
