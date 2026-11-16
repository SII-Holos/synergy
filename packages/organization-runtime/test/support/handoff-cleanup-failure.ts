import { safeCrossOSFailure } from "./cross-os-transport"

const sourceFiles = new Set([
  "packages/harness/src/lifecycle/runtime.ts",
  "packages/harness/src/lifecycle/components.ts",
  "packages/harness/src/environment/execution-source.ts",
  "packages/harness/src/storage/storage.ts",
  "packages/harness/src/storage/transactional-store.ts",
  "packages/harness/src/storage/sqlite-worker-client.ts",
  "packages/organization-runtime/src/runtime.ts",
  "packages/organization-runtime/src/bridge.ts",
  "packages/organization-runtime/src/connection.ts",
  "packages/organization-runtime/src/sync-exporter.ts",
  "packages/organization-runtime/src/release-observer.ts",
  "packages/organization-runtime/src/handoff-runtime.ts",
  "packages/organization-runtime/src/handoff-source.ts",
  "packages/organization-runtime/src/handoff-recovery.ts",
])
const wrappers = new Set([
  "Synergy runtime cleanup failed",
  "Component resource cleanup failed",
  "Organization execution and bridge did not close",
  "Shared transcript exporter cleanup failed",
  "Execution cleanup index could not drain",
  "Environment execution sources did not close",
  "Environment admissions are still retained by their original owners",
  "Source physical handoff claims could not be released",
])

function graph(original: unknown) {
  let unavailableFields = 0
  const own = (value: unknown, key: string): unknown => {
    try {
      if (typeof value !== "object" || value === null) return
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor && "value" in descriptor ? descriptor.value : undefined
    } catch {
      unavailableFields++
    }
  }
  const queue: Array<{
    value: unknown
    parent: number | null
    relation: "root" | "cause" | "errors"
    depth: number
    index?: number
  }> = [{ value: original, parent: null, relation: "root", depth: 0 }]
  const seen = new Set<unknown>()
  const facts: unknown[] = []
  let truncated = false
  let repeatedReferences = 0
  while (queue.length && facts.length < 16) {
    const item = queue.shift()!
    if (seen.has(item.value)) {
      repeatedReferences++
      continue
    }
    seen.add(item.value)
    const frames: Array<{ file: string; line: number; column: number }> = []
    const stack = own(item.value, "stack")
    if (typeof stack === "string")
      for (const line of stack.slice(0, 16384).split("\n").slice(1, 20)) {
        const match = line.match(/(?:^|\/)(packages\/[A-Za-z0-9_./-]+\.ts):(\d{1,7}):(\d{1,7})(?:\)|\s|$)/)
        if (!match || !sourceFiles.has(match[1])) continue
        frames.push({ file: match[1], line: Number(match[2]), column: Number(match[3]) })
        if (frames.length === 4) break
      }
    const message = own(item.value, "message")
    const errors = own(item.value, "errors")
    let length: unknown
    try {
      if (Array.isArray(errors)) length = own(errors, "length")
    } catch {
      unavailableFields++
    }
    const count = typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : undefined
    const parent = facts.length
    facts.push({
      ...safeCrossOSFailure(item.value),
      frames,
      parent: item.parent,
      relation: item.relation,
      ...(item.index === undefined ? {} : { index: item.index }),
      ...(typeof message === "string" && wrappers.has(message) ? { wrapper: message } : {}),
      ...(count === undefined ? {} : { aggregateCount: count }),
    })
    const cause = own(item.value, "cause")
    if (item.depth >= 8) {
      truncated ||= cause !== undefined || (count !== undefined && count > 0)
      continue
    }
    if (cause !== undefined) queue.push({ value: cause, parent, relation: "cause", depth: item.depth + 1 })
    if (count !== undefined) {
      truncated ||= count > 8
      for (let index = 0; index < Math.min(count, 8); index++) {
        const value = own(errors, String(index))
        if (value !== undefined) queue.push({ value, parent, relation: "errors", index, depth: item.depth + 1 })
      }
    }
  }
  return { facts, truncated: truncated || queue.length > 0, unavailableFields, repeatedReferences }
}

export function observeHandoffCleanupFailure<T>(
  original: T,
  participant: "source" | "target",
  write: (text: string) => unknown = (text) => process.stderr.write(text),
): T {
  try {
    write("EMPTY_ENVIRONMENT_HANDOFF_CLEANUP_FAILURE " + JSON.stringify({ participant, ...graph(original) }) + "\n")
  } catch {}
  return original
}
