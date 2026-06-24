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
    <Dialog title="Edit project">
      <div style="display:flex;flex-direction:column;gap:16px;padding:4px 0">
        <TextField
          label="Project name"
          type="text"
          placeholder={getScopeLabel(props.scope)}
          value={name()}
          onChange={setName}
        />

        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <Icon name="folder" size="small" />
            <span style="font-size:12px;color:var(--text-weak)">Worktree</span>
            <code style="font-size:12px;color:var(--text-base)">{props.scope.worktree}</code>
          </div>
          {props.scope.directory && props.scope.directory !== props.scope.worktree && (
            <div style="display:flex;align-items:center;gap:8px">
              <Icon name="folder" size="small" />
              <span style="font-size:12px;color:var(--text-weak)">Directory</span>
              <code style="font-size:12px;color:var(--text-base)">{props.scope.directory}</code>
            </div>
          )}
          {props.scope.type && (
            <div style="display:flex;align-items:center;gap:8px">
              <Icon name="tag" size="small" />
              <span style="font-size:12px;color:var(--text-weak)">Type</span>
              <code style="font-size:12px;color:var(--text-base)">{props.scope.type}</code>
            </div>
          )}
          {props.scope.id && (
            <div style="display:flex;align-items:center;gap:8px">
              <Icon name="fingerprint" size="small" />
              <span style="font-size:12px;color:var(--text-weak)">ID</span>
              <code style="font-size:12px;font-family:monospace;color:var(--text-weak)">{props.scope.id}</code>
            </div>
          )}
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px">
          <Button type="button" variant="ghost" size="small" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="button" variant="primary" size="small" disabled={saving()} onClick={handleSave}>
            {saving() ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
