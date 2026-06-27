import type { ServerUpdateStatus } from "@ericsanchezok/synergy-sdk/client"
import type { DesktopUpdateStatus } from "@/context/platform"

export function productUpdateSurface(input: { desktopUpdate?: unknown }) {
  return input.desktopUpdate ? "desktop" : "web"
}

export function webUpdateNeedsRefresh(appVersion: string | undefined, serverVersion: string | undefined) {
  return Boolean(serverVersion && appVersion && serverVersion !== appVersion)
}

export function serverUpdateActionState(status: ServerUpdateStatus | null) {
  if (!status || status.capability !== "managed") return "hidden"
  if (status.phase === "updating" || status.phase === "restarting") return "reconnecting"
  if (status.phase === "available") return "start"
  return "hidden"
}

export function desktopUpdateStatusCopy(status: DesktopUpdateStatus | null) {
  if (!status) return "Loading update status."
  if (status.phase === "disabled") {
    return status.channel === "dev" ? "Dev builds do not use automatic updates." : "Product updates are off."
  }
  if (status.phase === "checking") return "Checking for updates."
  if (status.phase === "available") return `Version ${status.availableVersion ?? "available"} is ready to download.`
  if (status.phase === "downloading")
    return `Downloading update${status.percent == null ? "." : `, ${Math.round(status.percent)}%.`}`
  if (status.phase === "ready") return `Version ${status.availableVersion ?? "available"} is ready to install.`
  if (status.phase === "installing") return "Stopping the local server and installing the update."
  if (status.phase === "error") return status.error ? `Update failed: ${status.error}` : "Update failed."
  return `Current version ${status.currentVersion}.`
}

export function webVersionStatus(appVersion: string | undefined, serverVersion: string | undefined) {
  if (!serverVersion) return "Checking server version."
  if (appVersion && appVersion !== serverVersion) return `Server ${serverVersion} is newer than this Web client.`
  return `Web client is current${appVersion ? ` at ${appVersion}` : ""}.`
}

export function serverUpdateStatusCopy(status: ServerUpdateStatus | null) {
  if (!status) return "Checking server update capability."
  if (status.capability === "remote") return "Server updates are available only from localhost."
  if (status.capability === "not-managed") return "Server runtime is managed outside this Web client."
  if (status.phase === "available") return `Server ${status.latestVersion ?? "update"} is available.`
  if (status.phase === "checking") return "Checking server runtime updates."
  if (status.phase === "updating" || status.phase === "restarting") {
    return "Updating the managed Synergy service. The Web client will reconnect when it returns."
  }
  if (status.phase === "error") return status.error ? `Server update failed: ${status.error}` : "Server update failed."
  if (status.latestVersion) return `Managed server runtime is current at ${status.currentVersion}.`
  return "Managed server runtime can be updated from this browser."
}

export function downloadLabel(status: DesktopUpdateStatus | null) {
  if (!status || status.percent == null) return "Downloading..."
  return `Downloading ${Math.round(status.percent)}%`
}
