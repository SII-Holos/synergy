import { createEffect, createUniqueId, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { McpEntry } from "../types"
import { SettingsAdvanced } from "./SettingsPrimitives"
import { SettingRow } from "./SettingsSettingRow"

const nameLabel = { id: "settings.mcp.card.serverName", message: "Server name" }
const typeLabel = { id: "settings.mcp.card.connectionType", message: "Connection type" }
const localLabel = { id: "settings.mcp.card.type.local", message: "Local command" }
const remoteLabel = { id: "settings.mcp.card.type.remote", message: "Remote endpoint" }
const commandLabel = { id: "settings.mcp.card.startCommand", message: "Start command" }
const urlLabel = { id: "settings.mcp.card.serverUrl", message: "Server URL" }
const timeoutLabel = { id: "settings.mcp.editor.timeout", message: "Timeout (ms)" }
const visibilityLabel = { id: "settings.mcp.editor.visibility", message: "Always show tools to the model" }

function McpPairs(props: {
  kind: "headers" | "environment"
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  const { _ } = useLingui()
  const separator = () => (props.kind === "headers" ? ":" : "=")
  const [rows, setRows] = createStore<{ id: string; name: string; value: string }[]>([])
  let emitted: string | undefined
  let region: HTMLDivElement | undefined
  const descriptionID = createUniqueId()
  const errorID = createUniqueId()
  createEffect(() => {
    if (props.value === emitted) return
    setRows(
      props.value
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          const index = line.indexOf(separator())
          return {
            id: createUniqueId(),
            name: (index < 0 ? line : line.slice(0, index)).trim(),
            value: index < 0 ? "" : line.slice(index + 1).trim(),
          }
        }),
    )
  })
  function emit() {
    emitted = rows.map((row) => `${row.name}${separator()}${row.value}`).join("\n")
    props.onChange(emitted)
  }
  function add() {
    setRows(rows.length, { id: createUniqueId(), name: "", value: "" })
    requestAnimationFrame(() => region?.querySelectorAll<HTMLInputElement>("input")[rows.length * 2 - 2]?.focus())
  }
  function remove(index: number) {
    setRows(rows.filter((_, current) => current !== index))
    emit()
    requestAnimationFrame(() => {
      const inputs = region?.querySelectorAll<HTMLInputElement>("input")
      const target =
        inputs?.[Math.min(index, rows.length - 1) * 2] ?? region?.querySelector<HTMLButtonElement>("button")
      target?.focus()
    })
  }
  const name = (index: number) =>
    props.kind === "headers"
      ? _({
          id: "settings.mcp.editor.header.name",
          message: "Request header {index} name",
          values: { index: index + 1 },
        })
      : _({
          id: "settings.mcp.editor.environment.name",
          message: "Environment variable {index} name",
          values: { index: index + 1 },
        })
  const value = (index: number) =>
    props.kind === "headers"
      ? _({
          id: "settings.mcp.editor.header.value",
          message: "Request header {index} value",
          values: { index: index + 1 },
        })
      : _({
          id: "settings.mcp.editor.environment.value",
          message: "Environment variable {index} value",
          values: { index: index + 1 },
        })
  return (
    <div class="settings-mcp-pairs" ref={region}>
      <div class="settings-mcp-field-heading">
        <h2>
          {props.kind === "headers"
            ? _({ id: "settings.mcp.editor.headers", message: "Request headers" })
            : _({ id: "settings.mcp.editor.environment", message: "Environment variables" })}
        </h2>
        <span>{_({ id: "settings.mcp.editor.optional", message: "Optional" })}</span>
      </div>
      <p class="ds-section-hint" id={descriptionID}>
        {props.kind === "headers"
          ? _({
              id: "settings.mcp.editor.headers.description",
              message: "Include authentication or other headers required by this server.",
            })
          : _({ id: "settings.mcp.editor.environment.description", message: "Passed only to this server process." })}
      </p>
      <For each={rows}>
        {(row, index) => (
          <div class="settings-mcp-pair">
            <TextField
              label={name(index())}
              hideLabel
              placeholder={_({ id: "settings.mcp.editor.pair.name", message: "Name" })}
              aria-describedby={props.error ? `${descriptionID} ${errorID}` : descriptionID}
              value={row.name}
              validationState={props.error ? "invalid" : "valid"}
              onChange={(value) => {
                setRows(index(), "name", value)
                emit()
              }}
            />
            <TextField
              label={value(index())}
              hideLabel
              placeholder={_({ id: "settings.mcp.editor.pair.value", message: "Value" })}
              aria-describedby={descriptionID}
              value={row.value}
              onChange={(value) => {
                setRows(index(), "value", value)
                emit()
              }}
            />
            <IconButton
              type="button"
              variant="ghost"
              icon={getSemanticIcon("action.remove")}
              aria-label={
                props.kind === "headers"
                  ? _({
                      id: "settings.mcp.editor.header.remove",
                      message: "Remove request header: {name}",
                      values: { name: row.name || index() + 1 },
                    })
                  : _({
                      id: "settings.mcp.editor.environment.remove",
                      message: "Remove environment variable: {name}",
                      values: { name: row.name || index() + 1 },
                    })
              }
              onClick={() => remove(index())}
            />
          </div>
        )}
      </For>
      <Show when={props.error}>
        <p class="settings-mcp-field-error" id={errorID} role="alert">
          <Icon name={getSemanticIcon("state.error")} size="small" />
          {props.error}
        </p>
      </Show>
      <Button type="button" size="small" variant="secondary" icon={getSemanticIcon("action.add")} onClick={add}>
        {props.kind === "headers"
          ? _({ id: "settings.mcp.editor.header.add", message: "Add request header" })
          : _({ id: "settings.mcp.editor.environment.add", message: "Add environment variable" })}
      </Button>
    </div>
  )
}

