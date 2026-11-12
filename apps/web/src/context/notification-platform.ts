import type { NotificationActivation } from "./platform"
import { BRAND_ASSETS, brandAssetPath } from "../utils/brand-assets"

export async function notifyBrowser(
  title: string,
  description?: string,
  href?: string,
  tag?: string,
  activation?: NotificationActivation,
) {
  const activate = typeof activation?.activate === "function" ? activation.activate.bind(activation) : undefined
  const current = typeof activation?.current === "function" ? activation.current.bind(activation) : undefined
  const valid = () => !activation || (!!activate && !!current && current())
  if (!valid()) return
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (!valid() || permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  await Promise.resolve()
    .then(() => {
      if (!valid()) return
      const notification = new Notification(title, {
        body: description ?? "",
        icon: brandAssetPath(BRAND_ASSETS.synergy.notificationIcon),
        // Same tag as the service-worker push notification: the desktop
        // page notification and the Web Push delivery collapse into one.
        ...(tag ? { tag } : {}),
      })
      notification.onclick = () => {
        try {
          if (!valid()) return
          window.focus()
          if (activation) activate?.()
          else if (href) {
            window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
        } finally {
          notification.close()
        }
      }
    })
    .catch(() => undefined)
}
