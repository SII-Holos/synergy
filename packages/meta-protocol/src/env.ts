import z from "zod"

export namespace MetaProtocolEnv {
  export const EnvID = z.string().min(1).describe("Execution environment ID")
  export type EnvID = z.infer<typeof EnvID>

  export const SessionID = z.string().min(1).describe("Remote collaboration session identifier")
  export type SessionID = z.infer<typeof SessionID>

  export const ProcessID = z.string().min(1).describe("Opaque process identifier")
  export type ProcessID = z.infer<typeof ProcessID>

  export const HostSessionID = z.string().min(1).describe("Remote host session identifier")
  export type HostSessionID = z.infer<typeof HostSessionID>

  export type Target = { kind: "local" } | { kind: "remote"; envID: EnvID }

  const LOCAL_ALIASES = new Set([
    "local",
    ":local",
    "localhost",
    "127.0.0.1",
    "::1",
    "loopback",
    "self",
    ":self",
    "current",
    ":current",
    "host",
    ":host",
    "this",
    ":this",
  ])

  const PLACEHOLDER_ALIASES = new Set(["undefined", "null", "none", "nil", "n/a"])

  const ENVID_PREFIX = "env_"

  export type InvalidReason = "placeholder_alias" | "invalid_format"

  export class InvalidEnvIDError extends Error {
    constructor(
      readonly envID: string,
      readonly reason: InvalidReason,
    ) {
      super(
        reason === "placeholder_alias"
          ? `Invalid envID "${envID}". This looks like a placeholder value, not a real remote environment ID. ` +
              `For local execution, do NOT include the envID parameter at all — remove it from your tool call. ` +
              `For remote execution, pass a real remote envID such as "env_...".`
          : `Invalid envID "${envID}". Remote environment IDs must start with "${ENVID_PREFIX}". ` +
              `For local execution, do NOT include the envID parameter at all — remove it from your tool call. ` +
              `Do not try to pass a value meaning "local" or "omit" — simply leave out the envID key entirely.`,
      )
      this.name = "MetaProtocolInvalidEnvIDError"
    }
  }

  export function normalize(envID?: string): EnvID | undefined {
    if (envID === undefined) {
      return undefined
    }

    const trimmed = envID.trim()
    if (!trimmed) {
      return undefined
    }

    const lowered = trimmed.toLowerCase()
    if (LOCAL_ALIASES.has(lowered)) {
      return undefined
    }

    if (PLACEHOLDER_ALIASES.has(lowered)) {
      throw new InvalidEnvIDError(trimmed, "placeholder_alias")
    }

    if (!trimmed.startsWith(ENVID_PREFIX)) {
      throw new InvalidEnvIDError(trimmed, "invalid_format")
    }

    return trimmed as EnvID
  }

  export function resolve(envID?: string): Target {
    const normalized = normalize(envID)
    if (!normalized) {
      return { kind: "local" }
    }
    return {
      kind: "remote",
      envID: normalized,
    }
  }
}
