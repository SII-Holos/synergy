// Barrel re-export — backward compat for tests and code that import from sandbox/backend
export { SandboxBackend } from "./backend"

// Re-export public types from types.ts
export type {
  PlatformInfo,
  PrepareWrapperOpts,
  PrepareLinuxWrapperOpts,
  SeatbeltProfileOpts,
  SandboxExecutionWrapper,
  SandboxExecuteOpts,
  SandboxExecuteResult,
  SandboxMode,
  FallbackPolicy,
  SandboxNetworkMode,
} from "./types"
export type { SandboxReadinessCheck, SandboxReadiness } from "./types"

// Re-export policy-engine public types and functions
export { buildPermissionProfile, canEnforceOnPlatform } from "./policy-engine"
export type {
  SynergyFileSystemSandboxPolicy,
  SynergyNetworkSandboxPolicy,
  SynergySandboxPermissionProfile,
  SandboxPolicyInput,
} from "./policy-engine"
