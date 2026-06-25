import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { SettingsFieldGrid, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { GeneralStore } from "../types"

export function ProfilePanel(props: { username: string; onUsernameChange: (value: GeneralStore["username"]) => void }) {
  return (
    <SettingsPage title="Profile" description="User-facing profile values used by Synergy.">
      <SettingsSection title="Identity">
        <SettingsFieldGrid>
          <TextField
            label="Username"
            type="text"
            value={props.username}
            placeholder="Display name"
            onChange={props.onUsernameChange}
          />
        </SettingsFieldGrid>
      </SettingsSection>
    </SettingsPage>
  )
}
