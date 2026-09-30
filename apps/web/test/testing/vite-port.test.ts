import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { get } from "node:http"
import { text } from "node:stream/consumers"
import { createServer, type ViteDevServer } from "vite"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

test("independent Vite fixtures listen together and serve only their own content", async () => {
  const roots: string[] = []
  const servers: ViteDevServer[] = []
  try {
    for (const content of ["first fixture", "second fixture"]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "synergy-vite-port-"))
      roots.push(root)
      await Bun.write(path.join(root, "probe.txt"), content)
      const server = await createServer({
        configFile: false,
        root,
        server: { host: "127.0.0.1", port: await fixturePort(), strictPort: true },
      })
      servers.push(server)
      await server.listen()
    }
    const urls = servers.map((server) => server.resolvedUrls!.local[0]!)
    expect(new Set(urls).size).toBe(2)
    expect(
      await Promise.all(
        urls.map(
          (url) =>
            new Promise<string>((resolve, reject) => {
              get(new URL("probe.txt", url), (response) => {
                void text(response).then(resolve, reject)
              }).once("error", reject)
            }),
        ),
      ),
    ).toEqual(["first fixture", "second fixture"])
  } finally {
    await Promise.allSettled(servers.map((server) => server.close()))
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  }
})
