import type { Message } from "@ericsanchezok/synergy-sdk/client"

export function createOptimisticRootMessage(input: {
  id: string
  sessionID: string
  created: number
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  metadata?: Record<string, unknown>
}): Message {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.created },
    origin: { type: "user" },
    isRoot: true,
    rootID: input.id,
    visible: true,
    agent: input.agent,
    model: input.model,
    variant: input.variant,
    metadata: input.metadata,
  }
}
