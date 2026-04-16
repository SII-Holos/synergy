import type { Session } from "@ericsanchezok/synergy-sdk/client"

export function isHolosSession(
  session: Pick<Session, "endpoint"> | undefined,
): session is Pick<Session, "endpoint"> & { endpoint: { kind: "holos"; agentId: string } } {
  return session?.endpoint?.kind === "holos"
}
