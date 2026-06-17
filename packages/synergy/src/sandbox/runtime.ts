import os from "os"
import path from "path"
import type {
  FallbackPolicy,
  FallbackResult,
  GenerateWrapperInput,
  SandboxConfig,
  SandboxWrapper,
} from "./types"
import { FallbackPolicySchema } from "./types"

export namespace SandboxRuntime {
  /**
   * Pure platform detection — returns the current OS tag without I/O.
   */
  export function detectPlatform(): string {
    const platform = os.platform()
    if (platform === "darwin") return "macos"
    if (platform === "linux") return "linux"
    if (platform === "win32") return "windows"
    return platform
  }

  /**
   * Check whether the sandbox runtime is available.
   * Never throws — safe to call unconditionally.
   */
  export function isAvailable(): boolean {
    const platform = detectPlatform()
    // For now, only macOS has sandbox support planned
    if (platform !== "macos") return false
    // In the future we may check for sandbox-exec binary presence
    return true
  }

  /**
   * Generate a SandboxWrapper with profile rules for the given platform.
   * Pure string assembly — does not touch the filesystem.
   */
  export function generateWrapper(input: GenerateWrapperInput): SandboxWrapper {
    const { platform, workspace, writableRoots, protectedPaths } = input

    if (platform !== "macos") {
      throw new Error(`SandboxRuntime.generateWrapper: unsupported platform "${platform}"`)
    }

    const roots = writableRoots && writableRoots.length > 0
      ? writableRoots
      : [path.join(workspace, ".synergy")]

    const denyPaths = protectedPaths && protectedPaths.length > 0
      ? protectedPaths
      : ["/etc", "/usr", os.homedir()]

    // Build macOS sandbox-exec profile rules
    const profileRules: string[] = [
      "(version 1)",
      "(allow default)",
    ]

    // Deny writes to protected system paths
    for (const p of denyPaths) {
      profileRules.push(`(deny file-write* (subpath "${p}"))`)
    }

    // Deny writes to protected workspace paths (.git, .synergy config)
    profileRules.push(`(deny file-write* (subpath "${path.join(workspace, ".git")}"))`)

    // Allow writes to workspace (read-write access to workspace tree)
    for (const root of roots) {
      profileRules.push(`(allow file-read* file-write* (subpath "${root}"))`)
    }

    // Allow reads everywhere else (sandbox by default is read-only)
    profileRules.push("(allow file-read*)")

    return {
      command: "sandbox-exec",
      profileRules,
      workspaceWritable: true,
    }
  }

  /**
   * Resolve the sandbox fallback policy.
   * Config-driven: explicit enable/disable and fallbackPolicy override.
   * Defaults to "warn" when sandbox is unavailable.
   */
  export function resolveFallback(config?: SandboxConfig): FallbackResult {
    const enabled = config?.enabled
    const explicitPolicy = config?.fallbackPolicy

    // Validate fallbackPolicy early, regardless of availability
    if (explicitPolicy !== undefined) {
      FallbackPolicySchema.parse(explicitPolicy)
    }

    // Explicitly disabled — quiet allow, no warning
    if (enabled === false) {
      return {
        policy: "allow",
        allowExecution: true,
        message: "",
        reason: "sandbox disabled by config",
      }
    }

    const available = isAvailable()

    if (available) {
      return {
        policy: "allow",
        allowExecution: true,
        message: "",
        reason: "sandbox available",
      }
    }

    // Sandbox unavailable — resolve policy
    const policy: FallbackPolicy = explicitPolicy ?? "warn"

    if (policy === "deny") {
      return {
        policy: "deny",
        allowExecution: false,
        message: "Sandbox is not available on this platform",
        reason: "sandbox unavailable, fallbackPolicy=deny",
      }
    }

    if (policy === "allow") {
      return {
        policy: "allow",
        allowExecution: true,
        message: "",
        reason: "sandbox unavailable, fallbackPolicy=allow",
      }
    }

    // Default: "warn"
    return {
      policy: "warn",
      allowExecution: true,
      message: "Sandbox is not available on this platform — running without sandboxing",
      reason: "sandbox unavailable",
    }
  }

  /**
   * Validate a sandbox config object. Rejects unknown keys and invalid values.
   */
  export function validateConfig(config: unknown): void {
    if (typeof config !== "object" || config === null) {
      throw new Error("SandboxRuntime.validateConfig: config must be an object")
    }

    const record = config as Record<string, unknown>
    const validKeys = new Set(["enabled", "fallbackPolicy"])

    for (const key of Object.keys(record)) {
      if (!validKeys.has(key)) {
        throw new Error(`SandboxRuntime.validateConfig: unknown config key "${key}"`)
      }
    }

    if ("enabled" in record && typeof record.enabled !== "boolean") {
      throw new Error('SandboxRuntime.validateConfig: "enabled" must be a boolean')
    }

    if ("fallbackPolicy" in record) {
      if (typeof record.fallbackPolicy !== "string") {
        throw new Error('SandboxRuntime.validateConfig: "fallbackPolicy" must be a string')
      }
      FallbackPolicySchema.parse(record.fallbackPolicy)
    }
  }
}
