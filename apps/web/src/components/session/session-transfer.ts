import { type SynergyClient, type SessionTransferReceipt } from "@ericsanchezok/synergy-sdk/client"

export type TransferProgress = "preparing" | "copying" | "committing" | "activating" | "completed"
async function required<T>(request: Promise<{ data?: T }>): Promise<NonNullable<T>> {
  const response = await request
  if (response.data == null) throw new Error("Session transfer returned no result")
  return response.data
}

export async function migratePausedSession(input: {
  source: SynergyClient
  target: SynergyClient
  sessionID: string
  scopeID: string
  migrationID: string
  progress?: (phase: TransferProgress) => void
}) {
  const { source, target, sessionID, scopeID } = input
  const identity = await required(target.sessionTransfer.host())
  const status = (await source.sessionTransfer.status({ sessionID, scopeID })).data
  if (status && status.phase !== "cancelled" && status.targetID !== identity.id)
    throw new Error("Session transfer is already assigned to another device")
  if (status?.phase === "cancelled" && status.targetID === identity.id) {
    const proof = await required(source.sessionTransfer.cancel({ sessionID, scopeID }))
    await required(
      target.sessionTransfer.discard({ migrationID: status.migrationID, sessionTransferCancellation: proof }),
    )
  }
  const migrationID = status && status.phase !== "cancelled" ? status.migrationID : input.migrationID
  let state = status
  if (!state || state.phase === "cancelled" || state.phase === "preparing") {
    input.progress?.("preparing")
    state = await required(
      source.sessionTransfer.prepare({
        sessionID,
        scopeID,
        sessionTransferPrepare: { migrationID, targetID: identity.id },
      }),
    )
  }
  let receipt: SessionTransferReceipt
  if (state.phase === "committed" || state.phase === "completed") {
    receipt = await required(target.sessionTransfer.destination({ migrationID }))
  } else {
    input.progress?.("copying")
    const response = await source.sessionTransfer.archive({ sessionID, scopeID }, { parseAs: "blob" })
    const blob: unknown = response.data
    if (!(blob instanceof Blob)) throw new Error("Session transfer download did not return a file")
    receipt = await required(
      target.sessionTransfer.stage({ file: new File([blob], "session-transfer.zip", { type: "application/zip" }) }),
    )
  }
  if (receipt.phase !== "activated") {
    input.progress?.("committing")
    const activation = await required(
      source.sessionTransfer.commit({ sessionID, scopeID, sessionTransferReceipt: receipt }),
    )
    input.progress?.("activating")
    receipt = await required(target.sessionTransfer.activate({ sessionTransferActivation: activation }))
  }
  if (state.phase !== "completed")
    await required(source.sessionTransfer.complete({ sessionID, scopeID, sessionTransferReceipt: receipt }))
  input.progress?.("completed")
  return receipt
}
