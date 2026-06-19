// Barrel re-export — backward compat for tests and code that import from sandbox/backend
export { SandboxBackend } from "./backend"

// Re-export public types
export type {
  PlatformInfo,
  PrepareWrapperOpts,
  PrepareLinuxWrapperOpts,
  SeatbeltProfileOpts,
  SandboxExecutionWrapper,
  ExecuteOpts,
  ExecuteResult,
} from "./types"

export type { SandboxMode, FallbackPolicy } from "./types"
