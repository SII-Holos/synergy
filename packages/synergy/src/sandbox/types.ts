import z from "zod"

export type FallbackPolicy = "warn" | "allow" | "deny"

export const FallbackPolicySchema = z.enum(["warn", "allow", "deny"])

export interface FallbackResult {
  policy: FallbackPolicy
  allowExecution: boolean
  message: string
  reason: string
}

export interface SandboxWrapper {
  command: string
  profileRules: string[]
  workspaceWritable: boolean
}

export interface GenerateWrapperInput {
  platform: string
  workspace: string
  writableRoots?: string[]
  protectedPaths?: string[]
}

export interface SandboxConfig {
  enabled?: boolean
  fallbackPolicy?: FallbackPolicy
}
