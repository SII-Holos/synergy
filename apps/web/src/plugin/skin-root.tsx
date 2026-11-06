import { UIStyleProvider } from "@ericsanchezok/synergy-ui/context/ui-style"
import { createMemo, createSignal, onCleanup, type ParentProps } from "solid-js"
import { skinStyles } from "@ericsanchezok/synergy-ui/plugin/skin"
import { useFontPreference } from "@/context/font-preference"
import { usePluginHost } from "./host"
import { getSkin, subscribeSkins } from "./registries/skin-registry"

export function SkinRoot(props: ParentProps) {
  const host = usePluginHost()
  const font = useFontPreference()
  const [version, setVersion] = createSignal(0)
  onCleanup(subscribeSkins(() => setVersion((value) => value + 1)))
  const media = window.matchMedia("(prefers-reduced-motion: reduce)")
  const [reducedMotion, setReducedMotion] = createSignal(media.matches)
  const updateMotion = () => setReducedMotion(media.matches)
  media.addEventListener("change", updateMotion)
  onCleanup(() => media.removeEventListener("change", updateMotion))
  const entry = createMemo(() => {
    version()
    return host.safeUI ? undefined : getSkin(host.skin.selected())
  })
  const styles = createMemo(() => {
    const active = entry()
    if (!active) return ""
    return skinStyles({
      id: active.id,
      skin: active.definition,
      assets: active.assets,
      mode: host.environment.theme().mode,
      narrow: host.environment.viewport().width < 768,
      reducedMotion: reducedMotion(),
      customFonts: { sans: !!font.appliedFamily("sans"), mono: !!font.appliedFamily("mono") },
    })
  })
  return (
    <UIStyleProvider skinId={entry()?.id ?? "synergy"}>
      <div data-skin-root={entry()?.id ?? "synergy"} style={{ display: "contents" }}>
        <style>{styles()}</style>
        {props.children}
      </div>
    </UIStyleProvider>
  )
}
