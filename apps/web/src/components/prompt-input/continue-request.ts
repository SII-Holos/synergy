import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"

export async function requestSessionContinue(input: {
  client: SynergyClient
  sessionID: string
  requestID: string
  pausedSince?: number
  unavailableMessage: string
}): Promise<void> {
  const { client, sessionID, requestID, pausedSince } = input
  const result = await client.session
    .continue({ sessionID, requestID, pausedSince }, { throwOnError: true })
    .catch(async (error: unknown) => {
      const current = await client.session.get({ sessionID }).catch(() => undefined)
      if (
        current?.data?.resume?.requestID === requestID &&
        !current.data.paused &&
        current.data.resume.state !== "cancelled"
      )
        return undefined
      throw error
    })
  if (!result) return
  if (!result.data?.handled || result.data.status.type === "paused" || result.data.receipt?.state === "cancelled")
    throw new Error(result.data?.reason ?? input.unavailableMessage)
}
