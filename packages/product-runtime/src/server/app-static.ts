import path from "node:path"

export type AppStaticRequest =
  | { type: "file"; path: string; immutable: boolean }
  | { type: "missing" }
  | { type: "spa" }

export async function resolveAppStaticRequest(appDist: string, reqPath: string): Promise<AppStaticRequest> {
  const exact = path.join(appDist, reqPath)
  if (await isFileWithin(appDist, exact)) {
    return { type: "file", path: exact, immutable: reqPath.includes("/assets/") }
  }

  const assetsIdx = reqPath.lastIndexOf("/assets/")
  if (assetsIdx >= 0) {
    const normalized = path.join(appDist, reqPath.slice(assetsIdx))
    if (await isFileWithin(appDist, normalized)) {
      return { type: "file", path: normalized, immutable: true }
    }
    return { type: "missing" }
  }

  const basename = reqPath.split("/").pop()
  if (basename?.includes(".")) {
    const rootCandidate = path.join(appDist, basename)
    if (rootCandidate !== exact && (await isFileWithin(appDist, rootCandidate))) {
      return { type: "file", path: rootCandidate, immutable: false }
    }
    return { type: "missing" }
  }

  return { type: "spa" }
}

async function isFileWithin(appDist: string, candidate: string): Promise<boolean> {
  const root = path.resolve(appDist)
  const resolved = path.resolve(candidate)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return false
  const file = Bun.file(resolved)
  if (!(await file.exists().catch(() => false))) return false
  const stat = await file.stat()
  return !stat.isDirectory()
}
