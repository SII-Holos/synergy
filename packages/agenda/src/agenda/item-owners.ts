import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { AgendaTypes } from "./types"
import { AgendaGithubSource } from "./github-source"

export namespace AgendaItemOwners {
  type Item = Pick<AgendaTypes.Item, "id" | "agent" | "tags" | "deliveryMode" | "triggers"> & {
    requiredOwners?: readonly string[]
  }
  const selected = RuntimeContext.state(() => new Set<string>())
  export function register(owner: string) {
    RuntimeContext.assertCompositionOpen("Agenda item owners")
    if (selected().has(owner)) throw new Error(`Agenda item owner already registered: ${owner}`)
    selected().add(owner)
  }
  export function requirements(item: Item): readonly string[] {
    if (item.requiredOwners) return item.requiredOwners
    if (item.id === "anima-daily" || item.agent === "anima") return ["anima"]
    if (item.id === "boss-briefing") return ["boss"]
    if (item.id.startsWith("boss-briefing-")) return ["boss", "boss-feishu"]
    if (item.deliveryMode === "session_guidance" && item.tags?.includes("clarus") && item.tags.includes("deadline"))
      return ["channel-clarus"]
    return []
  }
  export function available(item: Item): boolean {
    return (
      requirements(item).every((owner) => selected().has(owner)) &&
      (!item.triggers.some((trigger) => trigger.type === "github") || AgendaGithubSource.selected())
    )
  }
  export function assert(item: Item) {
    if (!available(item)) throw new Error(`Agenda item is unavailable without its owning components: ${item.id}`)
  }
}
