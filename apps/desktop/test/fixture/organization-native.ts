import { app, BrowserWindow, ipcMain, safeStorage } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationClientAuth as Auth,OrganizationReadProtocol as Read,type OrganizationProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { DesktopOrganizationAccounts } from "../../src/organization/accounts"
import { DesktopOrganizationAuthorization } from "../../src/organization/authorization"
import { DesktopOrganizationIPC, registerOrganizationIPC } from "../../src/organization/ipc"
import { organizationEncryption } from "../../src/organization/encryption"
import { trustedServerFrame } from "../../src/server-ipc"
import { saveOrganizationDownload } from "../../src/organization/download"

const root = path.dirname(fileURLToPath(import.meta.url))
app.setName(path.basename(path.dirname(root)))
const info = JSON.parse(await fs.readFile(path.join(root, "service.json"), "utf8")) as { url: string; issuer: string }
app.setPath("userData", path.join(root, "user-data"))
app.once("ready", () => app.setActivationPolicy?.("accessory"))
let window: BrowserWindow | undefined
let child: BrowserWindow | undefined
let ipc: DesktopOrganizationIPC<Parameters<typeof trustedServerFrame>[0]> | undefined
const binaryBytes = new Uint8Array([0, 255, 128, 10])
const binaryPath = `/org/v1/sessions/native-session/blobs/${"b".repeat(64)}`
const binaryEntered = Promise.withResolvers<void>()
const binaryClosed = Promise.withResolvers<void>()
const nativeEntered = Promise.withResolvers<void>()
const nativeReleased = Promise.withResolvers<void>()
const fieldBytes = Buffer.from("Native field 内容\n".repeat(20000))
const fieldHash = createHash("sha256").update(fieldBytes).digest("hex")
const fieldReference = {kind:"native" as const,version:"native-v1",field:"text" as const,bytes:fieldBytes.length,sha256:fieldHash,original:"partial" as const}
let nativeBinding:Protocol.SessionBinding
let uploadedBytes: Uint8Array | undefined
const server = createServer(async (request, response) => {
  if (request.url?.startsWith(binaryPath)) {
    assert.match(request.headers.authorization ?? "", /^Bearer [a-f0-9]{64}$/)
    if (request.method === "PUT") {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      uploadedBytes = new Uint8Array(Buffer.concat(chunks))
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"offset":4}')
      return
    }
    if (!request.headers.range) {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": binaryBytes.byteLength })
      response.end(binaryBytes)
      return
    }
    assert.equal(request.headers.range, "bytes=0-3")
    response.writeHead(206, { "content-type": "application/octet-stream", "content-range": "bytes 0-3/8" })
    if (request.url.includes("hold=1")) {
      response.write(binaryBytes.subarray(0, 1))
      response.once("close", () => binaryClosed.resolve())
      binaryEntered.resolve()
      return
    }
    response.end(binaryBytes)
    return
  }
  response.writeHead(200, { "content-type": "text/html" })
  response.end("<!doctype html><html><body>Organization native test</body></html>")
})
void run()
async function run() {
  try {
    console.error("organization-native: waiting for app")
    await app.whenReady()
    console.error("organization-native: opening OS credentials")
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert(address && typeof address === "object")
    const appURL = `http://127.0.0.1:${address.port}/`
    const preload = path.join(root, "preload.cjs")
    window = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const encryption = organizationEncryption(safeStorage)
    assert(await encryption.available(), "The native OS credential store must be available for this acceptance")
    console.error("organization-native: signing in to fixture")
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let hold = false
    let heldSignal: AbortSignal | undefined
    const transport: typeof fetch = async (input, init) => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init)
      assert.equal(request.credentials, "omit")
      assert.equal(request.redirect, "error")
      const target = new URL(request.url)
      assert.equal(target.origin, info.issuer)
      if (target.pathname === "/org/v1/sessions/native-session/read") {
        const query = Read.Query.parse(await request.json())
        assert.equal(query.operation,"partContent")
        if (query.operation !== "partContent") throw new Error("Unexpected native read")
        if (query.partID === "held-native-part") {nativeEntered.resolve();await nativeReleased.promise}
        return Response.json(Read.Result.parse({operation:"partContent",state:"ready",rootSessionID:query.rootSessionID,sourceSessionID:query.sourceSessionID ?? query.rootSessionID,binding:nativeBinding,
          value:{messageID:query.messageID,partID:query.partID,version:"native-v1",part:{type:"text",content:fieldReference}},
          chunk:{field:"text",offset:query.offset,nextOffset:Math.min(fieldBytes.length,query.offset+query.length),totalBytes:fieldBytes.length,sha256:fieldHash,original:"partial",data:fieldBytes.subarray(query.offset,query.offset+query.length).toString("base64url"),complete:query.offset+query.length>=fieldBytes.length},
        }))
      }
      const response = await fetch(
        new URL(target.pathname + target.search, target.pathname.startsWith(binaryPath) ? appURL : info.url),
        {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
          redirect: "error",
          credentials: "omit",
          body: request.body ? await request.arrayBuffer() : undefined,
        },
      )
      if (hold && target.pathname === "/org/v1/projects") {
        heldSignal = request.signal
        entered.resolve()
        await resume.promise
      }
      return response
    }
    const client = createOrganizationClient({
      baseUrl: info.issuer,
      fetch: transport,
      credentials: "omit",
      redirect: "error",
    })
    const login = await client.orgAuth.login(
      { orgLoginInput: { loginName: "owner", password: "desktop organization fixture password" } },
      { headers: { origin: info.issuer }, throwOnError: true },
    )
    const accountRoot = path.join(root, "accounts")
    const accounts = new DesktopOrganizationAccounts({ root: accountRoot, encryption, fetch: transport })
    const authorization = new DesktopOrganizationAuthorization({
      accounts,
      fetch: transport,
      openExternal: async (url) => {
        const request = Auth.Authorize.parse(
          JSON.parse(new URLSearchParams(new URL(url).hash.slice(1)).get("authorize")!),
        )
        const code = await client.orgAuth.authorize(
          { orgAuthorizeInput: request },
          {
            headers: {
              origin: info.issuer,
              cookie: login.response.headers.get("set-cookie")!.split(";")[0]!,
              "x-csrf-token": login.data.csrfToken,
            },
            throwOnError: true,
          },
        )
        await authorization.callback(
          `synergy://organization-auth/callback#code=${encodeURIComponent(JSON.stringify(code.data))}`,
        )
      },
    })
    ipc = new DesktopOrganizationIPC({
      accounts,
      authorization,
      fetch: transport,
      trusted: (event) => trustedServerFrame(event, window?.webContents, appURL, null),
      saveFile: (fileName, write, signal) =>
        saveOrganizationDownload({
          fileName,
          write,
          signal,
          choose: async () => path.join(root, fileName),
        }),
    })
    registerOrganizationIPC(ipcMain, ipc)
    window.webContents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) ipc?.invalidate()
    })
    await window.loadURL(appURL)
    console.error("organization-native: authorizing through preload")
    const connected = await window.webContents.executeJavaScript(
      `window.synergyDesktop.organization.connect(${JSON.stringify({ requestID: "connect", target: { issuer: info.issuer, clientID: "desktop" } })})`,
    )
    assert.equal(connected.ok, true)
    const connection = connected.value
    nativeBinding={schemaVersion:1,orgID:connection.orgID,projectID:"native-project",creatorID:connection.account.accountID,driverRuntimeID:"remote-native",bindingEpoch:1}
    console.error("organization-native: restoring sealed account")
    assert.equal(connection.account.accountID, login.data.account.accountID)
    assert.equal(JSON.stringify(connection).includes("Token"), false)
    const saved = await fs.readFile(path.join(accountRoot, `${connection.id}.json`), "utf8")
    assert.equal(saved.includes("refreshToken"), false)
    assert.equal(saved.includes("accessToken"), false)
    const recovered = new DesktopOrganizationAccounts({ root: accountRoot, encryption, fetch: transport })
    const access = await recovered.access(connection.id)
    assert.equal(saved.includes(access.accessToken), false)
    const visible = await window.webContents.executeJavaScript(
      `window.synergyDesktop.organization.request(${JSON.stringify({ requestID: "projects", connectionID: connection.id, method: "GET", path: "/org/v1/projects" })})`,
    )
    assert.equal(visible.ok, true)
    assert.equal(visible.value.status, 200)
    const binary = await window.webContents.executeJavaScript(
      `window.synergyDesktop.organization.request(${JSON.stringify({ requestID: "binary", connectionID: connection.id, method: "GET", path: binaryPath + "/content", range: "bytes=0-3" })})`,
    )
    assert.equal(binary.ok, true)
    assert.deepEqual(new Uint8Array(binary.value.bodyBytes), binaryBytes)
    assert.equal(binary.value.contentRange, "bytes 0-3/8")
    const uploaded = await window.webContents.executeJavaScript(
      `window.synergyDesktop.organization.request({ requestID: "binary-upload", connectionID: ${JSON.stringify(connection.id)}, method: "PUT", path: ${JSON.stringify(binaryPath + "?offset=0&totalBytes=4")}, bodyBytes: new Uint8Array([0,255,128,10]), contentType: "application/octet-stream" })`,
    )
    assert.equal(uploaded.ok, true)
    assert.deepEqual(uploadedBytes, binaryBytes)
    const downloaded = await window.webContents.executeJavaScript(
      `window.synergyDesktop.organization.download(${JSON.stringify({ requestID: "native-download", connectionID: connection.id, path: binaryPath + "/content", fileName: "native-download.bin", bytes: 4, sha256: createHash("sha256").update(binaryBytes).digest("hex") })})`,
    )
    assert.deepEqual(downloaded, { ok: true, value: { saved: true, bytes: 4 } })
    assert.deepEqual(new Uint8Array(await fs.readFile(path.join(root, "native-download.bin"))), binaryBytes)
    const fieldRequest={requestID:"native-field",connectionID:connection.id,fileName:"native-field.txt",binding:nativeBinding,reference:fieldReference,query:{operation:"partContent",rootSessionID:"native-session",messageID:"native-message",partID:"native-part",version:"native-v1",field:"text",offset:0,length:131072}}
    const field = await window.webContents.executeJavaScript(`window.synergyDesktop.organization.downloadContent(${JSON.stringify(fieldRequest)})`)
    assert.deepEqual(field,{ok:true,value:{kind:"result",result:{saved:true,bytes:fieldBytes.length},original:"partial"}})
    assert.deepEqual(await fs.readFile(path.join(root,"native-field.txt")),fieldBytes)
    const heldField=window.webContents.executeJavaScript(`window.synergyDesktop.organization.downloadContent(${JSON.stringify({...fieldRequest,requestID:"native-field-held",fileName:"cancelled-field.txt",query:{...fieldRequest.query,partID:"held-native-part"}})})`)
    await nativeEntered.promise
    await window.webContents.executeJavaScript('window.synergyDesktop.organization.cancel({requestID:"native-field-held"})')
    assert.deepEqual(await heldField,{ok:false,error:{code:"cancelled"}})
    nativeReleased.resolve()
    assert.equal(await fs.stat(path.join(root,"cancelled-field.txt")).then(() => true,() => false),false)
    const heldBinary = window.webContents.executeJavaScript(
      `window.synergyDesktop.organization.request(${JSON.stringify({ requestID: "binary-held", connectionID: connection.id, method: "GET", path: binaryPath + "/content?hold=1", range: "bytes=0-3" })})`,
    )
    await binaryEntered.promise
    await window.webContents.executeJavaScript('window.synergyDesktop.organization.cancel({requestID:"binary-held"})')
    assert.deepEqual(await heldBinary, { ok: false, error: { code: "cancelled" } })
    await binaryClosed.promise
    const memberStatus = await window.webContents.executeJavaScript(
      `window.synergyDesktop.organization.memberStatus(${JSON.stringify({ connectionID: connection.id })})`,
    )
    assert.deepEqual(memberStatus, { ok: false, error: { code: "unavailable" } })
    child = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await child.loadURL(appURL)
    const denied = await child.webContents.executeJavaScript("window.synergyDesktop.organization.list()")
    console.error("organization-native: cancelling navigation")
    assert.deepEqual(denied, { ok: false, error: { code: "untrusted_sender" } })
    const memberDenied = await child.webContents.executeJavaScript(
      `window.synergyDesktop.organization.startMember(${JSON.stringify({ requestID: "foreign-member", connectionID: connection.id })})`,
    )
    assert.deepEqual(memberDenied, { ok: false, error: { code: "untrusted_sender" } })
    hold = true
    const pending = window.webContents
      .executeJavaScript(
        `window.synergyDesktop.organization.request(${JSON.stringify({ requestID: "navigation", connectionID: connection.id, method: "GET", path: "/org/v1/projects" })})`,
      )
      .catch(() => undefined)
    await entered.promise
    await window.loadURL(`${appURL}next`)
    assert.equal(heldSignal?.aborted, true)
    resume.resolve()
    await pending
    hold = false
    const signedOut = await window.webContents.executeJavaScript(
      `window.synergyDesktop.organization.signOut(${JSON.stringify({ connectionID: connection.id })})`,
    )
    assert.equal(signedOut.ok, true)
    assert.equal(signedOut.value.state, "signed_out")
    assert.equal(
      (await client.orgAuth.session({ headers: { authorization: `Bearer ${access.accessToken}` } })).response.status,
      401,
    )
    console.log(
      JSON.stringify({
        ok: true,
        osEncryption: true,
        nativePKCE: true,
        trustedFrame: true,
        navigationCancellation: true,
        logout: true,
        memberIPC: true,
        binaryIPC: true,
        nativeReadIPC: true,
      }),
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native organization acceptance failed")
    process.exitCode = 1
  } finally {
    ipc?.dispose()
    child?.destroy()
    window?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    app.exit(process.exitCode ?? 0)
  }
}
