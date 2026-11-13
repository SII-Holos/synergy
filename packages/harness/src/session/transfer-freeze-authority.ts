import { RuntimeContext } from "../lifecycle/context"

export namespace SessionTransferFreezeAuthority {
  const brand = Symbol("session-transfer-owner-freeze")
  export type Receipt = { readonly [brand]: true }
  interface Evidence {
    runtime: RuntimeContext.Instance
    sessionID: string
    rootSessionID: string
    handoffID: string
    owners: readonly string[]
  }
  const receipts = new WeakMap<Receipt, Evidence>()

  export function issue(input: Omit<Evidence, "runtime">): Receipt {
    const receipt: Receipt = { [brand]: true }
    receipts.set(receipt, { ...input, owners: [...input.owners], runtime: RuntimeContext.current() })
    return receipt
  }

  export function assert(
    receipt: Receipt,
    input: {
      sessionID: string
      rootSessionID: string
      handoffID: string
      owners?: readonly string[]
      domainOwner?: boolean
    },
  ) {
    const evidence = receipts.get(receipt)
    if (
      !evidence ||
      evidence.runtime !== RuntimeContext.current() ||
      evidence.sessionID !== input.sessionID ||
      evidence.rootSessionID !== input.rootSessionID ||
      evidence.handoffID !== input.handoffID ||
      !evidence.owners.length ||
      (input.domainOwner && !evidence.owners.some((owner) => owner !== "session-core")) ||
      input.owners?.some((owner) => !evidence.owners.includes(owner))
    )
      throw new Error("Session transfer owner freeze receipt does not authorize this binding")
  }
}
