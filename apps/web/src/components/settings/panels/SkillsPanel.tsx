import { settingsFieldCopy } from "../settings-field-copy"
import { createMemo } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { SkillList } from "@ericsanchezok/synergy-sdk/client"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingsSettingRow"
import { SettingsPage, SettingsSection, SettingsAdvanced } from "../components/SettingsPrimitives"
import type { SkillsSettings } from "../types"

export type SkillSourceKey = keyof SkillsSettings

const pageTitle = { id: "settings.skills.page.title", message: "Skills" }
const pageDesc = {
  id: "settings.skills.page.desc",
  message: "Choose which other agent tools Synergy discovers skills from.",
}
const sectionTitle = { id: "settings.skills.section.title", message: "Compatibility" }
const skillCountBadge = {
  id: "settings.skills.row.count",
  message: "{count, plural, one {# skill} other {# skills}}",
}

const agentsTitle = settingsFieldCopy.skillsAgents
const agentsDesc = {
  id: "settings.skills.agents.desc",
  message: "Discover Agent Skills available on this device.",
}
const claudeTitle = settingsFieldCopy.skillsClaude
const claudeDesc = {
  id: "settings.skills.claude.desc",
  message: "Discover Claude Code skills available on this device.",
}
const codexTitle = settingsFieldCopy.skillsCodex
const codexDesc = {
  id: "settings.skills.codex.desc",
  message: "Discover Codex skills available on this device.",
}
const openclawTitle = settingsFieldCopy.skillsOpenclaw
const openclawDesc = {
  id: "settings.skills.openclaw.desc",
  message: "Discover OpenClaw skills available on this device.",
}

export function SkillsPanel(props: {
  skills: SkillsSettings
  sources: SkillList["sources"]
  onSkillsChange: (source: SkillSourceKey, value: boolean) => void
}) {
  const { _ } = useLingui()
  const sourceCounts = createMemo(() => {
    const map = new Map<string, number>()
    for (const entry of props.sources) map.set(entry.source, entry.count)
    return map
  })
  const countLabel = (source: SkillSourceKey) => {
    const count = sourceCounts().get(source)
    if (count === undefined) return undefined
    return _({ ...skillCountBadge, values: { count } })
  }

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDesc)}>
      <SettingsSection title={_(sectionTitle)}>
        <SettingRow
          title={_(agentsTitle)}
          description={_(agentsDesc)}
          stateLabel={countLabel("agents")}
          trailing={
            <Switch checked={props.skills.agents} onChange={(value) => props.onSkillsChange("agents", value)} />
          }
        />
        <SettingRow
          title={_(claudeTitle)}
          description={_(claudeDesc)}
          stateLabel={countLabel("claude")}
          trailing={
            <Switch checked={props.skills.claude} onChange={(value) => props.onSkillsChange("claude", value)} />
          }
        />
        <SettingRow
          title={_(codexTitle)}
          description={_(codexDesc)}
          stateLabel={countLabel("codex")}
          trailing={<Switch checked={props.skills.codex} onChange={(value) => props.onSkillsChange("codex", value)} />}
        />
        <SettingRow
          title={_(openclawTitle)}
          description={_(openclawDesc)}
          stateLabel={countLabel("openclaw")}
          trailing={
            <Switch checked={props.skills.openclaw} onChange={(value) => props.onSkillsChange("openclaw", value)} />
          }
        />
      </SettingsSection>
      <SettingsAdvanced
        id="skill-directories"
        title={_({ id: "settings.skills.directories", message: "Discovery directories" })}
      >
        <p class="ds-section-hint">
          {_({
            id: "settings.skills.directories.description",
            message:
              "Agent Skills: .agents/skills. Claude Code: .claude/skills. Codex: .codex/skills. OpenClaw: .openclaw/skills and workspace skills directories.",
          })}
        </p>
      </SettingsAdvanced>
    </SettingsPage>
  )
}
