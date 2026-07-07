import type { Agent } from "@ericsanchezok/synergy-sdk/client"
import { For, Show } from "solid-js"
import type { AgentsStore } from "../types"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { selectableDefaultAgents } from "./AgentsPanel.model"

export interface AgentsPanelProps {
  value: AgentsStore
  onChange: (value: AgentsStore) => void
  availableAgents: Agent[]
}

export function AgentsPanel(props: AgentsPanelProps) {
  const primaryAgents = () => selectableDefaultAgents(props.availableAgents)
  const selectedAgent = () => props.value.defaultAgent
  const selectedAgentKnown = () => primaryAgents().some((agent) => agent.name === selectedAgent())

  return (
    <SettingsPage
      title="Agents"
      description="Choose the primary agent used for new conversations unless a session overrides it."
    >
      <SettingsSection title="Defaults" description="Set the primary agent that should handle new work by default.">
        <div class="ds-setting-row">
          <div class="ds-setting-copy">
            <div class="ds-setting-label">Default Agent</div>
            <div class="ds-setting-description">
              This updates the default_agent config value. Hidden and subagent definitions are excluded.
            </div>
          </div>
          <select
            value={props.value.defaultAgent}
            onChange={(event) => props.onChange({ defaultAgent: event.currentTarget.value })}
            class="settings-input settings-input--select"
          >
            <Show when={!selectedAgentKnown()}>
              <option value={selectedAgent()}>{selectedAgent()}</option>
            </Show>
            <For each={primaryAgents()}>{(agent) => <option value={agent.name}>{agent.name}</option>}</For>
          </select>
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}
