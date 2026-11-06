import type { MessageDescriptor } from "@lingui/core"
import type { ServerUpdateStatus } from "@ericsanchezok/synergy-sdk/client"
import type { DesktopUpdateStatus } from "@/context/platform"

export type ProductUpdateBusyAction = "check" | "mode" | "download" | "install" | "start-server" | "refresh" | null
export type ProductUpdateNoticeAction = "check" | "download" | "install" | "refresh" | "start-server" | null

export type ProductUpdateNotice = {
  visible: boolean
  title: MessageDescriptor
  detail: MessageDescriptor
  actionLabel: MessageDescriptor | null
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
  webRefreshEnabled?: boolean
  busy: ProductUpdateBusyAction
  serverReconnecting: boolean
}

const updateCopy = {
  statusLoading: { id: "settings.productUpdate.status.loading", message: "Loading update status." },
  devBuildsDisabled: {
    id: "settings.productUpdate.status.devBuildsDisabled",
    message: "Dev builds do not use automatic updates.",
  },
  updatesOff: { id: "settings.productUpdate.status.off", message: "Product updates are off." },
  checking: { id: "settings.productUpdate.status.checking", message: "Checking for updates." },
  updateReadyToDownload: {
    id: "settings.productUpdate.status.readyToDownload",
    message: "An update is ready to download.",
  },
  downloading: { id: "settings.productUpdate.status.downloading", message: "Downloading update." },
  updateReadyToInstall: {
    id: "settings.productUpdate.status.readyToInstall",
    message: "An update is ready to install.",
  },
  installing: {
    id: "settings.productUpdate.status.installing",
    message: "Stopping the local server and installing the update.",
  },
  updateFailed: { id: "settings.productUpdate.status.failed", message: "Update failed." },
  checkingServerVersion: {
    id: "settings.productUpdate.web.checkingServerVersion",
    message: "Checking server version.",
  },
  localDevelopmentServer: {
    id: "settings.productUpdate.web.localDevelopmentServer",
    message: "Connected to local development server.",
  },
  webClientCurrent: { id: "settings.productUpdate.web.current", message: "Web client is current." },
  checkingServerCapability: {
    id: "settings.productUpdate.server.checkingCapability",
    message: "Checking server update capability.",
  },
  serverUpdatesLocalOnly: {
    id: "settings.productUpdate.server.localOnly",
    message: "Server updates are available only from localhost.",
  },
  serverExternallyManaged: {
    id: "settings.productUpdate.server.externallyManaged",
    message: "Server runtime is managed outside this Web client.",
  },
  serverUpdateAvailable: {
    id: "settings.productUpdate.server.updateAvailable",
    message: "A server update is available.",
  },
  checkingServerUpdates: {
    id: "settings.productUpdate.server.checkingUpdates",
    message: "Checking server runtime updates.",
  },
  updatingManagedService: {
    id: "settings.productUpdate.server.updatingManagedService",
    message: "Updating the managed Synergy service. The Web client will reconnect when it returns.",
  },
  serverUpdateFailed: { id: "settings.productUpdate.server.failed", message: "Server update failed." },
  serverCanUpdate: {
    id: "settings.productUpdate.server.canUpdate",
    message: "Managed server runtime can be updated from this browser.",
  },
  noticeFallbackTitle: {
    id: "settings.productUpdate.notice.fallbackTitle",
    message: "Product update available",
  },
  noticeFallbackDetail: {
    id: "settings.productUpdate.notice.fallbackDetail",
    message: "A new version is ready to install.",
  },
  genericUpdateAvailable: {
    id: "settings.productUpdate.notice.genericAvailable",
    message: "Synergy update available",
  },
  genericUpdateReady: {
    id: "settings.productUpdate.notice.genericReady",
    message: "Synergy update ready",
  },
  downloadReady: {
    id: "settings.productUpdate.notice.downloadReady",
    message: "Download is ready when you are.",
  },
  download: { id: "settings.productUpdate.notice.download", message: "Download" },
  downloadingSynergy: {
    id: "settings.productUpdate.notice.downloadingSynergy",
    message: "Downloading Synergy",
  },
  restartToInstall: {
    id: "settings.productUpdate.notice.restartToInstall",
    message: "Restart the app to finish installing.",
  },
  restart: { id: "settings.productUpdate.notice.restart", message: "Restart" },
  installingSynergy: {
    id: "settings.productUpdate.notice.installingSynergy",
    message: "Installing Synergy",
  },
  noticeUpdateFailed: {
    id: "settings.productUpdate.notice.updateFailed",
    message: "Update failed",
  },
  retry: { id: "settings.productUpdate.notice.retry", message: "Retry" },
  updatingService: {
    id: "settings.productUpdate.notice.updatingService",
    message: "Updating Synergy service",
  },
  waitingForService: {
    id: "settings.productUpdate.notice.waitingForService",
    message: "Waiting for the local service to return.",
  },
  updateManagedService: {
    id: "settings.productUpdate.notice.updateManagedService",
    message: "Update the local managed service.",
  },
  update: { id: "settings.productUpdate.notice.update", message: "Update" },
  serviceUpdateFailed: {
    id: "settings.productUpdate.notice.serviceUpdateFailed",
    message: "Service update failed",
  },
  webUpdateReady: {
    id: "settings.productUpdate.notice.webUpdateReady",
    message: "Web update ready",
  },
  refresh: { id: "settings.productUpdate.notice.refresh", message: "Refresh" },
} as const

