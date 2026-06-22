import { Show, createSignal } from "solid-js"

export type AddressBarProps = {
  activeUrl: () => string
  isLoading: () => boolean
  onNavigate: (url: string) => void
}

export function AddressBar(props: AddressBarProps) {
  let inputEl: HTMLInputElement | undefined

  function handleNavigate() {
    const raw = inputEl?.value.trim() ?? ""
    if (!raw) return
    const url = raw.includes("://") ? raw : `https://${raw}`
    props.onNavigate(url)
    inputEl?.blur()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") handleNavigate()
  }

  return (
    <div class="flex items-center gap-1.5 h-9 shrink-0 px-2 border-b border-border-weak-base bg-surface-raised-base">
      {/* Back */}
      <button
        type="button"
        class="flex items-center justify-center size-7 rounded text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors disabled:opacity-30"
        disabled
        aria-label="Go back"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M9 3L5 7L9 11"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      {/* Forward */}
      <button
        type="button"
        class="flex items-center justify-center size-7 rounded text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors disabled:opacity-30"
        disabled
        aria-label="Go forward"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M5 3L9 7L5 11"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      {/* Reload */}
      <button
        type="button"
        class="flex items-center justify-center size-7 rounded text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
        classList={{ "animate-spin": props.isLoading() }}
        onClick={handleNavigate}
        aria-label="Reload"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M2.5 6.5C3 4 5 2 7.5 2C10 2 12 4 12 6.5C12 9 10 11 7.5 11C5.5 11 3.8 9.7 3.2 7.8"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
          <path
            d="M3 5L1.5 3.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      {/* Address input */}
      <div class="flex-1 min-w-0">
        <input
          ref={inputEl}
          type="text"
          class="w-full h-7 rounded-md bg-surface-inset-base border border-border-weak-base/60 px-2.5 text-12 text-text-base placeholder:text-text-weakest outline-none focus:border-border-strong-base transition-colors"
          value={props.activeUrl()}
          placeholder="Enter URL or search..."
          onKeyDown={handleKeyDown}
        />
      </div>

      {/* Dev server quick-access */}
      <DevServerDropdown />

      {/* Loading indicator */}
      <Show when={props.isLoading()}>
        <span class="block size-2.5 rounded-full bg-surface-interactive-base animate-pulse shrink-0" />
      </Show>
    </div>
  )
}

const DEV_SERVER_URLS = [
  { label: "localhost:3000", url: "http://localhost:3000" },
  { label: "localhost:5173", url: "http://localhost:5173" },
  { label: "localhost:8080", url: "http://localhost:8080" },
]

function DevServerDropdown() {
  const [open, setOpen] = createSignal(false)

  return (
    <div class="relative shrink-0">
      <button
        type="button"
        class="flex items-center justify-center size-7 rounded text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-label="Dev server quick access"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M5 6L7 8L9 6"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <Show when={open()}>
        <div
          class="absolute right-0 top-full mt-1 z-50 min-w-[180px] rounded-lg border border-border-weak-base bg-surface-raised-stronger-non-alpha shadow-lg py-1"
          onClick={() => setOpen(false)}
        >
          {DEV_SERVER_URLS.map((entry) => (
            <button
              type="button"
              class="w-full text-left px-3 py-1.5 text-12 text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
              onClick={() => {
                window.location.href = entry.url
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </Show>
    </div>
  )
}
