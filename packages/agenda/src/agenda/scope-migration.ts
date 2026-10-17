import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
export function upgradeAgendaOriginScope(key: string[], value: Record<string, unknown>): void {
  if (key[0] !== "agenda" || key[1] !== "items" || key.length !== 4) return
  const scope = record(record(value.origin)?.scope)
  if (!scope || (scope.type !== "home" && scope.id !== "home")) return
  delete scope.directory
  delete scope.worktree
  delete scope.vcs
  delete scope.sandboxes
  Object.assign(scope, Scope.home())
}

function upgrade(value: Record<string, unknown>) {
  if (value.scopeID === "global") value.scopeID = "home"
  const origin = record(value.origin)
  const scope = record(origin?.scope)
  if (scope?.id === "global") scope.id = "home"
  if (scope?.type === "global") scope.type = "home"
  if (origin?.scopeID === "global") origin.scopeID = "home"
}
export async function migrateAgendaHomeScope() {
  for (const root of ["items", "runs", "run_index"]) {
    const keys = [["agenda", root, "global"], ...(await Storage.list(["agenda", root, "global"]))]
    for (const from of keys) {
      const to = [...from]
      to[2] = "home"
      await Storage.transaction(async (tx) => {
        const [source, target] = await tx.readMany<Record<string, unknown>>([from, to])
        if (!source) return
        const next = structuredClone(source)
        upgrade(next)
        if (target && JSON.stringify(target) !== JSON.stringify(next))
          throw new Error(`Agenda scope migration conflict: ${from.join("/")}`)
        await tx.write(to, next)
        await tx.remove(from)
      })
    }
  }
  for (const prefix of [
    ["agenda", "items", "home"],
    ["agenda", "runs", "home"],
    ["agenda", "run_index", "home"],
    ["agenda", "sessions"],
  ])
    for (const key of [prefix, ...(await Storage.list(prefix))]) {
      await Storage.transaction(async (tx) => {
        const [value] = await tx.readMany<Record<string, unknown>>([key])
        if (!value) return
        const before = JSON.stringify(value)
        upgrade(value)
        if (before !== JSON.stringify(value)) await tx.write(key, value)
      })
    }
}
