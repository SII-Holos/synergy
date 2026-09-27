import type { Hono } from "hono"
import { Server } from "./server"
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

export function mountApp(app: Hono, directory: string) {
  app
    .use("/*", async (c, next) => {
      const reqPath = decodeURI(new URL(c.req.url).pathname)

      const serveFile = (resolved: string, immutable?: boolean) => {
        const file = Bun.file(resolved)
        if (immutable) c.header("Cache-Control", "public, immutable, max-age=31536000")
        else if (path.extname(resolved) === ".html") c.header("Cache-Control", "no-cache")
        c.header("Content-Security-Policy", Server.spaCsp())
        return c.body(file.stream(), { headers: { "Content-Type": file.type || "application/octet-stream" } })
      }

      const resolved = await resolveAppStaticRequest(directory, reqPath)
      if (resolved.type === "file") return serveFile(resolved.path, resolved.immutable)
      if (resolved.type === "missing") return c.notFound()
      return next()
    })
    .get("/*", async (c) => {
      const file = Bun.file(path.join(directory, "index.html"))
      if (await file.exists().catch(() => false)) {
        const html = await file.text()
        const reqPath = new URL(c.req.url).pathname
        const routeTag = `<script>window.__SYNERGY_ROUTE__=${JSON.stringify(reqPath)}</script>`
        c.header("Cache-Control", "no-cache")
        c.header("Content-Security-Policy", Server.spaCsp())
        const rendered = html.includes("<head>")
          ? html.replace("<head>", `<head>\n${routeTag}`)
          : html.includes("</head>")
            ? html.replace("</head>", `${routeTag}\n</head>`)
            : routeTag + html
        return c.body(rendered, { headers: { "Content-Type": "text/html; charset=utf-8" } })
      }
      return c.notFound()
    })
}
