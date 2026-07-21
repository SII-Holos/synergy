import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import z from "zod"
import { SynergyLinkTargetStore } from "./target-store"
import { SynergyLinkTarget } from "./types"

export namespace SynergyLinkTargetService {
  export const Event = {
    Created: BusEvent.define("synergy_link.target.created", z.object({ target: SynergyLinkTarget.Info })),
    Updated: BusEvent.define("synergy_link.target.updated", z.object({ target: SynergyLinkTarget.Info })),
    Removed: BusEvent.define("synergy_link.target.removed", z.object({ id: SynergyLinkTarget.ID })),
  }

  export async function create(input: SynergyLinkTarget.CreateInput) {
    return ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const target = await SynergyLinkTargetStore.create(input)
        await Bus.publish(Event.Created, { target })
        return target
      },
    })
  }

  export async function update(id: string, input: SynergyLinkTarget.PatchInput) {
    return ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const target = await SynergyLinkTargetStore.update(id, input)
        await Bus.publish(Event.Updated, { target })
        return target
      },
    })
  }

  export async function recordProbe(id: string, input: Parameters<typeof SynergyLinkTargetStore.recordProbe>[1]) {
    return ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const target = await SynergyLinkTargetStore.recordProbe(id, input)
        await Bus.publish(Event.Updated, { target })
        return target
      },
    })
  }

  export async function remove(id: string) {
    return ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const target = await SynergyLinkTargetStore.require(id)
        await SynergyLinkTargetStore.remove(target.id)
        await Bus.publish(Event.Removed, { id: target.id })
      },
    })
  }
}
