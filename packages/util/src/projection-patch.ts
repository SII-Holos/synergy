import { z } from "zod"
import { JsonValue } from "./json-value"

export const ProjectionPatch = z.object({
  path: z.array(z.string()).max(64),
  value: JsonValue.optional(),
  remove: z.literal(true).optional(),
})
export type ProjectionPatch = z.infer<typeof ProjectionPatch>
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
const safe = (key: string) => !["__proto__", "prototype", "constructor"].includes(key)

export function projectionPatch(previous: unknown, next: unknown): ProjectionPatch[] {
  const changes: ProjectionPatch[] = []
  const visit = (before: unknown, after: unknown, path: string[]) => {
    if (before === after) return
    if (!object(before) || !object(after) || Array.isArray(before) !== Array.isArray(after)) {
      changes.push(after === undefined ? { path, remove: true } : { path, value: after as ProjectionPatch["value"] })
      return
    }
    for (const key of Object.keys(after)) {
      if (!safe(key)) throw new Error("Invalid projection key")
      visit(before[key], after[key], [...path, key])
    }
    if (Array.isArray(after)) {
      if (before.length !== after.length) changes.push({ path: [...path, "length"], value: after.length })
      return
    }
    for (const key of Object.keys(before)) if (!(key in after)) changes.push({ path: [...path, key], remove: true })
  }
  visit(previous, next, [])
  return changes
}

export function applyProjectionPatch(previous: unknown, changes: ProjectionPatch[]): unknown {
  let value = previous
  const copies = new WeakMap<object, Record<string, unknown>>()
  const copy = (input: unknown) => {
    if (!object(input)) throw new Error("Invalid projection parent")
    let result = copies.get(input)
    if (result) return result
    result = (Array.isArray(input) ? [...input] : { ...input }) as Record<string, unknown>
    copies.set(input, result)
    copies.set(result, result)
    return result
  }
  for (const change of changes) {
    if (!change.path.every(safe)) throw new Error("Invalid projection path")
    if (!change.path.length) {
      value = change.remove ? undefined : structuredClone(change.value)
      continue
    }
    value = copy(value)
    let parent = value as Record<string, unknown>
    for (const key of change.path.slice(0, -1)) {
      if (!object(parent) || !Object.hasOwn(parent, key)) throw new Error("Missing projection parent")
      parent[key] = copy(parent[key])
      parent = parent[key] as Record<string, unknown>
    }
    if (!object(parent)) throw new Error("Invalid projection parent")
    const key = change.path.at(-1)!
    if (change.remove) delete parent[key]
    else parent[key] = structuredClone(change.value)
  }
  return value
}
