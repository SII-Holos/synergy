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
      zoom?: Platform["desktopZoom"]
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
  buildLabel: import.meta.env.VITE_SYNERGY_BUILD_LABEL,
  browserNative: window.synergyDesktop?.browserNative,
  desktopUpdate: window.synergyDesktop?.update,
  desktopServer: window.synergyDesktop?.server,
  desktopWindow: window.synergyDesktop?.window,
  desktopTheme: window.synergyDesktop?.theme,
  desktopBadge: window.synergyDesktop?.badge,
  desktopZoom: window.synergyDesktop?.zoom,
  clipboard: window.synergyDesktop?.clipboard,
  openDirectoryPickerDialog: window.synergyDesktop?.openDirectoryPickerDialog,
  openLink(url: string) {
    if (window.synergyDesktop?.shell) {
      void window.synergyDesktop.shell.openExternal(url)
      return
    }
    window.open(url, "_blank", "noopener,noreferrer")
  },
  restart: async () => {
    window.location.reload()
  },
  notify: async (title, description, href, tag) => {
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
          // Same tag as the service-worker push notification: the desktop
          // page notification and the Web Push delivery collapse into one.
          ...(tag ? { tag } : {}),
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

// Register the push service worker on capable, secure contexts. The worker
// only handles push/notificationclick; it never intercepts fetch. Failures
// are silent: browsers without service workers keep working unchanged.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined)
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data
    if (!data || data.type !== "push-navigate" || typeof data.href !== "string") return
    if (!data.href.startsWith("/")) return
    window.history.pushState(null, "", data.href)
    window.dispatchEvent(new PopStateEvent("popstate"))
  })
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
