import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { McpStatus } from "@ericsanchezok/synergy-sdk/client"
import { mcpStatusCopy, mcpStatusError } from "@/components/mcp/status-presentation"
import { apiKeyClearPending, builtinKeyChip } from "@/components/mcp/builtin-key-presentation"
import type { BuiltinMcpDraft, McpEntry } from "../types"
import { McpCard } from "../components/McpCard"
import { McpEditor } from "../components/McpEditor"
import { useSettingsViewState } from "../settings-view-state"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

const emptyTitle = { id: "settings.mcp.empty.title", message: "No MCP servers yet" }
const emptyCopy = { id: "settings.mcp.empty.copy", message: "Add a server when a workflow needs external tools." }
const pageTitle = { id: "settings.mcp.page.title", message: "MCP" }
const pageDescription = {
  id: "settings.mcp.page.description",
  message: "Connect local or remote tool servers that Synergy can use during sessions.",
}
const addServerLabel = { id: "settings.mcp.addServer", message: "Add server" }
const sectionTitle = { id: "settings.mcp.section.title", message: "Custom servers" }
const builtinsSectionTitle = { id: "settings.mcp.builtins.section.title", message: "Built-in servers" }
const builtinsSectionDescription = {
  id: "settings.mcp.builtins.section.description",
  message: "Shipped with Synergy and usable without an API key. Turning one off disables its tools.",
}
const builtinBadgeLabel = { id: "settings.mcp.builtins.badge", message: "Built-in" }
const apiKeyLabel = { id: "settings.mcp.builtins.apiKey.label", message: "API key" }
const apiKeyDescription = {
  id: "settings.mcp.builtins.apiKey.description",
  message: "Optional. Sent as a Bearer token to raise rate limits beyond the anonymous quota.",
}
const apiKeyPlaceholder = { id: "settings.mcp.builtins.apiKey.placeholder", message: "Paste key to raise rate limits" }
const apiKeyReplacePlaceholder = {
  id: "settings.mcp.builtins.apiKey.replace",
  message: "Paste a new key to replace the saved one",
}
const apiKeyClearLabel = { id: "settings.mcp.builtins.apiKey.clear", message: "Clear stored key" }
const apiKeyClearUndoLabel = { id: "settings.mcp.builtins.apiKey.clearUndo", message: "Keep stored key" }

