import type { ExecutionSchema } from "./schema"

export namespace ExecutionProcess {
  function auxiliaryKey(node: ExecutionSchema.Node) {
    if (node.evidenceKind !== "call" || node.kind === "compaction") return
    if (node.usageRole !== "auxiliary" && (!node.modelKind || node.modelKind === "chat")) return
    return JSON.stringify([node.sessionID, node.runID, node.modelKind ?? "chat", node.purpose?.trim() || null])
  }
  export function auxiliaryMembers(nodes: readonly ExecutionSchema.Node[], node: ExecutionSchema.Node) {
    const key = auxiliaryKey(node)
    return key
      ? nodes
          .filter((row) => auxiliaryKey(row) === key)
          .toSorted((a, b) => a.started - b.started || a.id.localeCompare(b.id))
      : []
  }
  export function project(nodes: readonly ExecutionSchema.Node[], mode: "process" | "records", root?: string) {
    const byID = new Map(nodes.map((node) => [node.id, node]))
    const children = new Map<string, ExecutionSchema.Node[]>()
    const auxiliary = new Map<string, ExecutionSchema.Node[]>()
    for (const node of nodes) {
      const key = auxiliaryKey(node)
      if (key) {
        const rows = auxiliary.get(key) ?? []
        rows.push(node)
        auxiliary.set(key, rows)
      }
      if (!node.parentID) continue
      const rows = children.get(node.parentID) ?? []
      rows.push(node)
      children.set(node.parentID, rows)
    }
    const groups = new Map(
      nodes
        .filter((node) => node.evidenceKind === "call")
        .map((node) => {
          const members = children.get(node.id) ?? []
          const attempts = members.filter((child) => child.evidenceKind === "attempt")
          return [
            node.id,
            {
              id: node.id,
              started: node.started,
              callCount: 1,
              memberCount: members.length,
              attemptCount: attempts.length,
              retryCount: attempts.filter((attempt) => (attempt.attemptIndex ?? 0) > 0).length,
              anomalies: members.filter((child) => ["failed", "cancelled", "interrupted"].includes(child.status))
                .length,
              purpose: node.purpose?.trim() || null,
            },
          ] as const
        }),
    )
    const heads = new Map<string, ExecutionSchema.Node>()
    const hidden = new Set<string>()
    if (mode === "process")
      for (const members of auxiliary.values()) {
        if (members.length < 2) continue
        members.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
        const first = members[0]!
        for (const member of members.slice(1)) hidden.add(member.id)
        const counters = members.map((node) => groups.get(node.id)!)
        const status = members.some((node) => node.status === "running")
          ? "running"
          : (members.find((node) => ["failed", "cancelled", "interrupted", "unknown"].includes(node.status))?.status ??
            "completed")
        heads.set(first.id, {
          ...first,
          status,
          ended: members.every((node) => node.ended !== undefined)
            ? Math.max(...members.map((node) => node.ended!))
            : undefined,
          group: {
            id: first.id,
            started: first.started,
            callCount: members.length,
            memberCount: counters.reduce((sum, value) => sum + value.memberCount, 0),
            attemptCount: counters.reduce((sum, value) => sum + value.attemptCount, 0),
            retryCount: counters.reduce((sum, value) => sum + value.retryCount, 0),
            anomalies: counters.reduce((sum, value) => sum + value.anomalies, 0),
            purpose: first.purpose?.trim() || null,
          },
        })
      }
    return nodes
      .filter((node) => {
        if (mode === "records") return true
        if (hidden.has(node.id)) return false
        if (node.evidenceKind === "attempt") return (node.attemptIndex ?? 0) > 0
        if (node.evidenceKind !== "call" || node.kind === "compaction" || auxiliaryKey(node)) return true
        return !(children.get(node.id) ?? []).some((child) => ["reasoning", "output", "tool"].includes(child.kind))
      })
      .map((original) => {
        const node = heads.get(original.id) ?? original
        const ancestors: NonNullable<ExecutionSchema.Node["ancestors"]> = []
        const seen = new Set<string>([node.id])
        let parent = node.parentID && byID.get(node.parentID)
        while (parent && !seen.has(parent.id)) {
          seen.add(parent.id)
          ancestors.unshift({ id: parent.id, title: parent.title, kind: parent.kind })
          parent = parent.parentID && byID.get(parent.parentID)
        }
        const rootRunID =
          !root || node.sessionID === root
            ? node.runID
            : (ancestors.map((ancestor) => byID.get(ancestor.id)).find((ancestor) => ancestor?.sessionID === root)
                ?.runID ?? null)
        return {
          ...node,
          ancestors,
          rootRunID,
          attribution: node.attribution ?? (rootRunID === null ? ("unassigned" as const) : ("known" as const)),
          group: node.group ?? groups.get(node.id) ?? (node.parentID ? groups.get(node.parentID) : undefined),
        }
      })
  }
}
