import { createSignal, createUniqueId, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import "../browser-settings.css"

export const browserSettingsCopy = {
  title: { id: "settings.browser.title", message: "In-app browser" },
  data: { id: "settings.browser.data", message: "Browser data" },
  import: { id: "settings.browser.import.label", message: "Import browser data" },
  importHint: { id: "settings.browser.import.hint", message: "Import passwords and cookies from supported browsers." },
  importAction: { id: "settings.browser.import.action", message: "Import" },
  passwords: { id: "settings.browser.passwords.section", message: "Passwords and autofill" },
  manage: { id: "settings.browser.passwords.label", message: "Manage saved passwords" },
  manageHint: {
    id: "settings.browser.passwords.hint",
    message: "View and delete logins saved or imported in the in-app browser.",
  },
}

export function BrowserPanel() {
  const { _ } = useLingui(),
    dialog = useDialog()
  const [loading, setLoading] = createSignal(false)
  const [failed, setFailed] = createSignal<"import" | "passwords">()
  const importHintId = createUniqueId(),
    manageHintId = createUniqueId()
  let disposed = false
  let childId: string | undefined
  onCleanup(() => {
    disposed = true
    if (childId) dialog.close(childId)
  })
  const show = async (section: "import" | "passwords") => {
    if (loading()) return
    setFailed(undefined)
    setLoading(true)
    let DataDialog: (typeof import("../browser-profile-data-dialog"))["BrowserProfileDataDialog"]
    try {
      DataDialog = (await import("../browser-profile-data-dialog")).BrowserProfileDataDialog
    } catch {
      if (!disposed) setFailed(section)
      return
    } finally {
      setLoading(false)
    }
    if (disposed) return
    childId = dialog.push(
      () => <DataDialog section={section} />,
      () => {
        childId = undefined
      },
    )
  }
  return (
    <SettingsPage title={_(browserSettingsCopy.title)}>
      <Show when={failed()}>
        {(section) => (
          <div class="settings-resource-error" role="alert">
            <div>
              {_({
                id: "settings.panel.section.loadFailed",
                message: "Could not load {label}. Your changes are kept.",
                values: { label: _(browserSettingsCopy.title) },
              })}
            </div>
            <Button variant="secondary" onClick={() => void show(section())}>
              {_({ id: "settings.panel.section.retry", message: "Retry" })}
            </Button>
          </div>
        )}
      </Show>
      <SettingsSection title={_(browserSettingsCopy.data)}>
        <Button
          variant="ghost"
          class="browser-settings-action"
          aria-label={_(browserSettingsCopy.import)}
          aria-describedby={importHintId}
          aria-disabled={loading()}
          aria-busy={loading()}
          onClick={() => void show("import")}
        >
          <span class="browser-settings-action-copy">
            <span class="browser-settings-action-title">{_(browserSettingsCopy.import)}</span>
            <span id={importHintId} class="browser-settings-action-hint">
              {_(browserSettingsCopy.importHint)}
            </span>
          </span>
          <span class="browser-settings-action-trailing" aria-hidden="true">
            {_(browserSettingsCopy.importAction)}
            <Icon name={getSemanticIcon("navigation.expand")} size="small" />
          </span>
        </Button>
      </SettingsSection>
      <SettingsSection title={_(browserSettingsCopy.passwords)}>
        <Button
          variant="ghost"
          class="browser-settings-action"
          aria-label={_(browserSettingsCopy.manage)}
          aria-describedby={manageHintId}
          aria-disabled={loading()}
          aria-busy={loading()}
          onClick={() => void show("passwords")}
        >
          <span class="browser-settings-action-copy">
            <span class="browser-settings-action-title">{_(browserSettingsCopy.manage)}</span>
            <span id={manageHintId} class="browser-settings-action-hint">
              {_(browserSettingsCopy.manageHint)}
            </span>
          </span>
          <span class="browser-settings-action-trailing" aria-hidden="true">
            <Icon name={getSemanticIcon("navigation.expand")} size="small" />
          </span>
        </Button>
      </SettingsSection>
    </SettingsPage>
  )
}