export function productUpdateSurface(input: { desktopUpdate?: unknown }) {
  return input.desktopUpdate ? "desktop" : "web"
}

export function webUpdateNeedsRefresh(appVersion: string | undefined, serverVersion: string | undefined) {
  if (!appVersion || !serverVersion) return false
  return semverGt(serverVersion, appVersion)
}

export function serverUpdateActionState(status: ServerUpdateStatus | null) {
  if (!status || status.capability !== "managed") return "hidden"
  if (status.phase === "updating" || status.phase === "restarting") return "reconnecting"
  if (status.phase === "available") return "start"
  return "hidden"
}

export function desktopUpdateStatusCopy(status: DesktopUpdateStatus | null): MessageDescriptor {
  if (!status) return updateCopy.statusLoading
  if (status.phase === "disabled") {
    return status.channel === "dev" ? updateCopy.devBuildsDisabled : updateCopy.updatesOff
  }
  if (status.phase === "checking") return updateCopy.checking
  if (status.phase === "available") {
    if (!status.availableVersion) return updateCopy.updateReadyToDownload
    return {
      id: "settings.productUpdate.status.versionReadyToDownload",
      message: "Version {version} is ready to download.",
      values: { version: status.availableVersion },
    }
  }
  if (status.phase === "downloading") {
    if (status.percent == null) return updateCopy.downloading
    return {
      id: "settings.productUpdate.status.downloadingPercent",
      message: "Downloading update, {percent}%.",
      values: { percent: Math.round(status.percent) },
    }
  }
  if (status.phase === "ready") {
    if (!status.availableVersion) return updateCopy.updateReadyToInstall
    return {
      id: "settings.productUpdate.status.versionReadyToInstall",
      message: "Version {version} is ready to install.",
      values: { version: status.availableVersion },
    }
  }
  if (status.phase === "installing") return updateCopy.installing
  if (status.phase === "error") {
    if (!status.error) return updateCopy.updateFailed
    return {
      id: "settings.productUpdate.status.failedWithError",
      message: "Update failed: {error}",
      values: { error: status.error },
    }
  }
  return {
    id: "settings.productUpdate.status.currentVersion",
    message: "Current version {version}.",
    values: { version: status.currentVersion },
  }
}

export function webVersionStatus(appVersion: string | undefined, serverVersion: string | undefined): MessageDescriptor {
  if (!serverVersion) return updateCopy.checkingServerVersion
  if (serverVersion === "local") return updateCopy.localDevelopmentServer
  if (appVersion && webUpdateNeedsRefresh(appVersion, serverVersion)) {
    return {
      id: "settings.productUpdate.web.newerClientAvailable",
      message: "Server {serverVersion} has a newer Web client.",
      values: { serverVersion },
    }
  }
  if (appVersion && appVersion !== serverVersion) {
    return {
      id: "settings.productUpdate.web.versionMismatch",
      message: "Web client {appVersion} is running with server {serverVersion}.",
      values: { appVersion, serverVersion },
    }
  }
  if (!appVersion) return updateCopy.webClientCurrent
  return {
    id: "settings.productUpdate.web.currentVersion",
    message: "Web client is current at {appVersion}.",
    values: { appVersion },
  }
}

