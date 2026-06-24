import { createSignal, For, createEffect } from "solid-js"

interface DeclarativeSettingsFormProps {
  schema: Record<string, unknown>
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => Promise<void>
}

export function DeclarativeSettingsForm(props: DeclarativeSettingsFormProps) {
  const [local, setLocal] = createSignal(props.values)
  let debounceTimer: ReturnType<typeof setTimeout>

  createEffect(() => {
    setLocal(props.values)
  })

  function handleChange(key: string, value: unknown) {
    setLocal((prev) => ({ ...prev, [key]: value }))
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void props.onChange(local())
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
          value={(local()[key] as string) ?? ""}
          onChange={(e) => handleChange(key, e.currentTarget.value)}
          class="w-full rounded-md border border-border-base bg-background-base px-3 py-2 text-14-regular text-text-strong"
        >
          <For each={fieldSchema.enum as string[]}>{(v) => <option value={v}>{v}</option>}</For>
        </select>
      )
    } else if (fieldType === "boolean") {
      input = (
        <input
          type="checkbox"
          checked={!!local()[key]}
          onChange={(e) => handleChange(key, e.currentTarget.checked)}
          class="h-4 w-4 rounded border-border-base"
        />
      )
    } else if (fieldType === "number") {
      input = (
        <input
          type="number"
          value={(local()[key] as number | string) ?? ""}
          onChange={(e) => handleChange(key, Number(e.currentTarget.value))}
          class="w-full rounded-md border border-border-base bg-background-base px-3 py-2 text-14-regular text-text-strong"
        />
      )
    } else if (fieldSchema.format === "password") {
      input = (
        <input
          type="password"
          value={(local()[key] as string) ?? ""}
          onChange={(e) => handleChange(key, e.currentTarget.value)}
          class="w-full rounded-md border border-border-base bg-background-base px-3 py-2 text-14-regular text-text-strong"
        />
      )
    } else {
      input = (
        <input
          type="text"
          value={(local()[key] as string) ?? ""}
          onChange={(e) => handleChange(key, e.currentTarget.value)}
          class="w-full rounded-md border border-border-base bg-background-base px-3 py-2 text-14-regular text-text-strong"
        />
      )
    }

    return (
      <div class="settings-field">
        <label class="block text-13-medium text-text-strong mb-1">{fieldTitle}</label>
        {showDescription && <p class="text-12-regular text-text-weak mb-2">{fieldDescription}</p>}
        {input}
      </div>
    )
  })

  return <div class="declarative-settings-form flex flex-col gap-4">{fields}</div>
}
