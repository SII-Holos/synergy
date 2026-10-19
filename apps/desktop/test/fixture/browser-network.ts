import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createServer as createSecureServer } from "node:https"
import { once } from "node:events"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { BrowserNativePagePool } from "../../src/browser-native-page-pool.js"
import type { BrowserHostPageEvent } from "@ericsanchezok/synergy-browser-core"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})

async function run() {
  await app.whenReady()
  console.log("Network fixture: ready")
  const directory = await mkdtemp(path.join(app.getPath("temp"), "browser-network-"))
  const key = path.join(directory, "key.pem"),
    cert = path.join(directory, "cert.pem")
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  )
  console.log("Network fixture: certificate prepared")
  let streamRequests = 0
  const server = createServer((request, response) => {
    if (request.url === "/stream") {
      streamRequests++
      response.writeHead(200, { "Content-Type": "text/html" })
      response.write('<title>Streaming</title><p id="visible">Visible before completion</p>' + " ".repeat(4_096))
      return
    }
    response.end('<title>Upload</title><input type="file" id="upload"><p>Healthy</p>')
  })
  const secure = createSecureServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) =>
    response.end("secure"),
  )
  server.listen(0, "127.0.0.1")
  secure.listen(0, "127.0.0.1")
  await Promise.all([once(server, "listening"), once(secure, "listening")])
  const address = server.address(),
    tlsAddress = secure.address()
  assert(address && typeof address !== "string" && tlsAddress && typeof tlsAddress !== "string")
  const url = `http://127.0.0.1:${address.port}`
  console.log("Network fixture: listeners ready")
  const window = new BrowserWindow({ show: false })
  const events: BrowserHostPageEvent[] = []
  const pool = new BrowserNativePagePool({ captureWindow: () => window, navigationTimeoutMs: 100 })
  let activations = 0
  window.on("focus", () => activations++)
  try {
    const page = await pool.create({
      ownerKey: "network",
      profile: { id: "network", partition: "synergy-browser-network", revision: 0 },
      page: { id: "network-page", url: `${url}/stream`, title: "", isLoading: false, lastActiveAt: null },
      networkProxy: { server: "direct://", username: "", password: "" },
      downloadDir: directory,
      emit: (event) => events.push(event),
    })
    console.log("Network fixture: page created")
    const contents = pool.find("network", "network-page")!.generation.contents
    const identity = contents.id
    await until(() => page.state().navigation?.slow === true)
    await until(async () => {
      const result = await contents.debugger.sendCommand("Runtime.evaluate", {
        expression: 'Boolean(document.querySelector("#visible"))',
        returnByValue: true,
      })
      return result.result?.value === true
    })
    assert.equal(streamRequests, 1, "Slow streaming must never auto-refresh")
    assert.equal(page.state().navigation?.phase, "committed")
    console.log("Network fixture: streamed content")
    await page.execute({ type: "stop" })
    await page.execute({ type: "navigate", source: "user", url: `https://127.0.0.1:${tlsAddress.port}/` })
    await until(() => page.state().navigation?.phase === "failed")
    assert.match(page.state().navigation!.error!.code, /browser_load_-2[0-9]{2}/)
    await page.execute({ type: "navigate", source: "user", url })
    await until(() => page.state().title === "Upload" && !page.state().isLoading)
    await contents.debugger.sendCommand("Network.enable")
    await contents.debugger.sendCommand("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await page.execute({ type: "navigate", source: "user", url: `${url}/offline` })
    await until(() => page.state().navigation?.phase === "failed")
    assert.equal(page.state().navigation?.error?.code, "browser_load_-106")
    await contents.debugger.sendCommand("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await page.execute({ type: "navigate", source: "user", url })
    await until(() => page.state().title === "Upload" && !page.state().isLoading)
    console.log("Network fixture: offline recovered")
    await contents.executeJavaScript('document.querySelector("#upload").click()', true)
    await until(() => events.some((event) => event.type === "filechooser.request"))
    const chooser = events.find((event) => event.type === "filechooser.request")!
    assert(chooser.type === "filechooser.request")
    await page.execute({
      type: "filechooser.select",
      requestId: chooser.requestId,
      files: [
        { name: "fixture.txt", mimeType: "text/plain", dataBase64: Buffer.from("isolated upload").toString("base64") },
      ],
    })
    assert.equal(
      await contents.executeJavaScript('document.querySelector("#upload").files[0].text()'),
      "isolated upload",
    )
    assert.equal(contents.id, identity)
    assert.equal(activations, 0)
    assert.equal(window.isVisible(), false)
    console.log(
      "ACCEPTED: streaming content before completion, no automatic refresh, certificate rejection, offline and recovery, native upload interception and bytes, stable page, hidden window without activation",
    )
  } finally {
    await pool.destroy()
    window.destroy()
    server.closeAllConnections()
    secure.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => secure.close(() => resolve())),
    ])
    await rm(directory, { recursive: true, force: true })
  }
  app.quit()
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("network fixture condition timed out")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
