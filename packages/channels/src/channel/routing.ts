import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import type { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import type { MessageContext } from "./types"
export interface ChannelRoute {
  sessionID: string
  scopeKey: string
  interaction: SessionInteraction.Info
  preserveChatName?: boolean
  replyToMessageId?: string
  textPrefix?: string
  delivery?: "explicit"
}
type Resolver = (context: MessageContext) => Promise<ChannelRoute | undefined> | ChannelRoute | undefined
const state = RuntimeContext.state(() => ({
  routes: new Map<string, Resolver>(),
  delivery: new Map<string, (session: SessionInfo) => boolean>(),
}))
export function registerChannelRouting(owner: string, resolver: Resolver) {
  RuntimeContext.assertCompositionOpen("Channel routing")
  if (state().routes.has(owner)) throw new Error(`Duplicate Channel routing ${owner}`)
  state().routes.set(owner, resolver)
}
export async function resolveChannelRouting(context: MessageContext) {
  for (const resolver of state().routes.values()) {
    const route = await resolver(context)
    if (route) return route
  }
}
export function registerChannelDeliveryPolicy(owner: string, allowAutomatic: (session: SessionInfo) => boolean) {
  RuntimeContext.assertCompositionOpen("Channel delivery policy")
  if (state().delivery.has(owner)) throw new Error(`Duplicate Channel delivery policy ${owner}`)
  state().delivery.set(owner, allowAutomatic)
}
export function allowsAutomaticChannelDelivery(session: SessionInfo) {
  return [...state().delivery.values()].every((allow) => allow(session))
}
