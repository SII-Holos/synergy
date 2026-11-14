import { z } from "zod"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"

export function createHandoffCompletion(input: {
  binding: z.infer<typeof Handoff.Binding>
  source: { runtimeID: string; publicKey: string }
  target: { runtimeID: string; publicKey: string }
  invoke(operation: Handoff.Drive["operation"], requestID: string): Promise<Handoff.MachineResult>
}) {
  const binding = Handoff.Binding.parse(structuredClone(input.binding))
  const source = { ...input.source }
  const target = { ...input.target }
  if (source.runtimeID !== binding.sourceRuntimeID || target.runtimeID !== binding.targetRuntimeID)
    throw new Error("Original handoff completion requires its enrolled participants")
  const completion: Partial<Record<Handoff.Drive["operation"], Handoff.Proof["purpose"]>> = {
    "prepare-source": "source-frozen",
    "prepare-target": "target-prepared",
    "preview-target": "target-difference",
    "surrender-source": "source-surrendered",
    "cancel-source": "source-cancelled",
    "activate-target": "target-activated",
    "retire-target": "target-never-activate",
  }
  async function invoke(operation: Handoff.Drive["operation"]) {
    const requestID = crypto.randomUUID()
    const result = Handoff.MachineResult.parse(await input.invoke(operation, requestID))
    const participant = Handoff.machineRole(operation) === "source" ? source : target
    if (
      result.handoffID !== binding.handoffID ||
      result.requestID !== requestID ||
      result.operation !== operation ||
      result.runtimeID !== participant.runtimeID
    )
      throw new Error("Original handoff drive returned another participant or operation")
    return result
  }
  return async function drive(
    operation: Handoff.Drive["operation"],
    acceptedPurposes?: readonly Handoff.Proof["purpose"][],
  ) {
    const purpose = completion[operation]
    if (
      acceptedPurposes &&
      (!purpose ||
        !acceptedPurposes.length ||
        acceptedPurposes.some(
          (value) => value !== purpose && !(operation === "retire-target" && value === "target-preview-released"),
        ))
    )
      throw new Error("Original handoff completion requires the operation's terminal facts")
    const purposes = acceptedPurposes ?? (purpose ? [purpose] : [])
    let result: Handoff.MachineResult | undefined
    let dispatchError: unknown
    try {
      result = await invoke(operation)
    } catch (error) {
      if (
        !purpose ||
        !z.object({ code: z.literal("COMMAND_OUTCOME_UNKNOWN"), outcome: z.literal("unknown") }).safeParse(error)
          .success
      )
        throw error
      dispatchError = error
    }
    if (!purpose) return result!
    const role = Handoff.machineRole(operation)
    for (;;) {
      if (result) {
        if (result.state === "complete") {
          const terminal = result
          const fact = terminal.facts.find(
            ({ proof }) => proof.purpose === terminal.stage && purposes.includes(proof.purpose),
          )
          if (
            !fact ||
            JSON.stringify(Handoff.Binding.strip().parse(fact.proof)) !== JSON.stringify(binding) ||
            terminal.revision !== (await Handoff.proofHash(fact.proof)) ||
            !(await Handoff.verifyProof(fact.proof, fact.signature, (role === "source" ? source : target).publicKey))
          )
            throw new Error("Original handoff completion has no matching signed terminal fact", {
              cause: dispatchError,
            })
          return result
        }
        if (result.state !== "working")
          throw new Error(`Original ${operation} did not complete: ${result.state}/${result.stage}`, {
            cause: dispatchError,
          })
        await Bun.sleep(25)
      }
      try {
        result = await invoke(role === "source" ? "inspect-source" : "inspect-target")
      } catch (error) {
        if (dispatchError !== undefined)
          throw new AggregateError([dispatchError, error], "Original handoff dispatch and receipt inspection failed")
        throw error
      }
    }
  }
}
