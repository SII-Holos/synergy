import { createSignal, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useLingui } from "@lingui/solid"

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
  const { _ } = useLingui()
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

  const imageAlt = () => {
    const current = imageIcon()
    if (current?.alt) return current.alt
    const name = props.plugin?.name
    if (name) return _({ id: "app.plugin.icon.alt", message: "{name} icon", values: { name } })
    return _({ id: "app.plugin.icon.alt.generic", message: "Plugin icon" })
  }

  return (
    <span class={props.class}>
      <Show
        when={visibleImageIcon()}
        fallback={
          <Icon name={lucideName() as Parameters<typeof Icon>[0]["name"]} size="normal" class="text-icon-weak-base" />
        }
      >
        {(current) => (
          <img
            src={current().url}
            alt={imageAlt()}
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
