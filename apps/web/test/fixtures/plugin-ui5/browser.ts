import path from "node:path"
import { chromium } from "playwright"
import { createServer } from "vite"
import solidPlugin from "vite-plugin-solid"

export async function openUIFixture(
  entry: string,
  route = "/",
  assets: Record<string, { body: string; type: string }> = {},
) {
  const requests = new Map<string, number>()
  const server = await createServer({
    configFile: false,
    root: import.meta.dir,
    optimizeDeps: { entries: [path.resolve(import.meta.dir, entry)] },
    plugins: [
      solidPlugin(),
      {
        name: "ui-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const pathname = new URL(req.url ?? "/", "http://fixture").pathname
            if (Object.hasOwn(assets, pathname)) {
              const asset = assets[pathname]!
              requests.set(pathname, (requests.get(pathname) ?? 0) + 1)
              res.setHeader("Content-Type", asset.type)
              res.setHeader("Cache-Control", "private, max-age=31536000, immutable")
              res.end(asset.body)
              return
            }
            if (pathname.includes(".") || pathname.startsWith("/@") || pathname.startsWith("/node_modules"))
              return next()
            res.setHeader("Content-Type", "text/html")
            res.end(`<div id="root"></div><script type="module" src="/${entry}"></script>`)
          })
        },
      },
    ],
    resolve: { alias: { "@": path.resolve(import.meta.dir, "../../../src") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] } },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(new URL(route, server.resolvedUrls!.local[0]).href, { waitUntil: "domcontentloaded" })
  let closed = false
  return {
    page,
    errors,
    requests,
    async close() {
      if (closed) return
      closed = true
      try {
        await page.close()
      } finally {
        try {
          await browser.close()
        } finally {
          await server.close()
        }
      }
    },
  }
}
