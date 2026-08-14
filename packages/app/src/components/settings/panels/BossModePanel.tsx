import { useLingui } from "@lingui/solid"
import { Show } from "solid-js"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingRow"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { RuntimeStore } from "../types"

/* Boss Mode */
const bossPageTitle = { id: "settings.runtime.boss.title", message: "Boss Mode" }
const bossPageDesc = {
  id: "settings.runtime.boss.desc",
  message:
    "Turn this Synergy instance into a colleague: auto-create a runtime boss session and route all Feishu messages to it.",
}
const bossRowDesc = {
  id: "settings.runtime.boss.enabled.desc",
  message: "Route all Feishu messages to the runtime boss session",
}
const identityRowTitle = { id: "settings.runtime.boss.identity", message: "Colleague Identity" }
const identityRowDesc = {
  id: "settings.runtime.boss.identity.desc",
  message: "Optional colleague identity description injected into the runtime boss session.",
}
const identityPlaceholder = {
  id: "settings.runtime.boss.identity.placeholder",
  message: "e.g. Product-minded operator who triages Feishu requests",
}
const intervalRowTitle = { id: "settings.runtime.boss.interval", message: "World Overview Briefing Interval (days)" }
const intervalRowDesc = {
  id: "settings.runtime.boss.interval.desc",
  message: "Re-inject the versioned world-overview briefing every N days; leave empty to disable.",
}

export function BossModePanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
}) {
  const { _ } = useLingui()
  const enabled = () => props.runtime.bossMode === "true"
  return (
    <SettingsPage title={_(bossPageTitle)} description={_(bossPageDesc)}>
      <SettingsSection>
        <SettingRow
          title={_(bossPageTitle)}
          description={_(bossRowDesc)}
          trailing={
            <Switch
              checked={props.runtime.bossMode === "true"}
              onChange={(value) => props.onRuntimeChange("bossMode", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title={_(identityRowTitle)}
          description={_(identityRowDesc)}
          trailing={
            <TextField
              type="text"
              multiline
              value={props.runtime.bossIdentityText}
              placeholder={_(identityPlaceholder)}
              disabled={!enabled()}
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("bossIdentityText", value)}
            />
          }
        />
        <Show when={enabled()}>
          <SettingRow
            title={_(intervalRowTitle)}
            description={_(intervalRowDesc)}
            trailing={
              <TextField
                type="number"
                min="1"
                step="1"
                value={props.runtime.bossBriefingIntervalDays}
                placeholder="7"
                class="settings-row-control-text"
                onChange={(value) => props.onRuntimeChange("bossBriefingIntervalDays", value)}
              />
            }
          />
        </Show>
      </SettingsSection>
    </SettingsPage>
  )
}
