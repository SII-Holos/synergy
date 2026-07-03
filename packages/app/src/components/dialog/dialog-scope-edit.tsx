import { createSignal } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getScopeLabel } from "@/utils/scope"
import type { LocalScope } from "@/context/layout"

export function DialogScopeEdit(props: { scope: LocalScope }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const [name, setName] = createSignal(props.scope.name ?? "")
  const [saving, setSaving] = createSignal(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const scopeID = props.scope.id ?? props.scope.worktree
      await globalSDK.client.scope.update({ path_scopeID: scopeID, name: name().trim() || undefined })
      showToast({ type: "info", title: "Project updated", description: name() || getScopeLabel(props.scope) })
      dialog.close()
    } catch (e: any) {
      showToast({ type: "error", title: "Failed to update project", description: e?.message ?? "Unknown error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="Edit project" size="form">
      <div data-slot="dialog-form">
        <TextField
          label="Project name"
          type="text"
          placeholder={getScopeLabel(props.scope)}
          value={name()}
          onChange={setName}
        />

        <div data-slot="dialog-meta-list" aria-label="Project details">
          <div data-slot="dialog-meta-row">
            <span data-slot="dialog-meta-icon" aria-hidden="true">
              <Icon name="folder" size="small" />
            </span>
            <span data-slot="dialog-meta-label">Worktree</span>
            <code data-slot="dialog-meta-value">{props.scope.worktree}</code>
          </div>
          {props.scope.directory && props.scope.directory !== props.scope.worktree && (
            <div data-slot="dialog-meta-row">
              <span data-slot="dialog-meta-icon" aria-hidden="true">
                <Icon name="folder" size="small" />
              </span>
              <span data-slot="dialog-meta-label">Directory</span>
              <code data-slot="dialog-meta-value">{props.scope.directory}</code>
            </div>
          )}
          {props.scope.type && (
            <div data-slot="dialog-meta-row">
              <span data-slot="dialog-meta-icon" aria-hidden="true">
                <Icon name="tag" size="small" />
              </span>
              <span data-slot="dialog-meta-label">Type</span>
              <code data-slot="dialog-meta-value">{props.scope.type}</code>
            </div>
          )}
          {props.scope.id && (
            <div data-slot="dialog-meta-row">
              <span data-slot="dialog-meta-icon" aria-hidden="true">
                <Icon name="fingerprint" size="small" />
              </span>
              <span data-slot="dialog-meta-label">ID</span>
              <code data-slot="dialog-meta-value">{props.scope.id}</code>
            </div>
          )}
        </div>

        <div data-slot="dialog-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="button" variant="primary" size="large" disabled={saving()} onClick={handleSave}>
            {saving() ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
