import { For, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { McpEntry } from "../types"
import { McpCard } from "../components/McpCard"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

export function McpPanel(props: {
  entries: McpEntry[]
  onAdd: () => void
  onChange: (index: number, field: string, value: string | boolean) => void
  onRemove: (index: number) => void
}) {
  return (
    <SettingsPage
      title="MCP"
      description="Connect local or remote tool servers that Synergy can use during sessions."
      actions={
        <Button
          type="button"
          variant="secondary"
          size="small"
          icon={getSemanticIcon("action.add")}
          onClick={props.onAdd}
        >
          Add server
        </Button>
      }
    >
      <SettingsSection
        title="Servers"
        description="Each server adds tools or prompts from a trusted local command or remote endpoint."
      >
        <Show
          when={props.entries.length > 0}
          fallback={
            <div class="settings-integration-empty">
              <Icon name={getSemanticIcon("mcp.main")} size="normal" />
              <div>
                <div class="settings-integration-empty-title">No MCP servers yet</div>
                <div class="settings-integration-empty-copy">Add a server when a workflow needs external tools.</div>
              </div>
            </div>
          }
        >
          <div class="settings-mcp-list">
            <For each={props.entries}>
              {(entry, index) => (
                <McpCard
                  entry={entry}
                  onChange={(field, value) => props.onChange(index(), field, value)}
                  onRemove={() => props.onRemove(index())}
                />
              )}
            </For>
          </div>
        </Show>
      </SettingsSection>
    </SettingsPage>
  )
}
