import { expect, test } from "bun:test"
import path from "node:path"
import { get, createServer as createBackend } from "node:http"
import { text } from "node:stream/consumers"
import { createServer } from "vite"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

const read = (url: URL) =>
  new Promise<string>((resolve, reject) => {
    get(url, (response) => {
      void text(response).then(resolve, reject)
    }).once("error", reject)
  })

test("development plugin page deep links stay in the Web app while plugin assets reach the backend", async () => {
  const backend = createBackend((_request, response) => {
    response.end("plugin backend fixture")
  })
  const backendPort = await fixturePort()
  await new Promise<void>((resolve) => backend.listen(backendPort, "127.0.0.1", resolve))
  const previous = process.env.VITE_SYNERGY_SERVER_URL
  process.env.VITE_SYNERGY_SERVER_URL = `http://127.0.0.1:${backendPort}`
  const server = await createServer({
    root: path.resolve(import.meta.dir, "../.."),
    server: { host: "127.0.0.1", port: await fixturePort(), strictPort: true },
    logLevel: "silent",
  })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (!origin) throw new Error("Expected isolated Web URL")
    expect(await read(new URL("plugins/marketplace", origin))).toContain("/src/entry.tsx")
    expect(await read(new URL("plugin/assets/example/icon.svg", origin))).toBe("plugin backend fixture")
  } finally {
    await server.close()
    await new Promise<void>((resolve, reject) => backend.close((error) => (error ? reject(error) : resolve())))
    if (previous === undefined) delete process.env.VITE_SYNERGY_SERVER_URL
    else process.env.VITE_SYNERGY_SERVER_URL = previous
  }
}, 20_000)
