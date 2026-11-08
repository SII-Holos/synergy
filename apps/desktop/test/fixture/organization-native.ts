import { app, BrowserWindow, ipcMain, safeStorage } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationClientAuth as Auth } from "@ericsanchezok/synergy-organization-protocol"
import { DesktopOrganizationAccounts } from "../../src/organization/accounts"
import { DesktopOrganizationAuthorization } from "../../src/organization/authorization"
import { DesktopOrganizationIPC, registerOrganizationIPC } from "../../src/organization/ipc"
import { organizationEncryption } from "../../src/organization/encryption"
import { trustedServerFrame } from "../../src/server-ipc"

const root = path.dirname(fileURLToPath(import.meta.url))
app.setName(path.basename(path.dirname(root)))
const info = JSON.parse(await fs.readFile(path.join(root, "service.json"), "utf8")) as { url: string; issuer: string }
app.setPath("userData", path.join(root, "user-data"))
app.once("ready", () => app.setActivationPolicy?.("accessory"))
let window: BrowserWindow | undefined
let child: BrowserWindow | undefined
let ipc: DesktopOrganizationIPC<Parameters<typeof trustedServerFrame>[0]> | undefined
const server = createServer((_request, response) => {
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
      const response = await fetch(new URL(target.pathname + target.search, info.url), {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        redirect: "error",
        credentials: "omit",
        body: request.body ? await request.arrayBuffer() : undefined,
      })
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
