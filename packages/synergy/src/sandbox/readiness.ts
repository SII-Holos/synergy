import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import { detectPlatform } from "./detect"
import { platformInfo, isBwrapAvailable } from "./platform"
import { getWindowsHelperInfo } from "./windows"
import { getLinuxHelperInfo } from "./linux"
import { isWsl1 } from "./wsl"
import type { SandboxReadinessCheck, SandboxReadiness } from "./types"

export interface SandboxReadinessConfig {
  enabled?: boolean
  backend?: string
  fallbackPolicy?: string
}

export async function getSandboxReadiness(sandboxCfg?: SandboxReadinessConfig): Promise<SandboxReadiness> {
  const platform = detectPlatform()
  const info = platformInfo()
  const checks: SandboxReadinessCheck[] = []

  // Normalize platform name for the typed response
  let platformName: "macos" | "linux" | "windows" | "unsupported"
  if (platform === "macos" || platform === "linux" || platform === "windows") {
    platformName = platform
  } else {
    platformName = "unsupported"
  }

  // ── Generic: sandbox config check ───────────────────────────
  const configEnabled = sandboxCfg?.enabled !== false
  if (!sandboxCfg) {
    checks.push({
      id: "sandbox_config",
      label: "Sandbox configuration",
      status: "warn",
      detail: "No sandbox configuration section found. Using platform defaults (enabled=true).",
    })
  } else if (!configEnabled) {
    checks.push({
      id: "sandbox_config",
      label: "Sandbox configuration",
      status: "fail",
      detail: "Sandbox is disabled via configuration (enabled: false).",
    })
  } else {
    checks.push({
      id: "sandbox_config",
      label: "Sandbox configuration",
      status: "pass",
      detail: `Sandbox enabled with backend "${sandboxCfg.backend ?? "auto"}", fallback: ${sandboxCfg.fallbackPolicy ?? "warn"}.`,
    })
  }

  // ── Platform-specific checks ────────────────────────────────
  switch (platform) {
    case "macos": {
      const sandboxExecExists = (() => {
        try {
          return fs.existsSync("/usr/bin/sandbox-exec")
        } catch {
          return false
        }
      })()
      checks.push({
        id: "macos_sandbox_exec",
        label: "sandbox-exec binary",
        status: sandboxExecExists ? "pass" : "fail",
        detail: sandboxExecExists
          ? "/usr/bin/sandbox-exec found"
          : "/usr/bin/sandbox-exec not found — macOS sandbox unavailable",
      })

      checks.push({
        id: "macos_sandbox_exec_version",
        label: "sandbox-exec version",
        status: sandboxExecExists ? "warn" : "fail",
        detail: sandboxExecExists
          ? "sandbox-exec available (deprecated since macOS 10.12 Sierra but still functional on Apple Silicon)"
          : "sandbox-exec not found",
      })

      const logExists = (() => {
        try {
          return fs.existsSync("/usr/bin/log")
        } catch {
          return false
        }
      })()
      checks.push({
        id: "macos_log_stream",
        label: "Denial logger (log stream)",
        status: logExists ? "pass" : "warn",
        detail: logExists
          ? "/usr/bin/log found — denial logging available"
          : "/usr/bin/log not found — denial logging unavailable (non-critical)",
      })
      break
    }
    case "linux": {
      const wsl1Detected = isWsl1()
      checks.push({
        id: "linux_wsl1",
        label: "WSL1 environment",
        status: wsl1Detected ? "fail" : "pass",
        detail: wsl1Detected
          ? "WSL1 detected — bubblewrap is not supported on WSL1. Upgrade to WSL2: wsl --set-version <distro> 2"
          : "Not running under WSL1",
        recovery: wsl1Detected
          ? {
              action: "upgrade_wsl",
              label: "Upgrade to WSL2",
              command: "wsl --set-version <distro> 2",
            }
          : undefined,
      })

      const linuxHelperInfo = getLinuxHelperInfo()
      if (!linuxHelperInfo) {
        checks.push({
          id: "linux_helper",
          label: "Linux sandbox helper binary",
          status: "fail",
          detail:
            "synergy-sandbox-linux not found in ~/.synergy/sandbox-helper/. Run: synergy doctor for setup instructions",
          recovery: {
            action: "install_helper",
            label: "Install Linux sandbox helper",
            command: "synergy doctor",
          },
        })
        checks.push({
          id: "linux_helper_hash",
          label: "Linux helper hash verification",
          status: "fail",
          detail: "Cannot verify hash — helper binary not found.",
        })
      } else if (!linuxHelperInfo.verified) {
        checks.push({
          id: "linux_helper",
          label: "Linux sandbox helper binary",
          status: "warn",
          detail: `synergy-sandbox-linux found at ${linuxHelperInfo.path} but hash verification failed. The binary may be from a different version. Re-download or rebuild with: bun run scripts/build-helper.ts linux`,
          recovery: {
            action: "reinstall",
            label: "Reinstall Linux sandbox helper",
            command: "bun run scripts/build-helper.ts linux",
          },
        })
      } else {
        checks.push({
          id: "linux_helper",
          label: "Linux sandbox helper binary",
          status: "pass",
          detail: `Helper binary found and verified at ${linuxHelperInfo.path}.`,
        })
        checks.push({
          id: "linux_helper_hash",
          label: "Linux helper hash verification",
          status: "pass",
          detail: "Helper hash verified against trusted hashes.",
        })
      }

      const seccompAvailable = (() => {
        try {
          const result = Bun.spawnSync({
            cmd: ["cat", "/proc/sys/kernel/seccomp/actions_avail"],
            stdout: "pipe",
            stderr: "pipe",
          })
          if (result.exitCode === 0) {
            const val = new TextDecoder().decode(result.stdout).trim()
            return val.length > 0 && val.includes("errno")
          }
          return false
        } catch {
          return false
        }
      })()
      checks.push({
        id: "linux_seccomp",
        label: "seccomp BPF filtering",
        status: seccompAvailable ? "pass" : "warn",
        detail: seccompAvailable
          ? "seccomp filter mode available"
          : "seccomp is not available on this system. seccomp requires Linux kernel 3.5+ with CONFIG_SECCOMP=y",
      })

      const bwrapAvailable = isBwrapAvailable()
      checks.push({
        id: "linux_bwrap",
        label: "bwrap (bubblewrap)",
        status: bwrapAvailable ? "pass" : "fail",
        detail: bwrapAvailable
          ? "bwrap found on PATH"
          : "bubblewrap is not installed. Run: sudo apt install bubblewrap (Debian/Ubuntu) or sudo dnf install bubblewrap (Fedora)",
        recovery: bwrapAvailable
          ? undefined
          : {
              action: "install_bubblewrap",
              label: "Install bubblewrap",
              command: "sudo apt install bubblewrap",
            },
      })

      const usernsAvailable = (() => {
        try {
          const result = Bun.spawnSync({
            cmd: ["cat", "/proc/sys/kernel/unprivileged_userns_clone"],
            stdout: "pipe",
            stderr: "pipe",
          })
          if (result.exitCode === 0) {
            const val = new TextDecoder().decode(result.stdout).trim()
            return val === "1"
          }
          return true
        } catch {
          return true
        }
      })()
      checks.push({
        id: "linux_namespaces",
        label: "User namespaces",
        status: usernsAvailable ? "pass" : "fail",
        detail: usernsAvailable
          ? "User namespaces appear enabled"
          : "User namespaces disabled — bwrap requires unprivileged user namespaces. Set kernel.unprivileged_userns_clone=1.",
      })

      const maxUsernsAvailable = (() => {
        try {
          const result = Bun.spawnSync({
            cmd: ["cat", "/proc/sys/user/max_user_namespaces"],
            stdout: "pipe",
            stderr: "pipe",
          })
          if (result.exitCode === 0) {
            const val = parseInt(new TextDecoder().decode(result.stdout).trim())
            return val > 0
          }
          return true
        } catch {
          return true
        }
      })()
      checks.push({
        id: "linux_user_max_namespaces",
        label: "Max user namespaces",
        status: maxUsernsAvailable ? "pass" : "fail",
        detail: maxUsernsAvailable
          ? "user.max_user_namespaces > 0"
          : "user.max_user_namespaces = 0 — no user namespaces available. Set to > 0 or disable this restriction.",
      })

      const bwrapVersion = (() => {
        try {
          const result = Bun.spawnSync({
            cmd: ["bwrap", "--version"],
            stdout: "pipe",
            stderr: "pipe",
          })
          return new TextDecoder().decode(result.stdout).trim()
        } catch {
          return null
        }
      })()
      checks.push({
        id: "linux_bwrap_version",
        label: "bwrap version",
        status: bwrapVersion ? "pass" : "warn",
        detail: bwrapVersion ?? "Could not determine bwrap version",
      })

      const bundledBwrapPath = path.join(os.homedir(), ".synergy", "sandbox-helper", "bwrap")
      const bundledBwrapExists = (() => {
        try {
          return fs.existsSync(bundledBwrapPath)
        } catch {
          return false
        }
      })()
      checks.push({
        id: "linux_bundled_bwrap",
        label: "Bundled bwrap",
        status: bundledBwrapExists ? "pass" : "warn",
        detail: bundledBwrapExists
          ? `Bundled bwrap found at ${bundledBwrapPath}`
          : "No bundled bwrap found. Using system bwrap or manual install.",
      })

      const landlockAvailable = (() => {
        try {
          const result = Bun.spawnSync({
            cmd: [
              "sh",
              "-c",
              "grep -q landlock /proc/filesystems 2>/dev/null || grep -q CONFIG_SECURITY_LANDLOCK /boot/config-$(uname -r) 2>/dev/null",
            ],
            stdout: "pipe",
            stderr: "pipe",
          })
          return result.exitCode === 0
        } catch {
          return false
        }
      })()
      checks.push({
        id: "linux_landlock",
        label: "Landlock LSM",
        status: landlockAvailable ? "pass" : "warn",
        detail: landlockAvailable
          ? "Landlock kernel module detected — available as fallback sandbox"
          : "Landlock not detected — bwrap is the only Linux sandbox option",
      })
      break
    }

    case "windows": {
      const helperInfo = getWindowsHelperInfo()
      if (!helperInfo) {
        checks.push({
          id: "windows_helper",
          label: "Sandbox helper binary",
          status: "fail",
          detail:
            "synergy-sandbox-windows.exe not found in ~/.synergy/sandbox-helper/. Download the latest release from https://github.com/ericsanchezok/synergy/releases",
          recovery: {
            action: "install_helper",
            label: "Download Windows sandbox helper",
            command: "Download from https://github.com/ericsanchezok/synergy/releases",
          },
        })
        checks.push({
          id: "windows_helper_hash",
          label: "Helper hash verification",
          status: "fail",
          detail: "Cannot verify hash — helper binary not found.",
        })
      } else if (!helperInfo.verified) {
        checks.push({
          id: "windows_helper",
          label: "Sandbox helper binary",
          status: "warn",
          detail: `synergy-sandbox-windows.exe found at ${helperInfo.path} but hash verification failed. Re-download the latest release`,
          recovery: {
            action: "reinstall",
            label: "Re-download Windows sandbox helper",
            command: "Download from https://github.com/ericsanchezok/synergy/releases",
          },
        })
      } else {
        checks.push({
          id: "windows_helper",
          label: "Sandbox helper binary",
          status: "pass",
          detail: `Helper binary found and verified at ${helperInfo.path}.`,
        })
        checks.push({
          id: "windows_helper_hash",
          label: "Helper hash verification",
          status: "pass",
          detail: "Helper hash verified against trusted hashes.",
        })
      }
      break
    }
  }

  const ready = configEnabled && !checks.some((c) => c.status === "fail")
  const summary = ready
    ? "Sandbox is operational"
    : checks
        .filter((c) => c.status === "fail")
        .map((c) => c.label)
        .join(", ") + " — sandbox not ready"

  return {
    platform: platformName,
    backend: info.backend,
    ready,
    summary,
    checks,
  }
}
