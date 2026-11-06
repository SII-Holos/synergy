export function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function compareSemverTuples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

export function satisfiesVersion(current: string, constraint: string): boolean {
  constraint = constraint.trim()
  const cur = parseSemver(current)
  if (!cur) return false

  if (constraint.startsWith(">=")) {
    const req = parseSemver(constraint.slice(2).trim())
    if (!req) return false
    return compareSemverTuples(cur, req) >= 0
  }
  if (constraint.startsWith("^")) {
    const req = parseSemver(constraint.slice(1).trim())
    if (!req) return false
    const [cm, cn, cp] = cur
    const [rm, rn] = req
    if (cm !== rm) return cm > rm
    return rm === 0 ? cn >= rn : true
  }
  if (constraint.startsWith("~")) {
    const req = parseSemver(constraint.slice(1).trim())
    if (!req) return false
    for (let i = 0; i < 3; i++) {
      if (cur[i] !== req[i]) return cur[i] > req[i]
    }
    return true
  }
  if (constraint.includes("x") || constraint.includes("X")) {
    const parts = constraint.split(".")
    for (let i = 0; i < parts.length && i < 3; i++) {
      if (parts[i] === "x" || parts[i] === "X") return true
      if (Number(parts[i]) !== cur[i]) return false
    }
    return true
  }
  // exact version: current >= constraint
  const exact = parseSemver(constraint)
  if (!exact) return false
  return compareSemverTuples(cur, exact) >= 0
}
