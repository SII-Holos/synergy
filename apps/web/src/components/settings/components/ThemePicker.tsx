import { createMemo, createSignal, For } from "solid-js"
import { resolveTheme, type ThemeDefinition } from "@ericsanchezok/synergy-ui/theme"

export function ThemePicker(props: {
  ariaLabel: string
  mode: "light" | "dark"
  themes: ThemeDefinition[]
  value: string
  onChange: (value: string) => void
}) {
  const [focusedIndex, setFocusedIndex] = createSignal(0)
  let cards: HTMLButtonElement[] = []

  function handleKeyDown(event: KeyboardEvent) {
    const current = cards.findIndex((card) => card === document.activeElement)
    if (current === -1) return
    let next = current
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = (current + 1) % cards.length
        break
      case "ArrowUp":
      case "ArrowLeft":
        next = (current - 1 + cards.length) % cards.length
        break
      case "Home":
        next = 0
        break
      case "End":
        next = cards.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    cards[next]?.focus()
    // Radiogroup convention: arrow keys move focus and select in one step.
    props.onChange(props.themes[next].id)
  }

  return (
    <div class="settings-theme-grid" role="radiogroup" aria-label={props.ariaLabel} onKeyDown={handleKeyDown}>
      <For each={props.themes}>
        {(choice, index) => {
          // Resolve the preview tokens once per card per mode instead of
          // re-running the full two-variant resolver for every token read.
          const tokens = createMemo(() => resolveTheme(choice.theme)[props.mode])
          const selected = () => props.value === choice.id
          return (
            <button
              type="button"
              role="radio"
              aria-checked={selected()}
              aria-label={choice.label}
              class="settings-theme-card"
              classList={{ "settings-theme-card-active": selected() }}
              tabIndex={selected() || focusedIndex() === index() ? 0 : -1}
              ref={(element) => {
                cards[index()] = element
              }}
              onFocus={() => setFocusedIndex(index())}
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
