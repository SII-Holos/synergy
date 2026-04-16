import { DaemonUnsupportedPlatformError } from "./error"

export namespace DaemonService {
  export type Manager = "launchd" | "systemd-user" | "schtasks"

  export interface InstallSpec {
    label: string
    hostname: string
    port: number
    command: string[]
    cwd: string
    env: Record<string, string>
    logFile: string
  }

  export interface RuntimeStatus {
    installed: boolean
    running: boolean
    detail?: string
  }

  export interface Service {
    manager: Manager
    install(spec: InstallSpec): Promise<void>
    uninstall(spec: InstallSpec): Promise<void>
    start(spec: InstallSpec): Promise<void>
    stop(spec: InstallSpec): Promise<void>
    restart(spec: InstallSpec): Promise<void>
    status(spec: InstallSpec): Promise<RuntimeStatus>
  }

  export async function resolve(): Promise<Service> {
    if (process.platform === "darwin") {
      const mod = await import("./launchd")
      return mod.LaunchdService
    }
    if (process.platform === "linux") {
      const mod = await import("./systemd")
      return mod.SystemdUserService
    }
    if (process.platform === "win32") {
      const mod = await import("./schtasks")
      return mod.SchtasksService
    }
    throw new DaemonUnsupportedPlatformError({ platform: process.platform })
  }
}
