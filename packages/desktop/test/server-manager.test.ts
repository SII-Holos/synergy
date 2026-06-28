import { describe, expect, test } from "bun:test"
import net from "node:net"
import { findAvailablePort } from "../src/server-manager.js"

describe("desktop server manager", () => {
  test("allocates a usable localhost port", async () => {
    const port = await findAvailablePort()
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer()
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve())
      })
    })
    expect(port).toBeGreaterThan(0)
  })
})
