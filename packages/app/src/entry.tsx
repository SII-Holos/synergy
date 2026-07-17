// @refresh reload
import { AP } from "@/app-i18n"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { Platform, PlatformProvider } from "@/context/platform"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { schedulePromptAttachmentImagePipelineWarmup } from "@/utils/prompt-attachment"
import { configureClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import pkg from "../package.json"

declare global {
  interface Window {
    synergyDesktop?: Pick<Platform, "platform" | "browserNative" | "clipboard" | "openDirectoryPickerDialog"> & {
      update?: Platform["desktopUpdate"]
      server?: Platform["desktopServer"]
      shell?: {
        openExternal(url: string): Promise<void>
      }
      startup?: {
        appReady(): Promise<boolean>
      }
      theme?: Platform["desktopTheme"]
      window?: Platform["desktopWindow"]
      badge?: Platform["desktopBadge"]
    }
  }
}

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  )
}

const APP_SURFACE_READY_EVENT = "synergy:app-surface-ready"

function scheduleBootShellRemoval() {
  const remove = () => {
    document.getElementById("synergy-app-boot")?.remove()
    void window.synergyDesktop?.startup?.appReady?.()
  }
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(remove)
    return
  }
  window.setTimeout(remove, 0)
}

const platform: Platform = {
  platform: window.synergyDesktop?.platform === "desktop" ? "desktop" : "web",
  version: pkg.version,
  browserNative: window.synergyDesktop?.browserNative,
  desktopUpdate: window.synergyDesktop?.update,
  desktopServer: window.synergyDesktop?.server,
  desktopWindow: window.synergyDesktop?.window,
  desktopTheme: window.synergyDesktop?.theme,
  desktopBadge: window.synergyDesktop?.badge,
  clipboard: window.synergyDesktop?.clipboard,
  openDirectoryPickerDialog: window.synergyDesktop?.openDirectoryPickerDialog,
  openLink(url: string) {
    if (window.synergyDesktop?.shell) {
      void window.synergyDesktop.shell.openExternal(url)
      return
    }
    window.open(url, "_blank")
  },
  restart: async () => {
    window.location.reload()
  },
  notify: async (title, description, href) => {
    if (!("Notification" in window)) return

    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission().catch(() => "denied")
        : Notification.permission

    if (permission !== "granted") return

    const inView = document.visibilityState === "visible" && document.hasFocus()
    if (inView) return

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
          icon: brandAssetPath(BRAND_ASSETS.synergy.notificationIcon),
        })
        notification.onclick = () => {
          window.focus()
          if (href) {
            window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
          notification.close()
        }
      })
      .catch(() => undefined)
  },
}

window.addEventListener(APP_SURFACE_READY_EVENT, scheduleBootShellRemoval, { once: true })

// Clipboard configuration is module-level init; configureClipboard runs once before
// the LocaleProvider tree is mounted, so the strings passed here must be static.
configureClipboard({
  writer: platform.clipboard?.writeText,
  onFailure: (failure) => {
    showToast({
      type: "error",
      title: AP.entryCopyFailed.message,
      description: failure.description ?? AP.entryCopyFailedDetail.message,
    })
  },
})

render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <AppInterface />
      </AppBaseProviders>
    </PlatformProvider>
  ),
  root!,
)

schedulePromptAttachmentImagePipelineWarmup()