export function McpPanel(props: {
  entries: McpEntry[]
  builtins?: BuiltinMcpDraft[]
  /** Live connection status by server name; falls back to the catalog snapshot. */
  statuses?: Record<string, McpStatus>
  entryUnsaved?: (entry: McpEntry) => boolean
  fieldError?: (index: number, field: string) => string | undefined
  revealIndex?: number
  onRevealed?: () => void
  onAdd: () => void
  onChange: (index: number, field: string, value: string | boolean) => void
  onRemove: (index: number) => void
  onBuiltinToggle?: (name: string, value: boolean) => void
  onBuiltinApiKeyChange?: (name: string, value: string) => void
  onBuiltinClearKey?: (name: string, cleared: boolean) => void
}) {
  const { _ } = useLingui()
  const viewState = useSettingsViewState()
  const savedView = viewState?.view?.("mcp-editor")
  const [selected, setSelected] = createSignal<number | undefined>(savedView ? Number(savedView) : undefined)
  const [query, setQuery] = createSignal(viewState?.view?.("mcp-search") ?? "")
  const filtered = createMemo(() =>
    props.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) =>
        `${entry.key} ${entry.type === "local" ? entry.command : entry.url}`
          .toLocaleLowerCase()
          .includes(query().trim().toLocaleLowerCase()),
      ),
  )
  const filteredBuiltins = createMemo(() =>
    (props.builtins ?? []).filter((builtin) =>
      `${builtin.name} ${builtin.url}`.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()),
    ),
  )
  const editing = createMemo(() => (selected() === undefined ? undefined : props.entries[selected()!]))
  const body = () => root?.closest<HTMLElement>(".settings-panel-content")
  let root: HTMLDivElement | undefined
  const savedOrigin = viewState?.view?.("mcp-origin")
  let origin: { index?: number; scroll: number } | undefined =
    savedOrigin === undefined
      ? undefined
      : {
          index: savedOrigin ? Number(savedOrigin) : undefined,
          scroll: Number(viewState?.view?.("mcp-scroll") ?? 0),
        }
  let restoration = 0
  let alive = true
  onCleanup(() => {
    alive = false
    restoration++
  })
  createEffect(() => viewState?.setView?.("mcp-search", query()))
  createEffect(() => viewState?.setView?.("mcp-editor", selected()?.toString() ?? ""))
  createEffect(() => {
    if (props.revealIndex === undefined) return
    edit(props.revealIndex)
    props.onRevealed?.()
  })
  function rememberOrigin(index?: number) {
    origin = { index, scroll: body()?.scrollTop ?? 0 }
    viewState?.setView?.("mcp-origin", index?.toString() ?? "")
    viewState?.setView?.("mcp-scroll", String(origin.scroll))
  }
  function edit(index: number) {
    rememberOrigin(index)
    restoration++
    setSelected(index)
    if (body()) body()!.scrollTop = 0
    requestAnimationFrame(() => root?.querySelector<HTMLInputElement>("input")?.focus())
  }
  function add() {
    const index = props.entries.length
    props.onAdd()
    setQuery("")
    edit(index)
    if (origin) {
      origin.index = undefined
      viewState?.setView?.("mcp-origin", "")
    }
  }
  function back() {
    setSelected(undefined)
    const version = ++restoration
    requestAnimationFrame(async () => {
      const content = body()
      await Promise.allSettled(
        (content?.getAnimations({ subtree: true }) ?? [])
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      )
      if (!alive || version !== restoration) return
      if (content) content.scrollTop = origin?.scroll ?? 0
      const target =
        origin?.index === undefined
          ? root?.querySelector<HTMLButtonElement>("[data-mcp-add]")
          : root?.querySelector<HTMLButtonElement>(`[data-mcp-entry-index="${origin.index}"]`)
      ;(
        target ??
        root?.querySelector<HTMLElement>("input[type=search]") ??
        root?.querySelector<HTMLElement>("[data-mcp-add]")
      )?.focus({ preventScroll: true })
    })
  }
  return (
    <div
      ref={root}
      class="settings-mcp-view"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !editing()) return
        event.preventDefault()
        event.stopPropagation()
        back()
      }}
    >
      <Show
        keyed
        when={editing() ? selected()! + 1 : undefined}
        fallback={
          <SettingsPage
            title={_(pageTitle)}
            description={_(pageDescription)}
            actions={
              <Button
                type="button"
                variant="secondary"
                size="small"
                icon={getSemanticIcon("action.add")}
                data-mcp-add
                onClick={add}
              >
                {_(addServerLabel)}
              </Button>
            }
          >
            <Show when={props.entries.length + (props.builtins?.length ?? 0) > 0}>
              <div class="settings-mcp-search">
                <TextField
                  type="search"
                  label={_({ id: "settings.mcp.search", message: "Search MCP servers" })}
                  hideLabel
                  placeholder={_({ id: "settings.mcp.search", message: "Search MCP servers" })}
                  value={query()}
                  onChange={setQuery}
                />
                <Show when={query()}>
                  <IconButton
                    type="button"
                    variant="ghost"
                    icon={getSemanticIcon("action.clear")}
                    aria-label={_({ id: "settings.mcp.search.clear", message: "Clear server search" })}
                    onClick={() => setQuery("")}
                  />
                </Show>
              </div>
            </Show>
            <Show when={query().trim() && filtered().length + filteredBuiltins().length === 0}>
              <div class="settings-integration-empty">
                <div>
                  <div class="settings-integration-empty-title">
                    {_({ id: "settings.mcp.search.empty", message: "No matching servers" })}
                  </div>
                  <Button type="button" size="small" variant="ghost" onClick={() => setQuery("")}>
                    {_({ id: "settings.mcp.search.clear", message: "Clear server search" })}
                  </Button>
                </div>
              </div>
            </Show>
            <Show when={!query().trim() || filtered().length > 0}>
              <SettingsSection title={_(sectionTitle)}>
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
                    <For each={filtered()}>
                      {({ entry, index }) => (
                        <McpCard
                          entry={entry}
                          index={index}
                          onEdit={() => edit(index)}
                          unsaved={props.entryUnsaved?.(entry) ?? !entry.key.trim()}
                          status={props.statuses?.[entry.key.trim()]}
                          onChange={(field, value) => props.onChange(index, field, value)}
                          onRemove={() => props.onRemove(index)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </SettingsSection>
            </Show>

            <Show when={filteredBuiltins().length > 0}>
              <SettingsSection title={_(builtinsSectionTitle)} description={_(builtinsSectionDescription)}>
                <div class="settings-mcp-list">
                  <For each={filteredBuiltins()}>
                    {(builtin) => {
                      const [expanded, setExpanded] = createSignal(false)
                      const displayName = () => builtin.name.charAt(0).toUpperCase() + builtin.name.slice(1)
                      const keyPendingClear = () => builtin.clearApiKey && builtin.keyConfigured
                      const liveStatus = () => props.statuses?.[builtin.name] ?? builtin.status
                      const copy = () => mcpStatusCopy(builtin.toggle ? liveStatus() : { status: "disabled" }, _)
                      const error = () => (builtin.toggle ? mcpStatusError(liveStatus()) : undefined)
                      const chip = () => builtinKeyChip(builtin, _)
                      return (
                        <section class="settings-mcp-card">
                          <div class="settings-mcp-card-header">
                            <button
                              type="button"
                              class="settings-mcp-summary"
                              data-mcp-builtin={builtin.name}
                              aria-expanded={expanded()}
                              aria-label={_({
                                id: "settings.mcp.card.configure.named",
                                message: "Configure {name}",
                                values: { name: displayName() },
                              })}
                              onClick={() => setExpanded((value) => !value)}
                            >
                              <span class="settings-mcp-icon">
                                <Icon name={getSemanticIcon("mcp.main")} size="small" />
                              </span>
                              <span class="settings-mcp-summary-copy">
                                <span class="settings-mcp-title-row">
                                  <span class="settings-mcp-title truncate">{displayName()}</span>
                                  <span class="settings-mcp-badge">{_(builtinBadgeLabel)}</span>
                                </span>
                                <span class="settings-mcp-subtitle truncate">{builtin.url}</span>
                              </span>
                              <Icon
                                name={getSemanticIcon(expanded() ? "navigation.collapse" : "navigation.expand")}
                                size="small"
                              />
                            </button>
                            <div class="settings-mcp-actions">
                              <span
                                class="settings-mcp-state"
                                data-tone={copy().tone}
                                title={error() ?? copy().description}
                              >
                                {copy().label}
                              </span>
                              <Show when={props.onBuiltinToggle}>
                                <Switch
                                  checked={builtin.toggle}
                                  hideLabel
                                  onChange={(value) => props.onBuiltinToggle?.(builtin.name, value)}
                                >
                                  {_({
                                    id: "settings.mcp.builtins.enable.named",
                                    message: "Enable {name} built-in server",
                                    values: { name: displayName() },
                                  })}
                                </Switch>
                              </Show>
                            </div>
                          </div>
                          <Show when={error()}>
                            <p class="settings-mcp-card-error">{error()}</p>
                          </Show>
                          <Show when={expanded()}>
                            <div class="settings-mcp-builtin-key">
                              <TextField
                                type="password"
                                autocomplete="off"
                                label={`${_(apiKeyLabel)} — ${displayName()}`}
                                description={_(apiKeyDescription)}
                                placeholder={
                                  keyPendingClear()
                                    ? _(apiKeyClearPending)
                                    : builtin.keyConfigured
                                      ? _(apiKeyReplacePlaceholder)
                                      : _(apiKeyPlaceholder)
                                }
                                value={builtin.apiKeyDraft}
                                onChange={(value) => props.onBuiltinApiKeyChange?.(builtin.name, String(value))}
                              />
                              <span class="settings-mcp-key-chip" data-tone={chip().tone}>
                                {chip().label}
                              </span>
                              <Show when={builtin.keyConfigured && props.onBuiltinClearKey && !builtin.apiKeyDraft}>
                                <IconButton
                                  type="button"
                                  variant="ghost"
                                  icon={getSemanticIcon(keyPendingClear() ? "action.add" : "action.remove")}
                                  aria-label={_({
                                    id: "settings.mcp.builtins.key.named",
                                    message: "{action}: {name}",
                                    values: {
                                      action: keyPendingClear() ? _(apiKeyClearUndoLabel) : _(apiKeyClearLabel),
                                      name: displayName(),
                                    },
                                  })}
                                  onClick={() => props.onBuiltinClearKey?.(builtin.name, !builtin.clearApiKey)}
                                />
                              </Show>
                            </div>
                          </Show>
                        </section>
                      )
                    }}
                  </For>
                </div>
              </SettingsSection>
            </Show>
          </SettingsPage>
        }
      >
        {(position) => (
          <SettingsPage
            title={_({ id: "settings.mcp.editor.title", message: "MCP configuration" })}
            description={_({
              id: "settings.mcp.editor.saveHint",
              message: "Save with the Settings footer.",
            })}
            actions={
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon={getSemanticIcon("navigation.back")}
                data-mcp-back
                onClick={back}
              >
                {_({ id: "settings.mcp.editor.back", message: "Back to servers" })}
              </Button>
            }
          >
            <McpEditor
              entry={props.entries[position - 1]!}
              viewID={`mcp-options:${position}`}
              fieldError={(field) => props.fieldError?.(position - 1, field)}
              onChange={(field, value) => props.onChange(position - 1, field, value)}
            />
          </SettingsPage>
        )}
      </Show>
    </div>
  )
}
