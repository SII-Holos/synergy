import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { Hono } from "hono"

const policy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

export async function organizationWeb(directory: string) {
  if (!path.isAbsolute(directory)) throw new Error("Organization Web directory must be absolute")
  const root = await fs.realpath(directory)
  const document = await fs.realpath(path.join(root, "organization.html"))
  if (document !== path.join(root, "organization.html") || !(await fs.stat(document)).isFile())
    throw new Error("Organization Web requires a built organization.html document")
  return new Hono().get("/organization.html", serve).get("/assets/*", serve)

  async function serve(c: import("hono").Context) {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname)
    const candidate = path.resolve(root, `.${pathname}`)
    const allowed = pathname === "/organization.html" ? root : path.join(root, "assets")
    const resolved = await fs.realpath(candidate).catch(() => undefined)
    if (
      !resolved ||
      !resolved.startsWith(allowed + path.sep) ||
      (pathname === "/organization.html" && resolved !== document)
    )
      return c.notFound()
    const file = await fs.open(
      resolved,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return c.notFound()
      const content = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < content.length) {
        const { bytesRead } = await file.read(content, offset, content.length - offset, offset)
        if (!bytesRead) return c.notFound()
        offset += bytesRead
      }
      c.header("Content-Security-Policy", policy)
      c.header("X-Frame-Options", "DENY")
      // Cross-origin authorization popups retain their opener only with this policy.
      // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy
      c.header("Cross-Origin-Opener-Policy", "unsafe-none")
      return c.body(content, { headers: { "Content-Type": Bun.file(resolved).type || "application/octet-stream" } })
    } finally {
      await file.close()
    }
  }
}
