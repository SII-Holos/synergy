import { For, Show, createMemo } from "solid-js"
import { useBrowser, type AssetEntry } from "./browser-store"

const TYPE_LABELS: Record<string, string> = {
  image: "Images",
  script: "Scripts",
  stylesheet: "Stylesheets",
  font: "Fonts",
  media: "Media",
  other: "Other",
}

const TYPE_ICONS: Record<string, string> = {
  image: "●",
  script: "◈",
  stylesheet: "◇",
  font: "◆",
  media: "◎",
  other: "○",
}

const TYPE_ORDER = ["image", "script", "stylesheet", "font", "media", "other"] as const

function getFileExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const lastSlash = pathname.lastIndexOf("/")
    const filename = pathname.slice(lastSlash + 1)
    const dot = filename.lastIndexOf(".")
    return dot === -1 ? "" : filename.slice(dot)
  } catch {
    return ""
  }
}

function shortenUrl(url: string, max = 60): string {
  try {
    const parsed = new URL(url)
    let display = parsed.pathname
    if (display.length > max) {
      const filename = display.slice(display.lastIndexOf("/"))
      const prefix = display.slice(0, max - filename.length - 4)
      display = prefix + "…" + filename
    }
    return display
  } catch {
    return url.length > max ? url.slice(0, max - 3) + "…" : url
  }
}

export function AssetsPanel() {
  const { activeTabId, pageAssets } = useBrowser()

  const entries = createMemo((): AssetEntry[] => {
    const tabId = activeTabId()
    if (!tabId) return []
    return pageAssets[tabId] ?? []
  })

  const grouped = createMemo(() => {
    const groups = new Map<string, AssetEntry[]>()
    for (const t of TYPE_ORDER) groups.set(t, [])
    for (const entry of entries()) {
      const g = groups.get(entry.type)
      if (g) g.push(entry)
    }
    return groups
  })

  const totalCount = () => entries().length

  return (
    <div class="flex flex-col h-full">
      <Show
        when={totalCount() > 0}
        fallback={
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-subtle">No page assets</div>
        }
      >
        <div class="flex-1 overflow-y-auto">
          <For each={TYPE_ORDER}>
            {(type) => {
              const items = () => grouped().get(type) ?? []
              const count = () => items().length
              if (count() === 0) return null
              return (
                <div class="border-b border-border-weaker-base last:border-b-0">
                  <div class="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-surface-raised-base border-b border-border-weak-base text-11-medium text-text-weak uppercase tracking-wider">
                    <span class="text-text-subtle">{TYPE_ICONS[type]}</span>
                    <span>{TYPE_LABELS[type]}</span>
                    <span class="ml-auto tabular-nums text-text-weaker">{count()}</span>
                  </div>
                  <For each={items()}>
                    {(asset) => {
                      const ext = getFileExtension(asset.url)
                      return (
                        <div class="flex items-center gap-2 px-3 py-1 text-12-regular hover:bg-surface-inset-base/40">
                          <span class="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded bg-surface-inset-base text-10-medium text-text-weaker tabular-nums">
                            {ext || "—"}
                          </span>
                          <span class="text-text-strong truncate flex-1" title={asset.url}>
                            {shortenUrl(asset.url, 50)}
                          </span>
                        </div>
                      )
                    }}
                  </For>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
