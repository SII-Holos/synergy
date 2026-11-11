import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import {
  OrganizationReadProtocol as Read,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import type { z } from "zod"
import { createSessionReader } from "./session-read"
import { readNativeContent } from "./read-content"
import { createInteractionReader } from "./interactions"
import { OrganizationInteractionProtocol as Interactions } from "@ericsanchezok/synergy-organization-protocol"
import type { RuntimeIdentity } from "./home"
import { OrganizationRuntimeError } from "./error"

export namespace OrganizationSessionReads {
  const state = RuntimeContext.state(() => ({
    reader: undefined as ReturnType<typeof createSessionReader> | undefined,
    interactions: undefined as ReturnType<typeof createInteractionReader> | undefined,
  }))
  export function register(identity: RuntimeIdentity, runtimeID: string) {
    RuntimeContext.assertCompositionOpen("native organization reading")
    if (state().reader) throw new Error("Native organization reading is already registered")
    state().reader = createSessionReader({ identity, runtimeID, content: readNativeContent })
    state().interactions = createInteractionReader({ identity, runtimeID })
  }
  function reader() {
    const reader = state().reader
    if (!reader)
      throw new OrganizationRuntimeError({
        code: "SERVICE_UNAVAILABLE",
        message: "Native organization reading is unavailable",
        retryable: false,
        outcome: "not_dispatched",
      })
    return reader
  }
  export const local = (query: Read.Input, signal?: AbortSignal) => reader().local(query, signal)
  export const remote = (
    authorization: Read.SignedPermit,
    connection: z.infer<typeof Runtime.Connected>,
    signal?: AbortSignal,
  ) => reader().remote(authorization, connection, signal)
  export const interactions = (
    authorization: Interactions.SignedPermit,
    connection: z.infer<typeof Runtime.Connected>,
    signal?: AbortSignal,
  ) => {
    const selected = state().interactions
    if (!selected)
      throw new OrganizationRuntimeError({
        code: "SERVICE_UNAVAILABLE",
        message: "Native interaction reading is unavailable",
        retryable: false,
        outcome: "not_dispatched",
      })
    return selected.remote(authorization, connection, signal)
  }
}
