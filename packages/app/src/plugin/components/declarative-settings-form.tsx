import { createSignal, For, Show, createEffect, onCleanup } from "solid-js"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { useLingui } from "@lingui/solid"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { SettingRow } from "@/components/settings/components/SettingRow"

interface DeclarativeSettingsFormProps {
  schema: Record<string, unknown>
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => Promise<void>
}

export function DeclarativeSettingsForm(props: DeclarativeSettingsFormProps) {
  const { _ } = useLingui()
  const [local, setLocal] = createSignal(props.values)
  let committed = props.values
  let debounceTimer: ReturnType<typeof setTimeout>
  const inputClass =
    "workbench-input-surface w-full rounded-lg border border-border-base/40 bg-input-base px-3 py-2 text-14-regular text-text-strong outline-none transition-colors placeholder:text-text-weaker focus-visible:ring-2 focus-visible:ring-border-strong-base/25"

  createEffect(() => {
    committed = props.values
    setLocal(props.values)
  })

  onCleanup(() => clearTimeout(debounceTimer))

  function handleChange(key: string, value: unknown) {
    const next = { ...local(), [key]: value }
    setLocal(next)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void props
        .onChange(next)
        .then(() => {
          committed = next
        })
        .catch((error) => {
          setLocal(committed)
          showToast({
            type: "error",
            title: _({ id: "app.plugin.settings.saveFailed", message: "Setting not saved" }),
            description: error instanceof Error ? error.message : String(error),
          })
        })
    }, 500)
  }

  const properties = (props.schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const fields = Object.entries(properties).map(([key, fieldSchema]) => {
    const fieldType = fieldSchema.type ?? "string"
    const fieldTitle = (fieldSchema.title ?? fieldSchema.description ?? key) as string
    const fieldDescription = fieldSchema.description as string | undefined

    const showDescription = !!fieldDescription && fieldTitle !== fieldDescription

    let input
    if (fieldSchema.enum) {
      input = (
        <select
          id={`plugin-setting-${key}`}
          value={(local()[key] as string) ?? ""}
          onChange={(e) => handleChange(key, e.currentTarget.value)}
          class={inputClass}
        >
          <For each={fieldSchema.enum as string[]}>{(v) => <option value={v}>{v}</option>}</For>
        </select>
      )
    } else if (fieldType === "boolean") {
      input = (
        <Switch checked={!!local()[key]} hideLabel onChange={(checked) => handleChange(key, checked)}>
          {fieldTitle}
        </Switch>
      )
    } else if (fieldType === "number") {
      input = (
        <input
          id={`plugin-setting-${key}`}
          type="number"
          value={(local()[key] as number | string) ?? ""}
          onChange={(e) => handleChange(key, Number(e.currentTarget.value))}
          class={inputClass}
        />
      )
    } else if (fieldSchema.format === "password") {
      input = (
        <input
          id={`plugin-setting-${key}`}
          type="password"
          value={(local()[key] as string) ?? ""}
          onChange={(e) => handleChange(key, e.currentTarget.value)}
          class={inputClass}
        />
      )
    } else {
      input = (
        <input
          id={`plugin-setting-${key}`}
          type="text"
          value={(local()[key] as string) ?? ""}
          onChange={(e) => handleChange(key, e.currentTarget.value)}
          class={inputClass}
        />
      )
    }

    return fieldType === "boolean" ? (
      <SettingRow
        title={fieldTitle}
        description={showDescription ? fieldDescription! : ""}
        stateLabel={
          local()[key]
            ? _({ id: "app.plugin.settings.stateOn", message: "On" })
            : _({ id: "app.plugin.settings.stateOff", message: "Off" })
        }
        trailing={input}
      />
    ) : (
      <div class="settings-field flex flex-col gap-2 py-2">
        <label class="settings-row-title" for={`plugin-setting-${key}`}>
          {fieldTitle}
        </label>
        <Show when={showDescription}>
          <p class="settings-row-description">{fieldDescription}</p>
        </Show>
        {input}
      </div>
    )
  })

  const description = typeof props.schema.description === "string" ? props.schema.description : undefined
  return (
    <div class="declarative-settings-form flex flex-col">
      <Show when={description}>
        <p class="settings-row-description pb-3">{description}</p>
      </Show>
      {fields}
    </div>
  )
}
