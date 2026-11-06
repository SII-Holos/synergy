import { createEffect, createSignal, on, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { hasIcon } from "@ericsanchezok/synergy-ui/plugin/icon-registry"
import { useLingui } from "@lingui/solid"

type MarketplaceIcon = { type: "lucide"; name: string } | { type: "image"; url: string; alt?: string }

type PluginIconSource = {
  keywords: string[]
  name: string
  icon?: MarketplaceIcon
}

export function MarketplacePluginIcon(props: { plugin: PluginIconSource | null | undefined; class: string }) {
  const { _ } = useLingui()
  const [imageFailed, setImageFailed] = createSignal(false)
  const [imageLoaded, setImageLoaded] = createSignal(false)
  const icon = () => props.plugin?.icon
  const imageIcon = () => {
    const current = icon()
    return current?.type === "image" ? current : undefined
  }
  const visibleImageIcon = () => (imageFailed() ? undefined : imageIcon())
  const lucideName = () => {
    const current = icon()
    return current?.type === "lucide" && hasIcon(current.name) ? current.name : undefined
  }
  createEffect(
    on(
      () => imageIcon()?.url,
      () => {
        setImageFailed(false)
        setImageLoaded(false)
      },
    ),
  )
  const initial = () => Array.from(props.plugin?.name.trim() ?? "")[0]?.toLocaleUpperCase() ?? "?"

  const imageAlt = () => {
    const current = imageIcon()
    if (current?.alt) return current.alt
    const name = props.plugin?.name
    if (name) return _({ id: "app.plugin.icon.alt", message: "{name} icon", values: { name } })
    return _({ id: "app.plugin.icon.alt.generic", message: "Plugin icon" })
  }

  return (
    <span class={props.class} data-image={(!!visibleImageIcon() && imageLoaded()) || undefined}>
      <Show
        when={visibleImageIcon()}
        fallback={
          <Show
            when={lucideName()}
            fallback={
              <span class="plugin-marketplace-monogram" aria-hidden="true">
                {initial()}
              </span>
            }
          >
            {(name) => (
              <Icon name={name() as Parameters<typeof Icon>[0]["name"]} size="normal" class="text-icon-base" />
            )}
          </Show>
        }
      >
        {(current) => (
          <>
            <Show when={!imageLoaded()}>
              <span class="plugin-marketplace-monogram" aria-hidden="true">
                {initial()}
              </span>
            </Show>
            <img
              src={current().url}
              alt={imageAlt()}
              class="plugin-marketplace-icon-image"
              style={{ visibility: imageLoaded() ? "visible" : "hidden" }}
              loading="lazy"
              decoding="async"
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
            />
          </>
        )}
      </Show>
    </span>
  )
}
