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
} from "@ericsanchezok/synergy-harness/sandbox/types"
export type { SandboxReadinessCheck, SandboxReadiness } from "@ericsanchezok/synergy-harness/sandbox/types"

// Re-export policy-engine public types and functions
export { buildPermissionProfile, canEnforceOnPlatform } from "@ericsanchezok/synergy-harness/sandbox/policy-engine"
export type {
  SynergyFileSystemSandboxPolicy,
  SynergyNetworkSandboxPolicy,
  SynergySandboxPermissionProfile,
  SandboxPolicyInput,
} from "@ericsanchezok/synergy-harness/sandbox/policy-engine"
