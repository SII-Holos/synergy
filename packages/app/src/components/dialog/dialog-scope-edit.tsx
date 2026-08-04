import { createSignal, For } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { dialog } from "@/locales/messages"
import { useGlobalSDK } from "@/context/global-sdk"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getScopeLabel } from "@/utils/scope"
import type { LocalScope } from "@/context/layout"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { DialogSelectDirectory } from "./dialog-select-directory"

export function DialogScopeEdit(props: { scope: LocalScope }) {
  const dialogContext = useDialog()
  const globalSDK = useGlobalSDK()
  const { _ } = useLingui()
  const [name, setName] = createSignal(props.scope.name ?? "")
  const [folders, setFolders] = createSignal<string[]>(props.scope.sandboxes ?? [])
  const [saving, setSaving] = createSignal(false)

  const scopeID = () => props.scope.id ?? props.scope.worktree
  const mainFolder = () => props.scope.worktree

  const handleSave = async () => {
    setSaving(true)
    try {
      await globalSDK.client.scope.update({
        path_scopeID: scopeID(),
        name: name().trim() || undefined,
        sandboxes: folders(),
      })
      showToast({ type: "info", title: _(dialog.scopeUpdated), description: name() || getScopeLabel(props.scope) })
      dialogContext.close()
    } catch (e: any) {
      showToast({
        type: "error",
        title: _(dialog.scopeUpdateFailed),
        description: e?.message ?? _(dialog.scopeUpdateUnknownError),
      })
    } finally {
      setSaving(false)
    }
  }

  const handleAddFolder = () => {
    dialogContext.push(() => (
      <DialogSelectDirectory
        title={_(dialog.projectFoldersAddTitle)}
        onSelect={(result) => {
          if (!result) return
          const selected = Array.isArray(result.directory) ? result.directory : [result.directory]
          const next = [...folders(), ...selected]
          setFolders([...new Set(next)])
        }}
      />
    ))
  }

  const handleRemoveFolder = (folder: string) => {
    setFolders(folders().filter((item) => item !== folder))
  }

  return (
    <Dialog title={_(dialog.editProject)} size="form">
      <div data-slot="dialog-form">
        <TextField
          label={_(dialog.projectName)}
          type="text"
          placeholder={getScopeLabel(props.scope)}
          value={name()}
          onChange={setName}
        />

        <div data-slot="dialog-meta-list" aria-label={_(dialog.projectDetails)}>
          <div data-slot="dialog-meta-row">
            <span data-slot="dialog-meta-icon" aria-hidden="true">
              <Icon name={getSemanticIcon("workspace.main")} size="small" />
            </span>
            <span data-slot="dialog-meta-label">{_(dialog.worktree)}</span>
            <code data-slot="dialog-meta-value">{props.scope.worktree}</code>
          </div>
          {props.scope.directory && props.scope.directory !== props.scope.worktree && (
            <div data-slot="dialog-meta-row">
              <span data-slot="dialog-meta-icon" aria-hidden="true">
                <Icon name={getSemanticIcon("workspace.main")} size="small" />
              </span>
              <span data-slot="dialog-meta-label">{_(dialog.directory)}</span>
              <code data-slot="dialog-meta-value">{props.scope.directory}</code>
            </div>
          )}
          {props.scope.type && (
            <div data-slot="dialog-meta-row">
              <span data-slot="dialog-meta-icon" aria-hidden="true">
                <Icon name={getSemanticIcon("notes.tag")} size="small" />
              </span>
              <span data-slot="dialog-meta-label">{_(dialog.scopeType)}</span>
              <code data-slot="dialog-meta-value">{props.scope.type}</code>
            </div>
          )}
          {props.scope.id && (
            <div data-slot="dialog-meta-row">
              <span data-slot="dialog-meta-icon" aria-hidden="true">
                <Icon name={getSemanticIcon("workspace.identity")} size="small" />
              </span>
              <span data-slot="dialog-meta-label">{_(dialog.scopeID)}</span>
              <code data-slot="dialog-meta-value">{props.scope.id}</code>
            </div>
          )}
        </div>

        <div data-slot="dialog-meta-list" aria-label={_(dialog.projectFolders)}>
          <div data-slot="dialog-meta-row">
            <span data-slot="dialog-meta-icon" aria-hidden="true">
              <Icon name={getSemanticIcon("workspace.main")} size="small" />
            </span>
            <span data-slot="dialog-meta-label">{_(dialog.projectFoldersMain)}</span>
            <code data-slot="dialog-meta-value">{mainFolder()}</code>
          </div>
          <For each={folders()}>
            {(folder) => (
              <div data-slot="dialog-meta-row">
                <span data-slot="dialog-meta-icon" aria-hidden="true">
                  <Icon name={getSemanticIcon("workspace.add")} size="small" />
                </span>
                <span data-slot="dialog-meta-label">{_(dialog.projectFolders)}</span>
                <span data-slot="dialog-meta-value">
                  <code>{folder}</code>
                  <IconButton
                    icon={getSemanticIcon("action.remove")}
                    size="normal"
                    variant="ghost"
                    aria-label={_(dialog.projectFoldersRemove)}
                    onClick={() => handleRemoveFolder(folder)}
                  />
                </span>
              </div>
            )}
          </For>
          <div data-slot="dialog-meta-row">
            <span data-slot="dialog-meta-icon" aria-hidden="true">
              <Icon name={getSemanticIcon("action.add")} size="small" />
            </span>
            <span data-slot="dialog-meta-label" />
            <Button type="button" variant="ghost" size="normal" onClick={handleAddFolder}>
              {_(dialog.projectFoldersAdd)}
            </Button>
          </div>
          <div data-slot="dialog-meta-hint">{_(dialog.projectFoldersHint)}</div>
        </div>

        <div data-slot="dialog-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialogContext.close()}>
            {_(dialog.cancel)}
          </Button>
          <Button type="button" variant="primary" size="large" disabled={saving()} onClick={handleSave}>
            {saving() ? _(dialog.saving) : _(dialog.save)}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
