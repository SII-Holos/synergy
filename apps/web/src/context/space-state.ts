import { createSignal, untrack } from "solid-js"
import { z } from "zod"
import { OrganizationIdentity } from "@ericsanchezok/synergy-organization-protocol"

export const SpaceIdentity = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal"), localRuntimeID: z.uuid() }),
  z.strictObject({
    kind: z.literal("organization"),
    orgID: OrganizationIdentity.ID,
    accountID: OrganizationIdentity.ID,
    deploymentIncarnation: OrganizationIdentity.ID,
  }),
])
export type SpaceIdentity = z.infer<typeof SpaceIdentity>

export function spaceKey(input: SpaceIdentity) {
  const identity = SpaceIdentity.parse(input)
  return JSON.stringify(
    identity.kind === "personal"
      ? [identity.kind, identity.localRuntimeID]
      : [identity.kind, identity.orgID, identity.accountID, identity.deploymentIncarnation],
  )
}

export type SpaceView = {
  readonly identity: SpaceIdentity
  readonly key: string
  readonly generation: number
  readonly signal: AbortSignal
}

export function createSpaceView() {
  const [current, setCurrent] = createSignal<SpaceView>()
  let controller: AbortController | undefined
  let generation = 0
  return {
    current,
    select(input: SpaceIdentity) {
      const identity = Object.freeze(SpaceIdentity.parse(input))
      controller?.abort()
      controller = new AbortController()
      const view = Object.freeze({
        identity,
        key: spaceKey(identity),
        generation: ++generation,
        signal: controller.signal,
      })
      setCurrent(view)
      return view
    },
    isCurrent(view: SpaceView) {
      return !view.signal.aborted && untrack(current) === view
    },
    clear() {
      controller?.abort()
      controller = undefined
      setCurrent(undefined)
    },
  }
}
