import assert from "node:assert/strict"
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { app, BrowserWindow } from "electron"
import { WebSocketServer, type WebSocket } from "ws"
import {
  BROWSER_PROTOCOL_VERSION as protocolVersion,
  BrowserHostMessageSchema,
  browserOwnerKey,
  type BrowserHostMessage,
} from "@ericsanchezok/synergy-browser-core"
import { BrowserNativePagePool } from "../../src/browser-native-page-pool"
import { browserRuntimeOwnerKey } from "../../src/browser-profile"
import { DesktopMemberBrowsers } from "../../src/organization/member-browsers"
import { DEFAULT_DESKTOP_SHELL_SKIN } from "../../src/default-shell-skin.generated"
import { desktopThemeSnapshot } from "../../src/theme"

const owner = { mode: "session" as const, scopeID: "fixture", sessionID: "fixture", directory: null }
const ownerKey = browserOwnerKey(owner)
void run().catch((error) => {
  console.error(error)
  app.exit(1)
})

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Member native broker condition timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function host(connectionID: string) {
  const token = randomBytes(32).toString("hex")
  const authorization = "Bearer " + randomBytes(32).toString("hex")
  const messages: BrowserHostMessage[] = []
  let socket: WebSocket | undefined
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html")
    response.end("<!doctype html><title>Member broker</title><textarea id=draft></textarea>")
  })
  const ws = new WebSocketServer({ noServer: true })
  server.on("upgrade", (request, transport, head) => {
    if (request.headers.authorization !== authorization) {
      transport.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      return
    }
    assert.equal(request.headers.cookie, undefined)
    assert.equal(request.headers.origin, undefined)
    assert.equal(request.url, `/browser/host/broker?protocolVersion=${protocolVersion}`)
    ws.handleUpgrade(request, transport, head, (client) => ws.emit("connection", client))
  })
  ws.on("connection", (client) => {
    socket = client
    client.on("message", (data) => {
      const message = BrowserHostMessageSchema.parse(JSON.parse(String(data)))
      messages.push(message)
      if (message.type === "host.register") {
        assert.equal(message.token, token)
        client.send(JSON.stringify({ type: "host.registered", protocolVersion, hostId: message.hostId }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  return {
    member: { connectionID, runtimeID: "colliding-runtime", browser: { url, token, headers: { authorization } } },
    messages,
    async request(message: BrowserHostMessage) {
      assert("requestId" in message)
      socket!.send(JSON.stringify(message))
      await until(() =>
        messages.some((result) => result.type === "page.result" && result.requestId === message.requestId),
      )
      const result = messages.find((result) => result.type === "page.result" && result.requestId === message.requestId)
      assert(result?.type === "page.result")
      assert.equal(result.error, undefined)
      return result.result
    },
    disconnect() {
      socket!.terminate()
    },
    async close() {
      for (const client of ws.clients) client.terminate()
      await new Promise<void>((resolve, reject) => ws.close((error) => (error ? reject(error) : resolve())))
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

async function run() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false })
  const pool = new BrowserNativePagePool({ captureWindow: () => window })
  const theme = desktopThemeSnapshot({ version: 2, source: "system", ...DEFAULT_DESKTOP_SHELL_SKIN }, false)
  const browsers = new DesktopMemberBrowsers({ nativePool: pool, theme: () => theme, clearSavedData: async () => {} })
  const hosts = await Promise.all([host("member-a"), host("member-b")])
  const services: Array<{ close(): Promise<void> }> = []
  try {
    for (const server of hosts) services.push(await browsers.start(server.member))
    await until(() => hosts.every((server) => server.messages.some((message) => message.type === "host.register")))
    const contents = []
    for (const [index, server] of hosts.entries()) {
      const result = await server.request({
        type: "page.create",
        protocolVersion,
        requestId: "create",
        ownerKey,
        owner,
        routeDirectory: app.getPath("temp"),
        presentation: "native",
        page: { id: "same-page", url: "about:blank", title: "", isLoading: false, lastActiveAt: null },
        profile: { id: "personal", partition: "persist:synergy-browser-shared", revision: 1 },
        networkProxy: { server: "direct://", username: "unused", password: "unused" },
        downloadDir: app.getPath("temp"),
      })
      assert.equal(result?.type, "page")
      await server.request({
        type: "page.command",
        protocolVersion,
        requestId: "navigate",
        ownerKey,
        pageId: "same-page",
        command: { type: "navigate", source: "user", url: server.member.browser.url },
      })
      const entry = pool.find(browserRuntimeOwnerKey(server.member.connectionID, ownerKey), "same-page")!
      await until(() => entry.state().title === "Member broker" && !entry.state().isLoading)
      contents.push(entry.generation.contents)
      await entry.generation.contents.executeJavaScript(`document.getElementById('draft').value='member-${index}'`)
    }
    assert.notEqual(contents[0]!.session, contents[1]!.session)
    hosts[0]!.disconnect()
    await until(() => hosts[0]!.messages.filter((message) => message.type === "host.register").length === 2)
    assert.equal(contents[0]!.isDestroyed(), true)
    assert.equal(
      hosts[0]!.messages.filter((message) => message.type === "page.result" && message.result?.type === "page").length,
      1,
    )
    await services[0]!.close()
    assert.equal(contents[1]!.isDestroyed(), false)
    assert.equal(await contents[1]!.executeJavaScript("document.getElementById('draft').value"), "member-1")
    await services[1]!.close()
    assert.equal(contents[1]!.isDestroyed(), true)
    console.log(
      "Member native broker passed: Node upgrade authentication, native token separation, colliding identities, reconnect without replay, independent close and drained WebContents.",
    )
  } finally {
    await Promise.allSettled(services.map((service) => service.close()))
    await pool.destroy()
    window.destroy()
    await Promise.all(hosts.map((server) => server.close()))
  }
  app.exit(0)
}
