export type FullAccessActivation = {
  /** Profile the human is switching to. */
  targetProfile: string | undefined
  /** Profile currently in effect, when one is already applied. */
  currentProfile?: string | undefined
  /** Whether the risk acknowledgement is already recorded in config. */
  acknowledged?: boolean | undefined
}

/**
 * Whether selecting `targetProfile` must interrupt the human with the one-time
 * Full Access warning. Re-selecting a profile that is already in force never
 * re-prompts, so the dialog stays a single acknowledgement rather than a
 * recurring interruption.
 */
export function needsFullAccessAcknowledgement(input: FullAccessActivation): boolean {
  if (input.targetProfile !== "full_access") return false
  if (input.currentProfile === "full_access") return false
  return input.acknowledged !== true
}
