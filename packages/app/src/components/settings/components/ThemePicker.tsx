import { For } from "solid-js"
import { resolveTheme, type ThemeDefinition } from "@ericsanchezok/synergy-ui/theme"

export function ThemePicker(props: {
  ariaLabel: string
  mode: "light" | "dark"
  themes: ThemeDefinition[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div class="settings-theme-grid" role="radiogroup" aria-label={props.ariaLabel}>
      <For each={props.themes}>
        {(choice) => {
          const tokens = () => resolveTheme(choice.theme)[props.mode]
          return (
            <button
              type="button"
              role="radio"
              aria-checked={props.value === choice.id}
              aria-label={choice.label}
              class="settings-theme-card"
              classList={{ "settings-theme-card-active": props.value === choice.id }}
              onClick={() => props.onChange(choice.id)}
            >
              <span
                class="settings-theme-preview"
                aria-hidden="true"
                style={{
                  "background-color": tokens()["background-base"],
                  "border-color": tokens()["border-base"],
                }}
              >
                <span
                  class="settings-theme-preview-sidebar"
                  style={{ "background-color": tokens()["surface-raised-base"] }}
                >
                  <span style={{ "background-color": tokens()["surface-interactive-solid"] }} />
                  <span style={{ "background-color": tokens()["surface-inset-base"] }} />
                  <span style={{ "background-color": tokens()["surface-inset-base"] }} />
                </span>
                <span class="settings-theme-preview-main">
                  <span
                    class="settings-theme-preview-toolbar"
                    style={{
                      "background-color": tokens()["surface-raised-base"],
                      "border-color": tokens()["border-base"],
                    }}
                  />
                  <span
                    class="settings-theme-preview-line settings-theme-preview-line-strong"
                    style={{ "background-color": tokens()["text-strong"] }}
                  />
                  <span class="settings-theme-preview-line" style={{ "background-color": tokens()["text-weaker"] }} />
                  <span
                    class="settings-theme-preview-line settings-theme-preview-line-short"
                    style={{ "background-color": tokens()["text-weaker"] }}
                  />
                </span>
              </span>
              <span class="settings-theme-card-label">{choice.label}</span>
            </button>
          )
        }}
      </For>
    </div>
  )
}
