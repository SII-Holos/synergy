import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { McpEntry } from "../types"
import { McpCard } from "../components/McpCard"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

const emptyTitle = { id: "settings.mcp.empty.title", message: "No MCP servers yet" }
const emptyCopy = { id: "settings.mcp.empty.copy", message: "Add a server when a workflow needs external tools." }
const pageTitle = { id: "settings.mcp.page.title", message: "MCP" }
const pageDescription = {
  id: "settings.mcp.page.description",
  message: "Connect local or remote tool servers that Synergy can use during sessions.",
}
const addServerLabel = { id: "settings.mcp.addServer", message: "Add server" }
const sectionTitle = { id: "settings.mcp.section.title", message: "Servers" }
const sectionDescription = {
  id: "settings.mcp.section.description",
  message: "Each server adds tools or prompts from a trusted local command or remote endpoint.",
}

export function McpPanel(props: {
  entries: McpEntry[]
  onAdd: () => void
  onChange: (index: number, field: string, value: string | boolean) => void
  onRemove: (index: number) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage
      title={_(pageTitle)}
      description={_(pageDescription)}
      actions={
        <Button
          type="button"
          variant="secondary"
          size="small"
          icon={getSemanticIcon("action.add")}
          onClick={props.onAdd}
        >
          {_(addServerLabel)}
        </Button>
      }
    >
      <SettingsSection title={_(sectionTitle)} description={_(sectionDescription)}>
        <Show
          when={props.entries.length > 0}
          fallback={
            <div class="settings-integration-empty">
              <Icon name={getSemanticIcon("mcp.main")} size="normal" />
              <div>
                <div class="settings-integration-empty-title">{_(emptyTitle)}</div>
                <div class="settings-integration-empty-copy">{_(emptyCopy)}</div>
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
