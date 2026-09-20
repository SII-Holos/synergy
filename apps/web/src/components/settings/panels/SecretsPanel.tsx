import { useConfirm } from "@/components/dialog/confirm-dialog"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { For, Show, createResource, createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { PasswordField } from "../components/PasswordField"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { SettingRow } from "@ericsanchezok/synergy-ui/setting-row"
import {
  formatResolveCap,
  formatToolAllowlist,
  parseResolveCap,
  parseToolAllowlist,
  secretSourceLabel,
  validateSecretDraft,
  type SecretEntryLike,
} from "./secrets-panel-model"

const copy = {
  title: { id: "settings.secrets.page.title", message: "Secrets" },
  description: {
    id: "settings.secrets.page.description",
    message:
      "Registered secrets are masked everywhere the model can see and resolved only when a tool executes. Values are never sent to the browser; reveal them with the CLI.",
  },
  registerTitle: { id: "settings.secrets.register.title", message: "Register a secret" },
  registerDescription: {
    id: "settings.secrets.register.description",
    message: "Paste a value to mask it across every session. Re-registering a known value is a no-op.",
  },
  registerButton: { id: "settings.secrets.register.button", message: "Register" },
  valueLabel: { id: "settings.secrets.value.label", message: "Secret value" },
  toolsLabel: { id: "settings.secrets.tools.label", message: "Tool allowlist (optional)" },
  toolsPlaceholder: { id: "settings.secrets.tools.placeholder", message: "e.g. bash, mcp — empty means every tool" },
  listTitle: { id: "settings.secrets.list.title", message: "Registered secrets" },
  empty: { id: "settings.secrets.list.empty", message: "No secrets registered yet." },
  sourceLabel: { id: "settings.secrets.row.source", message: "Source" },
  resolvesLabel: { id: "settings.secrets.row.resolves", message: "Resolves" },
  capLabel: { id: "settings.secrets.row.cap", message: "Per-session resolve cap" },
  capPlaceholder: { id: "settings.secrets.row.capPlaceholder", message: "empty means unlimited" },
  edit: { id: "settings.secrets.action.edit", message: "Edit" },
  close: { id: "settings.secrets.action.close", message: "Close" },
  rotate: { id: "settings.secrets.action.rotate", message: "Rotate" },
  remove: { id: "settings.secrets.action.remove", message: "Remove" },
  save: { id: "settings.secrets.action.save", message: "Save policy" },
  history: { id: "settings.secrets.action.history", message: "History" },
  historyTitle: { id: "settings.secrets.history.title", message: "Recent resolves" },
  rotateTitle: { id: "settings.secrets.rotate.title", message: "Rotate value" },
  rotateHint: {
    id: "settings.secrets.rotate.hint",
    message: "The new value gets a new id; policy and history carry over.",
  },
  registeredTitle: { id: "settings.secrets.toast.registered", message: "Secret registered" },
  registeredDescription: {
    id: "settings.secrets.toast.registeredDesc",
    message: "The value is now masked everywhere.",
  },
  rotatedTitle: { id: "settings.secrets.toast.rotated", message: "Secret rotated" },
  removedTitle: { id: "settings.secrets.toast.removed", message: "Secret removed" },
  removedDescription: {
    id: "settings.secrets.toast.removedDesc",
    message: "Historical mask tokens no longer resolve.",
  },
  policySavedTitle: { id: "settings.secrets.toast.policy", message: "Policy saved" },
  failedTitle: { id: "settings.secrets.toast.failed", message: "Action failed" },
  emptyValueDescription: { id: "settings.secrets.toast.emptyValue", message: "Enter a non-empty value." },
  removeConfirmTitle: { id: "settings.secrets.removeConfirm.title", message: "Remove this secret?" },
  removeConfirmDescription: {
    id: "settings.secrets.removeConfirm.desc",
    message:
      "Historical mask tokens in past conversations stop resolving and render as revoked. Re-registering the same value restores them.",
  },
  revealHint: {
    id: "settings.secrets.revealHint",
    message: "To view a value, run: synergy secrets reveal <id>",
  },
  confirm: { id: "settings.secrets.action.confirm", message: "Remove" },
  cancel: { id: "settings.secrets.action.cancel", message: "Keep" },
  noHistory: { id: "settings.secrets.history.empty", message: "No resolves recorded." },
}

function rowDescription(entry: SecretEntryLike, description: (d: MessageDescriptor) => string) {
  const parts = [
    `${description(copy.sourceLabel)}: ${secretSourceLabel(entry)}`,
    `${description(copy.resolvesLabel)}: ${entry.resolvedCount}`,
  ]
  if (entry.policy?.tools?.length) parts.push(`${description(copy.toolsLabel)}: ${formatToolAllowlist(entry.policy)}`)
  if (entry.policy?.maxResolvesPerSession !== undefined)
    parts.push(`${description(copy.capLabel)}: ${entry.policy.maxResolvesPerSession}`)
  return parts.join(" · ")
}

export function SecretsPanel() {
  const { _ } = useLingui()
  const confirm = useConfirm()
  const globalSDK = useGlobalSDK()
  const [entries, { refetch }] = createResource(async () => {
    const response = await globalSDK.client.secrets.list(undefined, { throwOnError: true })
    return response.data
  })

  const [newValue, setNewValue] = createSignal("")
  const [newTools, setNewTools] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [expanded, setExpanded] = createSignal<string>()
  const [rotateValue, setRotateValue] = createSignal("")
  const [policyTools, setPolicyTools] = createSignal("")
  const [policyCap, setPolicyCap] = createSignal("")
  const [history, setHistory] = createSignal<Record<string, { at: number; tool?: string; outcome: string }[]>>({})
  const [historyOpen, setHistoryOpen] = createSignal<string>()

  function openEditor(entry: SecretEntryLike) {
    setExpanded(expanded() === entry.id ? undefined : entry.id)
    setRotateValue("")
    setPolicyTools(formatToolAllowlist(entry.policy))
    setPolicyCap(formatResolveCap(entry.policy))
  }

  async function register() {
    const value = newValue()
    if (validateSecretDraft(value)) {
      showToast({ type: "error", title: _(copy.failedTitle), description: _(copy.emptyValueDescription) })
      return
    }
    setBusy(true)
    try {
      const tools = parseToolAllowlist(newTools())
      await globalSDK.client.secrets.create(
        { secretCreateInput: { value, ...(tools ? { policy: { tools } } : {}) } },
        { throwOnError: true },
      )
      setNewValue("")
      setNewTools("")
      await refetch()
      showToast({ type: "success", title: _(copy.registeredTitle), description: _(copy.registeredDescription) })
    } catch (error) {
      showToast({ type: "error", title: _(copy.failedTitle), description: requestErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function rotate(id: string) {
    const value = rotateValue()
    if (validateSecretDraft(value)) {
      showToast({ type: "error", title: _(copy.failedTitle), description: _(copy.emptyValueDescription) })
      return
    }
    setBusy(true)
    try {
      await globalSDK.client.secrets.rotate({ id, secretRotateInput: { value } }, { throwOnError: true })
      setRotateValue("")
      setExpanded(undefined)
      await refetch()
      showToast({ type: "success", title: _(copy.rotatedTitle) })
    } catch (error) {
      showToast({ type: "error", title: _(copy.failedTitle), description: requestErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function savePolicy(id: string) {
    setBusy(true)
    try {
      const tools = parseToolAllowlist(policyTools())
      const cap = parseResolveCap(policyCap())
      await globalSDK.client.secrets.updatePolicy(
        {
          id,
          secretPolicyInput: {
            policy: { ...(tools ? { tools } : {}), ...(cap !== undefined ? { maxResolvesPerSession: cap } : {}) },
          },
        },
        { throwOnError: true },
      )
      await refetch()
      showToast({ type: "success", title: _(copy.policySavedTitle) })
    } catch (error) {
      showToast({ type: "error", title: _(copy.failedTitle), description: requestErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    const accepted = await confirm.ask({
      title: _(copy.removeConfirmTitle),
      description: _(copy.removeConfirmDescription),
      confirmLabel: _(copy.confirm),
      cancelLabel: _(copy.cancel),
      tone: "danger",
    })
    if (!accepted) return
    setBusy(true)
    try {
      await globalSDK.client.secrets.remove({ id }, { throwOnError: true })
      if (expanded() === id) setExpanded(undefined)
      await refetch()
      showToast({ type: "success", title: _(copy.removedTitle), description: _(copy.removedDescription) })
    } catch (error) {
      showToast({ type: "error", title: _(copy.failedTitle), description: requestErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function toggleHistory(id: string) {
    if (historyOpen() === id) {
      setHistoryOpen(undefined)
      return
    }
    setHistoryOpen(id)
    if (!history()[id]) {
      const response = await globalSDK.client.secrets.history({ id }, { throwOnError: true })
      setHistory((current) => ({ ...current, [id]: response.data }))
    }
  }

  return (
    <SettingsPage title={_(copy.title)} description={_(copy.description)}>
      <SettingsSection title={_(copy.registerTitle)} description={_(copy.registerDescription)}>
        <PasswordField label={_(copy.valueLabel)} value={newValue()} onChange={setNewValue} />
        <TextField
          label={_(copy.toolsLabel)}
          placeholder={_(copy.toolsPlaceholder)}
          value={newTools()}
          onChange={setNewTools}
        />
        <Button type="button" disabled={busy()} onClick={() => void register()}>
          {_(copy.registerButton)}
        </Button>
      </SettingsSection>
      <SettingsSection title={_(copy.listTitle)}>
        <Show when={(entries() ?? []).length > 0} fallback={<p>{_(copy.empty)}</p>}>
          <For each={entries()}>
            {(entry) => (
              <div class="ds-secrets-entry">
                <SettingRow
                  title={entry.id}
                  description={rowDescription(entry, _)}
                  trailing={
                    <div class="flex gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        disabled={busy()}
                        onClick={() => void toggleHistory(entry.id)}
                      >
                        {_(copy.history)}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        disabled={busy()}
                        onClick={() => openEditor(entry)}
                      >
                        {expanded() === entry.id ? _(copy.close) : _(copy.edit)}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        disabled={busy()}
                        onClick={() => void remove(entry.id)}
                      >
                        {_(copy.remove)}
                      </Button>
                    </div>
                  }
                />
                <Show when={expanded() === entry.id}>
                  <div class="ds-secrets-editor">
                    <p>{_(copy.rotateHint)}</p>
                    <PasswordField label={_(copy.rotateTitle)} value={rotateValue()} onChange={setRotateValue} />
                    <Button type="button" variant="secondary" disabled={busy()} onClick={() => void rotate(entry.id)}>
                      {_(copy.rotate)}
                    </Button>
                    <TextField
                      label={_(copy.toolsLabel)}
                      placeholder={_(copy.toolsPlaceholder)}
                      value={policyTools()}
                      onChange={setPolicyTools}
                    />
                    <TextField
                      label={_(copy.capLabel)}
                      placeholder={_(copy.capPlaceholder)}
                      value={policyCap()}
                      onChange={setPolicyCap}
                    />
                    <Button type="button" disabled={busy()} onClick={() => void savePolicy(entry.id)}>
                      {_(copy.save)}
                    </Button>
                  </div>
                </Show>
                <Show when={historyOpen() === entry.id}>
                  <div class="ds-secrets-history">
                    <p>{_(copy.historyTitle)}</p>
                    <Show when={(history()[entry.id] ?? []).length > 0} fallback={<p>{_(copy.noHistory)}</p>}>
                      <ul>
                        <For each={(history()[entry.id] ?? []).slice(-10).reverse()}>
                          {(item) => (
                            <li>
                              {new Date(item.at).toLocaleString()} — {item.tool ?? "—"} — {item.outcome}
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
        <p>{_(copy.revealHint)}</p>
      </SettingsSection>
    </SettingsPage>
  )
}
