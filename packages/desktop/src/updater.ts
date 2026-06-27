import { autoUpdater } from "electron-updater"
import type { DesktopChannel } from "./identity.js"

export interface DesktopUpdateStatus {
  enabled: boolean
  channel: DesktopChannel
  updateAvailable: boolean
  version: string | null
  error: string | null
}

export class DesktopUpdater {
  constructor(private channel: DesktopChannel) {
    autoUpdater.autoDownload = false
    autoUpdater.allowPrerelease = false
  }

  async check(): Promise<DesktopUpdateStatus> {
    if (this.channel === "dev") {
      return {
        enabled: false,
        channel: this.channel,
        updateAvailable: false,
        version: null,
        error: null,
      }
    }

    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo.version ?? null
      return {
        enabled: true,
        channel: this.channel,
        updateAvailable: Boolean(version),
        version,
        error: null,
      }
    } catch (error) {
      return {
        enabled: true,
        channel: this.channel,
        updateAvailable: false,
        version: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  installAndRestart(): void {
    if (this.channel === "dev") throw new Error("Automatic updates are disabled on the dev desktop channel")
    autoUpdater.quitAndInstall(false, true)
  }
}
