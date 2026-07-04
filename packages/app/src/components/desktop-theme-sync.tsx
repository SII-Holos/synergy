import { createEffect } from "solid-js"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { usePlatform } from "@/context/platform"

export function DesktopThemeSync() {
  const theme = useTheme()
  const platform = usePlatform()

  createEffect(() => {
    const source = theme.colorScheme()
    void platform.desktopTheme?.set(source).catch(() => undefined)
  })

  return null
}
