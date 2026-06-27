import type { ServerUpdateStatus } from "@ericsanchezok/synergy-sdk/client"
import type { DesktopUpdateStatus } from "@/context/platform"

export type ProductUpdateBusyAction = "check" | "mode" | "download" | "install" | "start-server" | "refresh" | null
export type ProductUpdateNoticeAction = "check" | "download" | "install" | "refresh" | "start-server" | null

export type ProductUpdateNotice = {
  visible: boolean
  title: string
  detail: string
  actionLabel: string | null
  action: ProductUpdateNoticeAction
  progress: number | null
  tone: "neutral" | "active" | "ready" | "error"
  busy: boolean
}

export type ProductUpdateNoticeInput = {
  desktopStatus: DesktopUpdateStatus | null
  serverStatus: ServerUpdateStatus | null
  appVersion: string | undefined
  serverVersion: string | undefined
  busy: ProductUpdateBusyAction
  serverReconnecting: boolean
}

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

export function productUpdateNotice(input: ProductUpdateNoticeInput): ProductUpdateNotice {
  if (input.desktopStatus) {
    const desktop = input.desktopStatus
    if (desktop.phase === "disabled" || desktop.phase === "idle" || desktop.phase === "checking") {
      return hiddenProductUpdateNotice(input.busy)
    }
    if (desktop.phase === "available") {
      return {
        visible: true,
        title: `Synergy ${desktop.availableVersion ?? "update"} available`,
        detail: "Download is ready when you are.",
        actionLabel: "Download",
        action: "download",
        progress: null,
        tone: "ready",
        busy: Boolean(input.busy),
      }
    }
    if (desktop.phase === "downloading") {
      return {
        visible: true,
        title: "Downloading Synergy",
        detail: downloadLabel(desktop),
        actionLabel: null,
        action: null,
        progress: desktop.percent,
        tone: "active",
        busy: Boolean(input.busy),
      }
    }
    if (desktop.phase === "ready") {
      return {
        visible: true,
        title: `Synergy ${desktop.availableVersion ?? "update"} ready`,
        detail: "Restart the app to finish installing.",
        actionLabel: "Restart",
        action: "install",
        progress: 100,
        tone: "ready",
        busy: Boolean(input.busy),
      }
    }
    if (desktop.phase === "installing") {
      return {
        visible: true,
        title: "Installing Synergy",
        detail: desktopUpdateStatusCopy(desktop),
        actionLabel: null,
        action: null,
        progress: null,
        tone: "active",
        busy: Boolean(input.busy),
      }
    }
    if (desktop.phase === "error") {
      return {
        visible: true,
        title: "Update failed",
        detail: desktopUpdateStatusCopy(desktop),
        actionLabel: "Retry",
        action: "check",
        progress: null,
        tone: "error",
        busy: Boolean(input.busy),
      }
    }
  }

  const serverAction = serverUpdateActionState(input.serverStatus)
  if (serverAction === "reconnecting") {
    return {
      visible: true,
      title: "Updating Synergy service",
      detail: input.serverReconnecting
        ? "Waiting for the local service to return."
        : serverUpdateStatusCopy(input.serverStatus),
      actionLabel: null,
      action: null,
      progress: input.serverStatus?.progress ?? null,
      tone: "active",
      busy: Boolean(input.busy),
    }
  }
  if (serverAction === "start") {
    return {
      visible: true,
      title: `Synergy ${input.serverStatus?.latestVersion ?? "update"} available`,
      detail: "Update the local managed service.",
      actionLabel: "Update",
      action: "start-server",
      progress: input.serverStatus?.progress ?? null,
      tone: "ready",
      busy: Boolean(input.busy),
    }
  }
  if (input.serverStatus?.capability === "managed" && input.serverStatus.phase === "error") {
    return {
      visible: true,
      title: "Service update failed",
      detail: serverUpdateStatusCopy(input.serverStatus),
      actionLabel: "Retry",
      action: "check",
      progress: null,
      tone: "error",
      busy: Boolean(input.busy),
    }
  }
  if (webUpdateNeedsRefresh(input.appVersion, input.serverVersion)) {
    return {
      visible: true,
      title: "Web update ready",
      detail: webVersionStatus(input.appVersion, input.serverVersion),
      actionLabel: "Refresh",
      action: "refresh",
      progress: 100,
      tone: "ready",
      busy: Boolean(input.busy),
    }
  }
  return hiddenProductUpdateNotice(input.busy)
}

function hiddenProductUpdateNotice(busy: ProductUpdateBusyAction): ProductUpdateNotice {
  return {
    visible: false,
    title: "",
    detail: "",
    actionLabel: null,
    action: null,
    progress: null,
    tone: "neutral",
    busy: Boolean(busy),
  }
}
