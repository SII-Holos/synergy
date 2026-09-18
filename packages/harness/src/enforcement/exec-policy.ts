/**
 * Amendment suggestion attached to a refusal envelope.
 *
 * The name and wire shape are retained because an approval response can echo
 * the amendment back, so the `type` discriminator is part of that contract.
 */
export type ExecPolicyAmendment = {
  type: "execPolicy"
  commandPrefix: string[]
}

/**
 * Suggest a profile transition for a capability that was denied.
 *
 * `shell_hardline` has no amendment: it is non-bypassable in every profile, so
 * there is nothing to suggest.
 */
export function generateAmendmentForCapability(capability: string): ExecPolicyAmendment | undefined {
  if (capability === "shell_hardline") return undefined

  return {
    type: "execPolicy",
    commandPrefix: ["--profile=guarded"],
  }
}
