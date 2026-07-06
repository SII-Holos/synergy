import z from "zod"

export namespace SynergyLinkIdentity {
  export const LINK_ID_PREFIX = "link_"
  export const LinkID = z
    .string()
    .min(1)
    .refine((value) => value.startsWith(LINK_ID_PREFIX), {
      message: `Synergy Link IDs must start with "${LINK_ID_PREFIX}"`,
    })
    .describe("Synergy Link target identifier")
  export type LinkID = z.infer<typeof LinkID>

  export const SessionID = z.string().min(1).describe("Synergy Link session identifier")
  export type SessionID = z.infer<typeof SessionID>

  export const ProcessID = z.string().min(1).describe("Opaque process identifier")
  export type ProcessID = z.infer<typeof ProcessID>

  export const HostSessionID = z.string().min(1).describe("Synergy Link host session identifier")
  export type HostSessionID = z.infer<typeof HostSessionID>

  export const Warning = z.object({
    code: z.enum(["synergy_link.invalid_link_id", "synergy_link.not_connected", "synergy_link.no_active_session"]),
    message: z.string(),
    reminder: z.string(),
    requestedLinkID: z.string().optional(),
    retryable: z.boolean(),
  })
  export type Warning = z.infer<typeof Warning>

  export type LinkResolution =
    | { kind: "local"; reason: "omitted" | "blank" }
    | { kind: "remote"; linkID: LinkID }
    | { kind: "invalid"; input: string; reason: "placeholder_alias" | "local_alias" | "invalid_format" }

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

  const PLACEHOLDER_ALIASES = new Set(["env", "/", "/omit", "undefined", "null", "none", "nil", "n/a"])

  export type InvalidReason = "placeholder_alias" | "local_alias" | "invalid_format"

  export class InvalidLinkIDError extends Error {
    constructor(
      readonly linkID: string | undefined,
      readonly reason: InvalidReason | "missing",
    ) {
      super(formatInvalidLinkIDMessage(linkID, reason))
      this.name = "SynergyLinkInvalidLinkIDError"
    }
  }

  export function resolve(input?: string): LinkResolution {
    if (input === undefined) {
      return { kind: "local", reason: "omitted" }
    }

    const trimmed = input.trim()
    if (!trimmed) {
      return { kind: "local", reason: "blank" }
    }

    const lowered = trimmed.toLowerCase()
    // Backward compat: treat old env_ prefix as a placeholder until all persisted state migrates
    if (PLACEHOLDER_ALIASES.has(lowered) || lowered.startsWith("env_")) {
      return { kind: "invalid", input: trimmed, reason: "placeholder_alias" }
    }

    if (LOCAL_ALIASES.has(lowered)) {
      return { kind: "invalid", input: trimmed, reason: "local_alias" }
    }

    if (!trimmed.startsWith(LINK_ID_PREFIX)) {
      return { kind: "invalid", input: trimmed, reason: "invalid_format" }
    }

    return { kind: "remote", linkID: trimmed as LinkID }
  }

  export function requireLinkID(input: string | undefined): LinkID {
    const resolution = resolve(input)
    if (resolution.kind === "remote") {
      return resolution.linkID
    }
    if (resolution.kind === "invalid") {
      throw new InvalidLinkIDError(resolution.input, resolution.reason)
    }
    throw new InvalidLinkIDError(input, "missing")
  }

  function formatInvalidLinkIDMessage(linkID: string | undefined, reason: InvalidReason | "missing") {
    if (reason === "missing") {
      return `Missing linkID. Connect actions require a Synergy Link ID such as "link_...".`
    }
    if (reason === "local_alias") {
      return `Invalid linkID "${linkID}". Omit linkID for intentional local execution; connect requires a real Synergy Link ID such as "link_...".`
    }
    if (reason === "placeholder_alias") {
      return `Invalid linkID "${linkID}". This looks like a placeholder or retired target ID, not a Synergy Link ID. Use a real "link_..." ID.`
    }
    return `Invalid linkID "${linkID}". Synergy Link IDs must start with "${LINK_ID_PREFIX}".`
  }
}
