import { createSignal, createEffect } from "solid-js"
import { useBrowser } from "./browser-store"

interface Preset {
  label: string
  width: number
  height: number
}

const PRESETS: Preset[] = [
  { label: "Desktop", width: 1280, height: 720 },
  { label: "Tablet", width: 768, height: 1024 },
  { label: "Mobile", width: 375, height: 667 },
]

export function ViewportSelector() {
  const { viewportWidth, viewportHeight, setViewport } = useBrowser()

  const [localWidth, setLocalWidth] = createSignal(String(viewportWidth()))
  const [localHeight, setLocalHeight] = createSignal(String(viewportHeight()))

  createEffect(() => {
    setLocalWidth(String(viewportWidth()))
    setLocalHeight(String(viewportHeight()))
  })

  const selectedPreset = (): string | null => {
    const w = viewportWidth()
    const h = viewportHeight()
    for (const p of PRESETS) {
      if (p.width === w && p.height === h) return p.label
    }
    return null
  }

  function apply() {
    const w = parseInt(localWidth(), 10)
    const h = parseInt(localHeight(), 10)
    if (isNaN(w) || isNaN(h) || w < 1 || h < 1) return
    setViewport(w, h)
  }

  function selectPreset(preset: Preset) {
    setLocalWidth(String(preset.width))
    setLocalHeight(String(preset.height))
    setViewport(preset.width, preset.height)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") apply()
  }

  return (
    <div class="flex items-center gap-1.5 h-9 shrink-0 px-2 border-b border-border-weak-base bg-surface-raised-base">
      <span class="text-11 text-text-weakest shrink-0 select-none font-medium tracking-wide uppercase">Viewport</span>

      <div class="flex items-center gap-0.5">
        {PRESETS.map((preset) => (
          <button
            type="button"
            class="px-1.5 h-6 rounded text-11 transition-colors shrink-0"
            classList={{
              "workbench-selected-surface text-text-strong": selectedPreset() === preset.label,
              "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
                selectedPreset() !== preset.label,
            }}
            onClick={() => selectPreset(preset)}
            aria-label={`${preset.label} ${preset.width}x${preset.height}`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <span class="w-px h-4 bg-border-weak-base/60 shrink-0" />

      <input
        type="number"
        class="w-[58px] h-7 rounded-md bg-surface-inset-base border border-border-weak-base/60 px-2 text-12 text-text-base placeholder:text-text-weakest outline-none focus:border-border-strong-base transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={localWidth()}
        onInput={(e) => setLocalWidth(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="W"
        aria-label="Viewport width"
      />

      <span class="text-11 text-text-weakest shrink-0">×</span>

      <input
        type="number"
        class="w-[58px] h-7 rounded-md bg-surface-inset-base border border-border-weak-base/60 px-2 text-12 text-text-base placeholder:text-text-weakest outline-none focus:border-border-strong-base transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={localHeight()}
        onInput={(e) => setLocalHeight(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="H"
        aria-label="Viewport height"
      />

      <button
        type="button"
        class="flex items-center justify-center h-6 px-2 rounded text-11 text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors shrink-0"
        onClick={apply}
        aria-label="Apply viewport size"
      >
        Apply
      </button>
    </div>
  )
}