export function serverUpdateStatusCopy(status: ServerUpdateStatus | null): MessageDescriptor {
  if (!status) return updateCopy.checkingServerCapability
  if (status.capability === "remote") return updateCopy.serverUpdatesLocalOnly
  if (status.capability === "not-managed") return updateCopy.serverExternallyManaged
  if (status.phase === "available") {
    if (!status.latestVersion) return updateCopy.serverUpdateAvailable
    return {
      id: "settings.productUpdate.server.versionAvailable",
      message: "Server {version} is available.",
      values: { version: status.latestVersion },
    }
  }
  if (status.phase === "checking") return updateCopy.checkingServerUpdates
  if (status.phase === "updating" || status.phase === "restarting") return updateCopy.updatingManagedService
  if (status.phase === "error") {
    if (!status.error) return updateCopy.serverUpdateFailed
    return {
      id: "settings.productUpdate.server.failedWithError",
      message: "Server update failed: {error}",
      values: { error: status.error },
    }
  }
  if (status.latestVersion) {
    return {
      id: "settings.productUpdate.server.currentVersion",
      message: "Managed server runtime is current at {version}.",
      values: { version: status.currentVersion },
    }
  }
  return updateCopy.serverCanUpdate
}

export function downloadLabel(status: DesktopUpdateStatus | null): MessageDescriptor {
  if (!status || status.percent == null) return updateCopy.downloading
  return {
    id: "settings.productUpdate.notice.downloadingPercent",
    message: "Downloading {percent}%",
    values: { percent: Math.round(status.percent) },
  }
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
        title: updateAvailableTitle(desktop.availableVersion),
        detail: updateCopy.downloadReady,
        actionLabel: updateCopy.download,
        action: "download",
        progress: null,
        tone: "ready",
        busy: Boolean(input.busy),
      }
    }
    if (desktop.phase === "downloading") {
      return {
        visible: true,
        title: updateCopy.downloadingSynergy,
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
        title: updateReadyTitle(desktop.availableVersion),
        detail: updateCopy.restartToInstall,
        actionLabel: updateCopy.restart,
        action: "install",
        progress: 100,
        tone: "ready",
        busy: Boolean(input.busy),
      }
    }
    if (desktop.phase === "installing") {
      return {
        visible: true,
        title: updateCopy.installingSynergy,
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
        title: updateCopy.noticeUpdateFailed,
        detail: desktopUpdateStatusCopy(desktop),
        actionLabel: updateCopy.retry,
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
      title: updateCopy.updatingService,
      detail: input.serverReconnecting ? updateCopy.waitingForService : serverUpdateStatusCopy(input.serverStatus),
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
      title: updateAvailableTitle(input.serverStatus?.latestVersion),
      detail: updateCopy.updateManagedService,
      actionLabel: updateCopy.update,
      action: "start-server",
      progress: input.serverStatus?.progress ?? null,
      tone: "ready",
      busy: Boolean(input.busy),
    }
  }
  if (input.serverStatus?.capability === "managed" && input.serverStatus.phase === "error") {
    return {
      visible: true,
      title: updateCopy.serviceUpdateFailed,
      detail: serverUpdateStatusCopy(input.serverStatus),
      actionLabel: updateCopy.retry,
      action: "check",
      progress: null,
      tone: "error",
      busy: Boolean(input.busy),
    }
  }
  if ((input.webRefreshEnabled ?? true) && webUpdateNeedsRefresh(input.appVersion, input.serverVersion)) {
    return {
      visible: true,
      title: updateCopy.webUpdateReady,
      detail: webVersionStatus(input.appVersion, input.serverVersion),
      actionLabel: updateCopy.refresh,
      action: "refresh",
      progress: 100,
      tone: "ready",
      busy: Boolean(input.busy),
    }
  }
  return hiddenProductUpdateNotice(input.busy)
}

function updateAvailableTitle(version: string | null | undefined): MessageDescriptor {
  if (!version) return updateCopy.genericUpdateAvailable
  return {
    id: "settings.productUpdate.notice.versionAvailable",
    message: "Synergy {version} available",
    values: { version },
  }
}

function updateReadyTitle(version: string | null | undefined): MessageDescriptor {
  if (!version) return updateCopy.genericUpdateReady
  return {
    id: "settings.productUpdate.notice.versionReady",
    message: "Synergy {version} ready",
    values: { version },
  }
}

function semverGt(candidate: string, current: string) {
  const next = parseReleaseVersion(candidate)
  const prev = parseReleaseVersion(current)
  if (!next || !prev) return false
  for (let i = 0; i < 3; i++) {
    if (next[i] > prev[i]) return true
    if (next[i] < prev[i]) return false
  }
  return false
}

function parseReleaseVersion(value: string) {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number]
}

function hiddenProductUpdateNotice(busy: ProductUpdateBusyAction): ProductUpdateNotice {
  return {
    visible: false,
    title: updateCopy.noticeFallbackTitle,
    detail: updateCopy.noticeFallbackDetail,
    actionLabel: null,
    action: null,
    progress: null,
    tone: "neutral",
    busy: Boolean(busy),
  }
}