export function McpEditor(props: {
  entry: McpEntry
  viewID: string
  fieldError?: (field: string) => string | undefined
  onChange: (field: string, value: string | boolean) => void
}) {
  const { _ } = useLingui()
  const error = (field: string) => props.fieldError?.(field)
  return (
    <div class="settings-mcp-form">
      <div class="settings-mcp-form-heading">
        <TextField
          label={_(nameLabel)}
          required
          value={props.entry.key}
          placeholder={_({ id: "settings.mcp.editor.name.placeholder", message: "My server" })}
          error={error("key")}
          validationState={error("key") ? "invalid" : "valid"}
          onChange={(value) => props.onChange("key", value)}
        />
        <div class="settings-mcp-type-field">
          <span class="settings-mcp-field-label">{_(typeLabel)}</span>
          <MenuField
            ariaLabel={_(typeLabel)}
            value={props.entry.type}
            options={[
              { value: "local", label: _(localLabel) },
              { value: "remote", label: _(remoteLabel) },
            ]}
            onChange={(value) => props.onChange("type", value)}
          />
        </div>
      </div>
      <Show
        when={props.entry.type === "remote"}
        fallback={
          <TextField
            label={_(commandLabel)}
            required
            value={props.entry.command}
            placeholder="npx -y my-mcp-server"
            description={_({
              id: "settings.mcp.editor.command.description",
              message: "Runs on the machine hosting Synergy. Use a command from a trusted source.",
            })}
            error={error("command")}
            validationState={error("command") ? "invalid" : "valid"}
            onChange={(value) => props.onChange("command", value)}
          />
        }
      >
        <TextField
          label={_(urlLabel)}
          type="url"
          required
          value={props.entry.url}
          placeholder="https://mcp.example.com/mcp"
          error={error("url")}
          validationState={error("url") ? "invalid" : "valid"}
          onChange={(value) => props.onChange("url", value)}
        />
      </Show>
      <Show keyed when={props.entry.type}>
        {(type) => (
          <McpPairs
            kind={type === "remote" ? "headers" : "environment"}
            value={type === "remote" ? props.entry.headers : props.entry.environment}
            error={error(type === "remote" ? "headers" : "environment")}
            onChange={(value) => props.onChange(type === "remote" ? "headers" : "environment", value)}
          />
        )}
      </Show>
      <SettingsAdvanced
        id={props.viewID}
        title={_({ id: "settings.mcp.editor.advanced", message: "Advanced options" })}
        fields={[_(timeoutLabel), _(visibilityLabel)]}
        forceOpen={Boolean(error("timeout"))}
      >
        <SettingRow
          title={_(timeoutLabel)}
          description={_({
            id: "settings.mcp.editor.timeout.description",
            message: "Leave empty to use the default timeout.",
          })}
          trailing={
            <TextField
              type="number"
              min="1"
              step="1"
              value={props.entry.timeout}
              placeholder="30000"
              error={error("timeout")}
              validationState={error("timeout") ? "invalid" : "valid"}
              onChange={(value) => props.onChange("timeout", value)}
            />
          }
        />
        <SettingRow
          title={_(visibilityLabel)}
          description={_({
            id: "settings.mcp.editor.visibility.description",
            message: "Otherwise, tools are grouped and discovered when needed.",
          })}
          trailing={
            <Switch
              hideLabel
              checked={props.entry.expandByDefault}
              onChange={(value) => props.onChange("expandByDefault", value)}
            >
              {_(visibilityLabel)}
            </Switch>
          }
        />
      </SettingsAdvanced>
    </div>
  )
}
