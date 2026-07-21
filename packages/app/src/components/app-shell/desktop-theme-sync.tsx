import { createEffect } from "solid-js"
import { deriveShellSkin, useTheme } from "@ericsanchezok/synergy-ui/theme"
import { usePlatform } from "@/context/platform"

export function DesktopThemeSync() {
  const theme = useTheme()
  const platform = usePlatform()

  createEffect(() => {
    const source = theme.colorScheme()
    const shell = deriveShellSkin(theme.theme())
    void platform.desktopTheme
      ?.set({ source, themeId: theme.themeId(), light: shell.light, dark: shell.dark })
      .catch(() => undefined)
  })

  return null
}
