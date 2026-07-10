import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import { BrowserNetworkGateway } from "../../src/browser/network-gateway"
import type { BrowserOwner } from "../../src/browser/owner"

afterEach(() => BrowserNetworkGateway.stop())

describe("BrowserNetworkGateway address policy", () => {
  test("permanently blocks metadata, link-local, multicast, and sensitive localhost ports", async () => {
    await expect(BrowserNetworkGateway.assertAddressAllowed("169.254.169.254", 80)).rejects.toMatchObject({
      code: "browser_network_denied",
    })
    await expect(BrowserNetworkGateway.assertAddressAllowed("169.254.1.2", 80)).rejects.toMatchObject({
      code: "browser_network_denied",
    })
    await expect(BrowserNetworkGateway.assertAddressAllowed("224.0.0.1", 80)).rejects.toMatchObject({
      code: "browser_network_denied",
    })
    await expect(BrowserNetworkGateway.assertAddressAllowed("127.0.0.1", 6379)).rejects.toMatchObject({
      code: "browser_network_denied",
    })
  })

  test("requires a distinct grant for private addresses", async () => {
    await expect(BrowserNetworkGateway.assertAddressAllowed("10.0.0.8", 443)).rejects.toMatchObject({
      code: "browser_network_denied",
    })
    const grant = await BrowserNetworkGateway.privateNetworkGrant("https://10.0.0.8/")
    expect(grant).not.toBeNull()
    expect(await BrowserNetworkGateway.assertAddressAllowed("10.0.0.8", 443, grant ? [grant] : [])).toBe("10.0.0.8")
    await expect(
      BrowserNetworkGateway.assertAddressAllowed("10.0.0.9", 443, grant ? [grant] : []),
    ).rejects.toMatchObject({ code: "browser_network_denied" })
    await expect(
      BrowserNetworkGateway.assertAddressAllowed("10.0.0.8", 8443, grant ? [grant] : []),
    ).rejects.toMatchObject({ code: "browser_network_denied" })
  })

  test("allows controlled localhost development ports and public addresses", async () => {
    expect(await BrowserNetworkGateway.assertAddressAllowed("127.0.0.1", 5173)).toBe("127.0.0.1")
    expect(await BrowserNetworkGateway.assertAddressAllowed("93.184.216.34", 443)).toBe("93.184.216.34")
  })

  test("revoking an owner closes its authenticated CONNECT tunnels", async () => {
    const accepted = new Set<net.Socket>()
    const target = net.createServer((socket) => {
      accepted.add(socket)
      socket.once("close", () => accepted.delete(socket))
    })
    const targetPort = await listenOnDevelopmentPort(target)
    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "network-scope",
      sessionID: "network-session",
      directory: "/tmp",
    }
    try {
      const proxy = await BrowserNetworkGateway.proxyFor(owner)
      const proxyURL = new URL(proxy.server)
      const socket = net.connect({ host: proxyURL.hostname, port: Number(proxyURL.port) })
      const connected = new Promise<void>((resolve, reject) => {
        socket.once("error", reject)
        socket.on("data", (data) => {
          if (data.toString().includes("200 Connection Established")) resolve()
        })
      })
      socket.write(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n\r\n`,
      )
      await withTimeout(connected, "Browser proxy did not establish the CONNECT tunnel.")
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
      BrowserNetworkGateway.revoke(owner)
      await withTimeout(closed, "Revoked Browser tunnel remained open.")
    } finally {
      for (const socket of accepted) socket.destroy()
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
  })
})

async function listenOnDevelopmentPort(server: net.Server): Promise<number> {
  for (let port = 5_173; port <= 5_183; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, "127.0.0.1", resolve)
      })
      return port
    } catch (error) {
      server.removeAllListeners("error")
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
    }
  }
  throw new Error("No approved Browser development port was available for the test.")
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), 1_000)),
  ])
}
