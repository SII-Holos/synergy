import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import { BrowserNetworkGateway, type BrowserProxyDescriptor } from "../../src/browser/network-gateway"
import type { BrowserOwner } from "../../src/browser/owner"

afterEach(() => BrowserNetworkGateway.stop())

describe("BrowserNetworkGateway", () => {
  test("forwards arbitrary loopback ports without classifying destination addresses", async () => {
    const target = net.createServer()
    const port = await listen(target)
    const proxy = await BrowserNetworkGateway.proxyFor(owner("first"))
    const socket = await connectTunnel(proxy, port)
    expect(socket.response).toContain("200 Connection Established")
    socket.client.destroy()
    await close(target)
  })

  test("requires one owner's complete credentials", async () => {
    const target = net.createServer()
    const port = await listen(target)
    const first = await BrowserNetworkGateway.proxyFor(owner("first"))
    const second = await BrowserNetworkGateway.proxyFor(owner("second"))

    const missing = await connectTunnel(first, port, { authorization: null })
    expect(missing.response).toContain("407 Proxy Authentication Required")
    expect(missing.response).toContain('Proxy-Authenticate: Basic realm="Synergy Browser"')
    const crossed = await connectTunnel(first, port, {
      authorization: Buffer.from(`${first.username}:${second.password}`).toString("base64"),
    })
    expect(crossed.response).toContain("407 Proxy Authentication Required")

    missing.client.destroy()
    crossed.client.destroy()
    await close(target)
  })

  test("revoking an owner closes its authenticated CONNECT tunnels", async () => {
    const target = net.createServer()
    const port = await listen(target)
    const targetOwner = owner("revoked")
    const proxy = await BrowserNetworkGateway.proxyFor(targetOwner)
    const tunnel = await connectTunnel(proxy, port)
    const closed = new Promise<void>((resolve) => tunnel.client.once("close", () => resolve()))
    BrowserNetworkGateway.revoke(targetOwner)
    await withTimeout(closed, "Revoked Browser tunnel remained open.")
    await close(target)
  })

  test("enforces the per-owner connection limit", async () => {
    const target = net.createServer()
    const port = await listen(target)
    const proxy = await BrowserNetworkGateway.proxyFor(owner("limited"))
    const tunnels = await Promise.all(Array.from({ length: 64 }, () => connectTunnel(proxy, port)))
    const rejected = await connectTunnel(proxy, port)
    expect(rejected.response).toContain("403 Forbidden")
    rejected.client.destroy()
    for (const tunnel of tunnels) tunnel.client.destroy()
    await close(target)
  })
})

function owner(id: string): BrowserOwner.Info {
  return { mode: "session", scopeID: "network-scope", sessionID: id, directory: "/tmp" }
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Target server did not bind to TCP.")
  return address.port
}

async function connectTunnel(
  proxy: BrowserProxyDescriptor,
  targetPort: number,
  options: { authorization?: string | null } = {},
): Promise<{ client: net.Socket; response: string }> {
  const proxyURL = new URL(proxy.server)
  const client = net.connect({ host: proxyURL.hostname, port: Number(proxyURL.port) })
  const response = new Promise<string>((resolve, reject) => {
    client.once("error", reject)
    client.once("data", (data) => resolve(data.toString()))
  })
  const authorization =
    options.authorization === undefined
      ? Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")
      : options.authorization
  client.write(
    `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n${authorization ? `Proxy-Authorization: Basic ${authorization}\r\n` : ""}\r\n`,
  )
  return { client, response: await withTimeout(response, "Browser proxy did not answer the CONNECT request.") }
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), 2_000)),
  ])
}
