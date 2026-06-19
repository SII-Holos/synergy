// ------------------------------------------------------------------
// Sandbox types — shared types for the sandbox subsystem
// ------------------------------------------------------------------

export type SandboxMode = "none" | "read_only" | "workspace_write"

export type FallbackPolicy = "warn" | "allow" | "deny"

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
  runtimeReadRoots?: string[]
  extraReadRoots?: string[]
  writableRoots?: string[]
  extraWritableRoots?: string[]
  protectedPaths?: string[]
  dataDenyRoots?: string[]
}

export interface PrepareLinuxWrapperOpts {
  command: string
  args: string[]
  workspace: string
  sandboxMode: SandboxMode
  runtimeReadRoots?: string[]
  forcePlatform?: string
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

export interface ExecuteOpts {
  fallbackPolicy?: FallbackPolicy
}

export interface ExecuteResult {
  exitCode: number | null
  stdout: string
}
