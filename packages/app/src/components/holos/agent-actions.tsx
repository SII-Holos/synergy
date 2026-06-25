import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"

type GlobalSDK = ReturnType<typeof useGlobalSDK>

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

  async function createAgent() {
    try {
      const res = await globalSDK.client.holos.login({ callbackUrl: callbackUrl() }, { throwOnError: true })
      const authUrl = res.data?.url
      if (!authUrl) {
        showToast({ type: "error", title: "Holos login failed", description: "No login URL returned." })
        return
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
      }
    } catch (e) {
      showToast({ type: "error", title: "Holos login failed", description: getErrorMessage(e, String(e)) })
    }
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

  return {
    createAgent,
    importAgent,
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

export function DialogImportHolosAgent(props: { globalSDK: GlobalSDK; onImported?: () => void | Promise<void> }) {
  const dialog = useDialog()
  const [form, setForm] = createStore({
    agentId: "",
    agentSecret: "",
    agentIdError: undefined as string | undefined,
    agentSecretError: undefined as string | undefined,
    submitting: false,
  })

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    const agentId = form.agentId.trim()
    const agentSecret = form.agentSecret.trim()

    setForm("agentIdError", agentId ? undefined : "Agent ID is required")
    setForm("agentSecretError", agentSecret ? undefined : "Agent secret is required")
    if (!agentId || !agentSecret) return

    setForm("submitting", true)
    try {
      await props.globalSDK.client.holos.credentials({ agentId, agentSecret }, { throwOnError: true })
      await props.onImported?.()
      showToast({
        type: "success",
        title: "Agent imported",
        description: `Imported ${agentId.slice(0, 8)}`,
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
    <Dialog title="Import Agent">
      <form onSubmit={handleSubmit} class="sidebar-agent-import-form">
        <div class="sidebar-agent-import-hero">
          <span class="sidebar-agent-import-icon">
            <Icon name="key-round" size="normal" />
          </span>
          <div class="sidebar-agent-import-heading">
            <span class="sidebar-agent-import-kicker">Holos Agent</span>
            <p>
              Connect an existing agent with its ID and secret. The secret is stored locally and never shown here again.
            </p>
          </div>
        </div>
        <div class="sidebar-agent-import-fields">
          <TextField
            autofocus
            label="Agent ID"
            type="text"
            placeholder="agent_..."
            value={form.agentId}
            onChange={(value) => {
              setForm("agentId", value)
              if (value.trim()) setForm("agentIdError", undefined)
            }}
            validationState={form.agentIdError ? "invalid" : undefined}
            error={form.agentIdError}
          />
          <TextField
            label="Agent Secret"
            type="password"
            placeholder="Secret"
            value={form.agentSecret}
            onChange={(value) => {
              setForm("agentSecret", value)
              if (value.trim()) setForm("agentSecretError", undefined)
            }}
            validationState={form.agentSecretError ? "invalid" : undefined}
            error={form.agentSecretError}
          />
        </div>
        <div class="sidebar-agent-import-note">
          <Icon name="shield-check" size="small" />
          <span>The agent secret is saved in local Synergy storage and is not displayed after import.</span>
        </div>
        <div class="sidebar-agent-import-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={form.submitting}>
            {form.submitting ? "Importing..." : "Import Agent"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
