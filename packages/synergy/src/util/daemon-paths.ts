import path from "path"
import { Global } from "../global"

export namespace DaemonPaths {
  export function root() {
    return path.join(Global.Path.state, "daemon")
  }

  export function logs() {
    return path.join(root(), "logs")
  }

  export function manifest() {
    return path.join(root(), "manifest.json")
  }

  export function runtimeLock() {
    return path.join(root(), "runtime-lock.json")
  }

  export function logFile() {
    return path.join(logs(), "server.log")
  }

  export function launchAgent(label: string) {
    return path.join(Global.Path.home, "Library", "LaunchAgents", `${label}.plist`)
  }

  export function systemdUserDir() {
    return path.join(Global.Path.home, ".config", "systemd", "user")
  }

  export function systemdUnit(label: string) {
    return path.join(systemdUserDir(), `${label}.service`)
  }

  export function windowsTaskScript() {
    return path.join(root(), "synergy.cmd")
  }

  export function windowsLauncher() {
    return path.join(root(), "synergy.vbs")
  }
}
