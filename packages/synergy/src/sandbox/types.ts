// ------------------------------------------------------------------
// Sandbox types — shared types for the sandbox subsystem
// ------------------------------------------------------------------

export type SandboxMode = "none" | "read_only" | "workspace_write"

export type FallbackPolicy = "warn" | "allow" | "deny"
export type SandboxNetworkMode = "full" | "restricted" | "proxy_only"

export interface PlatformInfo {
  platform: string
  available: boolean
  backend: string | null
}

export interface PrepareWrapperOpts {
  command: string
  args: string[]
  workspace: string
  executionCwd?: string
  sandboxMode: SandboxMode
  forcePlatform?: string
  /** Explicit sandbox backend selection (e.g. "sandbox-exec", "seatbelt-deny-default") */
  backend?: string
  runtimeReadRoots?: string[]
  extraReadRoots?: string[]
  writableRoots?: string[]
  extraWritableRoots?: string[]
  protectedPaths?: string[]
  dataDenyRoots?: string[]
  /** Test-only helper override for backend unit tests; production callers should not set this. */
  forceHelperPath?: string
  /** Test-only helper verification override paired with forceHelperPath. */
  forceHelperVerified?: boolean
}

export interface PrepareLinuxWrapperOpts {
  command: string
  args: string[]
  workspace: string
  sandboxMode: SandboxMode
  runtimeReadRoots?: string[]
  extraReadRoots?: string[]
  extraWritableRoots?: string[]
  forcePlatform?: string
  /** Explicit sandbox backend selection (e.g. "bwrap-inline-debug") */
  backend?: string
}

export interface SeatbeltProfileOpts {
  workspace: string
  sandboxMode: "read_only" | "workspace_write"
  runtimeReadRoots: string[]
  literalReadRoots?: string[]
  writableRoots: string[]
  protectedPaths: string[]
  dataDenyRoots?: string[]
}
export interface SandboxExecutionWrapper {
  command: string
  args: string[]
  sandboxed: boolean
  skipReason?: string
  tempPath?: string
}

export interface SandboxExecuteOpts {
  fallbackPolicy: FallbackPolicy
  env?: Record<string, string>
  cwd?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
  onStdout?: (chunk: Buffer) => void
  onStderr?: (chunk: Buffer) => void
}

export interface SandboxExecuteResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

// ── Readiness types ──────────────────────────────────────────────
// Used by GET /sandbox/readiness for platform-specific health checks.

import type { SandboxRecoveryAction } from "./explain"

export interface SandboxReadinessCheck {
  id: string
  label: string
  status: "pass" | "warn" | "fail"
  detail: string
  recovery?: SandboxRecoveryAction
}

export interface SandboxReadiness {
  platform: "macos" | "linux" | "windows" | "unsupported"
  backend: string | null
  ready: boolean
  checks: SandboxReadinessCheck[]
  summary: string
}
