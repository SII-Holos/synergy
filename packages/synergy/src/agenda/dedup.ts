import { AgendaStore } from "./store"
import { AgendaTypes } from "./types"

export namespace AgendaDedup {
  // ---------------------------------------------------------------------------
  // Token Jaccard similarity for short titles
  // ---------------------------------------------------------------------------

  const TITLE_SIMILARITY_THRESHOLD = 0.5

  function tokenize(text: string): Set<string> {
    return new Set(text.toLowerCase().split(/\s+/).filter(Boolean))
  }

  export function titleSimilarity(a: string, b: string): number {
    const sa = tokenize(a)
    const sb = tokenize(b)
    if (sa.size === 0 && sb.size === 0) return 1
    const intersection = [...sa].filter((w) => sb.has(w)).length
    const union = new Set([...sa, ...sb]).size
    return union === 0 ? 0 : intersection / union
  }

  // ---------------------------------------------------------------------------
  // Trigger structural matching
  // ---------------------------------------------------------------------------

  export function triggersConflict(a: AgendaTypes.Trigger, b: AgendaTypes.Trigger): boolean {
    if (a.type !== b.type) return false

    switch (a.type) {
      case "watch": {
        const bw = b as Extract<typeof b, { type: "watch" }>
        if (a.watch.kind !== bw.watch.kind) return false

        switch (a.watch.kind) {
          case "poll": {
            const aw = a.watch as Extract<typeof a.watch, { kind: "poll" }>
            const bww = bw.watch as Extract<typeof bw.watch, { kind: "poll" }>
            return aw.command === bww.command
          }
          case "tool": {
            const aw = a.watch as Extract<typeof a.watch, { kind: "tool" }>
            const bww = bw.watch as Extract<typeof bw.watch, { kind: "tool" }>
            if (aw.tool !== bww.tool) return false
            return JSON.stringify(aw.args ?? {}) === JSON.stringify(bww.args ?? {})
          }
          case "file": {
            const aw = a.watch as Extract<typeof a.watch, { kind: "file" }>
            const bww = bw.watch as Extract<typeof bw.watch, { kind: "file" }>
            return aw.glob === bww.glob && aw.event === bww.event
          }
        }
        break
      }
      case "cron": {
        const bc = b as Extract<typeof b, { type: "cron" }>
        return a.expr === bc.expr && a.tz === bc.tz
      }
      case "every": {
        const be = b as Extract<typeof b, { type: "every" }>
        return a.interval === be.interval
      }
    }

    return false
  }

  function hasTriggerConflict(incoming: AgendaTypes.Trigger[], existing: AgendaTypes.Trigger[]): boolean {
    for (const t of incoming) {
      for (const e of existing) {
        if (triggersConflict(t, e)) return true
      }
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Conflict result
  // ---------------------------------------------------------------------------

  export interface Conflict {
    item: AgendaTypes.Item
    reason: "trigger" | "title"
  }

  // ---------------------------------------------------------------------------
  // Find conflicting active items in scope
  // ---------------------------------------------------------------------------

  export async function findConflicts(
    scopeID: string,
    title: string,
    triggers: AgendaTypes.Trigger[],
    global: boolean = false,
  ): Promise<Conflict[]> {
    const items = await AgendaStore.listForScope(scopeID)
    const active = items.filter((item) => item.status === "active" || item.status === "pending")

    // Skip self-comparison when the same scope creates both scoped and global items
    const relevant = active.filter((item) => !global || item.global)

    const conflicts: Conflict[] = []

    for (const item of relevant) {
      if (hasTriggerConflict(triggers, item.triggers)) {
        conflicts.push({ item, reason: "trigger" })
        continue
      }
      if (titleSimilarity(title, item.title) >= TITLE_SIMILARITY_THRESHOLD) {
        conflicts.push({ item, reason: "title" })
      }
    }

    // De-duplicate: an item can only appear once, prefer trigger reason
    const seen = new Set<string>()
    const unique: Conflict[] = []
    for (const c of conflicts) {
      if (seen.has(c.item.id)) continue
      seen.add(c.item.id)
      unique.push(c)
    }

    return unique
  }

  // ---------------------------------------------------------------------------
  // Format conflict message for agent
  // ---------------------------------------------------------------------------

  function formatTriggerSummary(trigger: AgendaTypes.Trigger): string {
    if (trigger.type === "watch") {
      switch (trigger.watch.kind) {
        case "poll":
          return `watch: ${trigger.watch.command}`
        case "tool":
          return `watch: ${trigger.watch.tool}${trigger.watch.args ? ` ${JSON.stringify(trigger.watch.args)}` : ""}`
        case "file":
          return `watch: ${trigger.watch.glob}`
      }
    }
    if (trigger.type === "cron") return `cron: ${trigger.expr}`
    if (trigger.type === "every") return `every: ${trigger.interval}`
    return trigger.type
  }

  export function formatConflictMessage(conflicts: Conflict[], toolName: string): string {
    const lines = [`Found ${conflicts.length} conflicting agenda item${conflicts.length === 1 ? "" : "s"}:`]

    for (const c of conflicts) {
      const reason = c.reason === "trigger" ? "same trigger" : "similar title"
      const age = Date.now() - c.item.time.created
      const ageStr =
        age < 60_000
          ? "just now"
          : age < 3_600_000
            ? `${Math.floor(age / 60_000)}m ago`
            : `${Math.floor(age / 3_600_000)}h ago`
      const triggerStr =
        c.item.triggers.length > 0 ? c.item.triggers.map(formatTriggerSummary).join(", ") : "no triggers"
      lines.push(`- [${c.item.id}] "${c.item.title}" [${c.item.status}, ${triggerStr}] (${reason}, ${ageStr})`)
    }

    lines.push("")
    lines.push(
      `An active agenda item with ${conflicts.some((c) => c.reason === "trigger") ? "the same trigger" : "a similar title"} already exists. Consider using \`agenda_update\` to modify it instead of creating a duplicate.`,
      `If you still want to create a new item, call \`${toolName}\` again with adjusted parameters.`,
    )

    return lines.join("\n")
  }
}
