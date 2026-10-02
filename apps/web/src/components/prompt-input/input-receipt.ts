import type { SessionInputProgress, SynergyClient } from "@ericsanchezok/synergy-sdk/client"

export async function recoverSessionInputReceipt(
  client: SynergyClient,
  target: { sessionID: string; messageID: string },
): Promise<{ kind: "accepted"; progress: SessionInputProgress } | { kind: "missing" } | { kind: "uncertain" }> {
  const result = await client.session.inputStatus(target, { throwOnError: false }).catch(() => undefined)
  if (result?.response?.status === 404) return { kind: "missing" }
  const progress = result?.data
  if (progress?.durable && progress.sessionID === target.sessionID && progress.messageID === target.messageID)
    return { kind: "accepted", progress }
  return { kind: "uncertain" }
}
