import { createSignal, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

type MarketplaceIcon = { type: "lucide"; name: string } | { type: "image"; url: string; alt?: string }

type PluginIconSource = {
  keywords: string[]
  name: string
  icon?: MarketplaceIcon
}

function fallbackPluginIcon(plugin: PluginIconSource | null | undefined) {
  const keywords = plugin?.keywords.map((item) => item.toLowerCase()) ?? []
  if (keywords.some((item) => item.includes("image") || item.includes("meme"))) return "image"
  if (keywords.some((item) => item.includes("frontend") || item.includes("ui"))) return "layout-grid"
  if (keywords.some((item) => item.includes("hash") || item.includes("password") || item.includes("id")))
    return "fingerprint"
  return "package"
}

export function MarketplacePluginIcon(props: { plugin: PluginIconSource | null | undefined; class: string }) {
  const [imageFailed, setImageFailed] = createSignal(false)
  const icon = () => props.plugin?.icon
  const imageIcon = () => {
    const current = icon()
    return current?.type === "image" ? current : undefined
  }
  const visibleImageIcon = () => (imageFailed() ? undefined : imageIcon())
  const lucideName = () => {
    const current = icon()
    return current?.type === "lucide" ? current.name : fallbackPluginIcon(props.plugin)
  }

  return (
    <span class={props.class}>
      <Show
        when={visibleImageIcon()}
        fallback={
          <Icon name={lucideName() as Parameters<typeof Icon>[0]["name"]} size="normal" class="text-icon-weak" />
        }
      >
        {(current) => (
          <img
            src={current().url}
            alt={current().alt ?? `${props.plugin?.name ?? "Plugin"} icon`}
            class="plugin-marketplace-icon-image"
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        )}
      </Show>
    </span>
  )
}
