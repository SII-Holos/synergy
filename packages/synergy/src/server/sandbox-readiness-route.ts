import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import * as fs from "fs"
import { Config } from "../config/config"
import { detectPlatform } from "../sandbox/detect"
import { platformInfo, isBwrapAvailable } from "../sandbox/platform"
import { getWindowsHelperInfo } from "../sandbox/windows"
import type { SandboxReadinessCheck } from "../sandbox/types"

const SandboxReadinessCheckSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string(),
  })
  .meta({ ref: "SandboxReadinessCheck" })

const SandboxReadinessSchema = z
  .object({
    platform: z.enum(["macos", "linux", "windows", "unsupported"]),
    backend: z.string().nullable(),
    ready: z.boolean(),
    checks: z.array(SandboxReadinessCheckSchema),
  })
  .meta({ ref: "SandboxReadiness" })

export const SandboxReadinessRoute = new Hono().get(
  "/sandbox/readiness",
  describeRoute({
    summary: "Get sandbox readiness",
    description:
      "Platform-specific sandbox health checks. Returns readiness status with per-check diagnostics for macOS, Linux, and Windows.",
    operationId: "sandbox.readiness",
    responses: {
      200: {
        description: "Sandbox readiness information",
        content: {
          "application/json": {
            schema: resolver(SandboxReadinessSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const platform = detectPlatform()
    const info = platformInfo()
    const cfg = await Config.get()
    const sandboxCfg = cfg.sandbox
    const checks: SandboxReadinessCheck[] = []

    // Normalize platform name for the typed response
    let platformName: "macos" | "linux" | "windows" | "unsupported"
    if (platform === "macos" || platform === "linux" || platform === "windows") {
      platformName = platform
    } else {
      platformName = "unsupported"
    }

    // ── Generic: sandbox config check ───────────────────────────
    const configEnabled = sandboxCfg?.enabled !== false // defaults to true when absent
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
        detail: `Sandbox enabled with backend "${sandboxCfg.backend ?? "auto"}", fallback: ${sandboxCfg.fallbackPolicy ?? "deny"}.`,
      })
    }

    // ── Platform-specific checks ────────────────────────────────
    switch (platform) {
      case "macos": {
        // Check sandbox-exec binary
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

        // Check log stream utility for denial logging
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
        // Check bwrap availability
        const bwrapAvailable = isBwrapAvailable()
        checks.push({
          id: "linux_bwrap",
          label: "bwrap (bubblewrap)",
          status: bwrapAvailable ? "pass" : "fail",
          detail: bwrapAvailable
            ? "bwrap found on PATH"
            : "bwrap not found — install bubblewrap for Linux sandbox support",
        })

        // Check user namespaces
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
            // File doesn't exist on newer kernels (>=4.x) where namespaces are always available
            return true
          } catch {
            return true // If we can't check, assume enabled (most distros ship with it)
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
        break
      }

      case "windows": {
        // Check helper binary existence and hash verification
        const helperInfo = getWindowsHelperInfo()
        if (!helperInfo) {
          checks.push({
            id: "windows_helper",
            label: "Sandbox helper binary",
            status: "fail",
            detail: "synergy-sandbox.exe not found. Install the Synergy Windows sandbox helper.",
            recovery: {
              type: "install_helper",
              backend: "synergy-sandbox-windows",
              instructions: "Install the Synergy sandbox helper for Windows",
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
            detail: `Helper binary found at ${helperInfo.path} but hash verification failed.`,
            recovery: {
              type: "install_helper",
              backend: "synergy-sandbox-windows",
              instructions:
                "Sandbox helper binary hash verification failed. The helper may be corrupted or tampered. Reinstall the Synergy Windows sandbox helper.",
            },
          })
          checks.push({
            id: "windows_helper_hash",
            label: "Helper hash verification",
            status: "fail",
            detail: "Hash verification failed — helper may be corrupted or tampered.",
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

    // Ready: config must be enabled and no checks must have failed
    const ready = configEnabled && !checks.some((c) => c.status === "fail")

    return c.json({
      platform: platformName,
      backend: info.backend,
      ready,
      checks,
    })
  },
)
