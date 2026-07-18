/**
 * Recursive canonical JSON serialization.
 *
 * Produces a deterministic JSON string for plain objects and arrays by sorting
 * object keys at every level.  Undefined values are normalized to null.
 * Non-plain objects (Date, Map, Set, etc.) and unsupported values
 * (functions, symbols) are rejected with a descriptive error.
 * Cyclic references are detected and rejected.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function canonicalStringifyInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null
  if (value === undefined) return null

  const type = typeof value
  if (type === "string" || type === "number" || type === "boolean") return value

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error("Canonical serialization does not support cyclic references")
    }
    seen.add(value)
    try {
      return value.map((v) => canonicalStringifyInner(v, seen))
    } finally {
      seen.delete(value)
    }
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) {
      throw new Error("Canonical serialization does not support cyclic references")
    }
    seen.add(value)
    try {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(value).sort()) {
        sorted[key] = canonicalStringifyInner(value[key], seen)
      }
      return sorted
    } finally {
      seen.delete(value)
    }
  }

  if (type === "object") {
    const name = value.constructor?.name ?? "Object"
    throw new Error(`Canonical serialization does not support non-plain objects (got ${name})`)
  }

  throw new Error(`Canonical serialization does not support type ${type}`)
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalStringifyInner(value, new WeakSet()))
}

/** Compute a canonical SHA-256 hash for any plain value. */
export function canonicalHash(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonicalJSON(value)).digest("base64url").slice(0, 32)
}

/** Return true iff `a` and `b` are deep-equal by canonical JSON comparison. */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalJSON(a) === canonicalJSON(b)
}
