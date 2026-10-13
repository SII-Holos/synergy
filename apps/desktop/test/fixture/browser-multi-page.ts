import { app, BrowserWindow, safeStorage, type WebContents } from "electron"
import { createServer } from "node:http"
import assert from "node:assert/strict"
import { BrowserDataStore } from "../../src/browser-data-store"
import { BrowserDataActions } from "../../src/browser-data-actions"
import { runBrowserPageAction } from "../../src/browser-page-actions"
import path from "node:path"
import { rm } from "node:fs/promises"
import {
  BrowserNativePagePool,
  type BrowserNativePageHandle,
  type BrowserNativePageInput,
} from "../../src/browser-native-page-pool"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
async function run() {
  await app.whenReady()
  console.log("Native Browser smoke: ready")
  let releaseRedirect!: () => void
  const adoptionStarted = new Promise<void>((resolve) => (releaseRedirect = resolve))
  let redirectOrigin = ""
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    if (req.url === "/post-redirect") {
      await adoptionStarted
      res.writeHead(307, { Location: `${redirectOrigin}/post` })
      res.end()
      return
    }
    if (req.url === "/download") {
      res.setHeader("Content-Disposition", "attachment; filename=fixture.csv")
      res.setHeader("Content-Type", "text/csv")
      res.end("value\nfixture\n")
      return
    }
    res.setHeader("Content-Type", "text/html")
    res.end(
      `<title>${req.url}</title><h1>${req.url}</h1><script>window.received=${JSON.stringify(body)}; window.messages=[]; onmessage=e=>messages.push(e.data)</script>`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  const redirectServer = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    res.setHeader("Content-Type", "text/html")
    res.end(
      `<title>Redirected POST</title><script>window.received=${JSON.stringify(body)}; window.method=${JSON.stringify(req.method)}</script>`,
    )
  })
  await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", resolve))
  const redirectAddress = redirectServer.address()
  assert(redirectAddress && typeof redirectAddress !== "string")
  redirectOrigin = `http://127.0.0.1:${redirectAddress.port}`
  const pool = new BrowserNativePagePool()
  const window = new BrowserWindow({ width: 1000, height: 720, show: false })
  const popups: BrowserNativePageHandle[] = []
  const events: string[] = []
  const recovery: string[] = []
  const popupFailures: string[] = []
  const deniedNavigations: Array<{ pageId: string; url?: string }> = []
  let download: import("@ericsanchezok/synergy-browser-core").BrowserHostDownloadEntry | undefined
  const base: Omit<BrowserNativePageInput, "page"> = {
    ownerKey: "task-one",
    profile: { id: "personal", partition: "persist:synergy-browser-multi-personal", revision: 0 },
    networkProxy: { server: "direct://", username: "unused", password: "unused" },
    downloadDir: app.getPath("temp"),
    emit: (event) => {
      events.push(event.type)
      if (event.type === "download.updated") {
        download = { ...event.entry }
      }
      if (event.type === "page.error") {
        console.log(event)
        if (event.message.startsWith("Popup could not open:")) popupFailures.push(event.message)
        else deniedNavigations.push(event)
      }
      if (event.type === "host.status" && event.pageId === "page-2") {
        recovery.push(event.status)
        console.log(`Recovery: ${event.status}`)
      }
    },
    onPopup: (_input, page) => {
      popups.push(page)
    },
  }
  const pages = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      pool.create({
        ...base,
        page: { id: `page-${i}`, url: `${url}/${i}`, title: "", isLoading: false, lastActiveAt: null },
      }),
    ),
  )
  console.log("Native Browser smoke: eight pages created")
  const views = pages.map((page) => pool.attach(window, base.ownerKey, page.state().id))
  assert.equal(new Set(views.map((view) => view.webContents.id)).size, 8)
  pool.attach(window, base.ownerKey, "page-0")
  window.show()
  const first = views[0]!.webContents
  assert.equal(
    (await runBrowserPageAction(first, { type: "find", text: "/0", forward: true, next: false })).type,
    "find",
  )
  await runBrowserPageAction(first, { type: "stopFind" })
  assert.deepEqual(await runBrowserPageAction(first, { type: "zoom", factor: 2 }), { type: "zoom", factor: 2 })
  await runBrowserPageAction(first, { type: "zoom", factor: 1 })
  assert.equal((await pages[0]!.execute({ type: "screenshot", fullPage: true })).type, "screenshot")
  await first.executeJavaScript(`
    document.body.insertAdjacentHTML("beforeend", '<textarea id="composition-input"></textarea>');
    window.compositionEvents = [];
    const input = document.getElementById("composition-input");
    for (const type of ["compositionstart", "compositionupdate", "compositionend"])
      input.addEventListener(type, event => window.compositionEvents.push(event.type));
    input.focus();
  `)
  await first.debugger.sendCommand("Input.imeSetComposition", {
    text: "中文输入验收",
    selectionStart: 6,
    selectionEnd: 6,
  })
  await first.debugger.sendCommand("Input.insertText", { text: "中文输入验收" })
  const composition = (await first.executeJavaScript(`({
    value: document.getElementById("composition-input").value,
    events: window.compositionEvents
  })`)) as { value: string; events: string[] }
  assert.equal(composition.value, "中文输入验收")
  assert.deepEqual(
    composition.events.filter((event) => event !== "compositionupdate"),
    ["compositionstart", "compositionend"],
  )
  assert.ok(composition.events.includes("compositionupdate"))
  await first.executeJavaScript('document.getElementById("composition-input").remove()')
  let syntheticGestures = 0
  const key = () => {
    syntheticGestures++
  }
  first.on("before-input-event", key)
  await first.debugger.sendCommand("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  })
  await first.debugger.sendCommand("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  })
  first.off("before-input-event", key)
  assert.equal(syntheticGestures, 0, "Agent CDP input must not become a human navigation grant")
  const store = new BrowserDataStore(path.join(app.getPath("userData"), "browser-data"), {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result,
  })
  const data = new BrowserDataActions({
    store,
    target: () => ({ partition: base.profile.partition, contents: first }),
    chooseFile: async () => undefined,
  })
  await first.executeJavaScript(
    'document.body.insertAdjacentHTML("beforeend",`<form><input autocomplete="username" value="fixture"><input type="password" value="fixture-pass"></form>`)',
  )
  await data.execute({ protocolVersion: 5, ownerKey: base.ownerKey, pageId: "page-0", action: { type: "saveLogin" } })
  const state = await store.list(base.profile.partition)
  assert.equal(state.passwords.length, 1)
  await first.executeJavaScript('document.querySelector("input[type=password]").value=""')
  await data.execute({
    protocolVersion: 5,
    ownerKey: base.ownerKey,
    pageId: "page-0",
    action: { type: "fillLogin", id: state.passwords[0]!.id },
  })
  assert.equal(await first.executeJavaScript('document.querySelector("input[type=password]").value'), "fixture-pass")

  for (let i = 0; i < pages.length; i++) await evaluate(pages[i]!, `window.marker=${i}`)
  for (let i = 0; i < pages.length; i++) assert.equal(await evaluate(pages[i]!, "window.marker"), i)
  await evaluate(pages[0]!, 'document.cookie="identity=personal; path=/"')
  const other = await pool.create({
    ...base,
    ownerKey: "task-two",
    page: { ...pages[0]!.state(), id: "other-task", url: `${url}/other` },
  })
  assert.match(String(await evaluate(other, "document.cookie")), /identity=personal/)
  const isolated = await pool.create({
    ...base,
    profile: { id: "work", partition: "persist:synergy-browser-multi-work", revision: 0 },
    page: { ...pages[0]!.state(), id: "work", url: `${url}/work` },
  })
  assert.equal(await evaluate(isolated, "document.cookie"), "")
  await evaluate(pages[0]!, `window.popup=window.open('${url}/popup'); 'opened'`)
  await until(() => popups.length === 1)
  await until(async () => (await evaluate(popups[0]!, "document.title")) === "/popup")
  assert.equal(await evaluate(popups[0]!, "!!window.opener"), true)
  await evaluate(popups[0]!, "window.opener.postMessage('login-complete','*'); true")
  await until(async () => (await evaluate(pages[0]!, "messages.includes('login-complete')")) === true)
  assert.match(String(await evaluate(popups[0]!, "document.cookie")), /identity=personal/)
  let postChild!: WebContents
  const popupFocusEvents: number[] = []
  app.once("web-contents-created", (_event, contents) => {
    postChild = contents
    contents.on("focus", () => popupFocusEvents.push(contents.id))
    const sendCommand = contents.debugger.sendCommand.bind(contents.debugger)
    contents.debugger.sendCommand = async (method, ...args) => {
      if (method === "Page.enable") {
        contents.debugger.sendCommand = sendCommand
        const redirected = new Promise<void>((resolve) => {
          contents.once("will-redirect", () => setImmediate(resolve))
        })
        releaseRedirect()
        await redirected
      }
      return sendCommand(method, ...args)
    }
  })
  first.focus()
  console.log("Native popup regression: redirect during adoption")
  const attachedBeforePopup = window.contentView.children
  await evaluate(
    pages[1]!,
    `let form=document.createElement('form'); form.method='POST'; form.action='${url}/post-redirect'; form.target='_blank'; form.rel='opener'; form.innerHTML='<input name="token" value="fixture-value">'; document.body.append(form); form.submit(); true`,
  )
  await until(() => popups.length === 2 || popupFailures.length > 0, "redirected POST adoption")
  assert.equal(await evaluate(pages[1]!, "window.marker"), 1, "A popup failure must not destroy its opener")
  assert.deepEqual(popupFailures, [], "The authorized initial popup redirect must survive diagnostics adoption")
  await until(
    async () => (await evaluate(popups[1]!, "window.received")) === "token=fixture-value",
    "redirected POST body",
  )
  assert.equal(await evaluate(popups[1]!, "window.method"), "POST")
  assert.equal(await evaluate(popups[1]!, "!!window.opener"), true)
  assert.equal(popups[1]!.state().url, `${redirectOrigin}/post`)
  assert.equal(postChild.session, first.session)
  await evaluate(popups[1]!, "window.opener.postMessage('post-complete','*'); true")
  await until(async () => (await evaluate(pages[1]!, "messages.includes('post-complete')")) === true)
  assert.equal(popupFocusEvents.length, 0, "Adopted popup must not take native focus")
  assert.deepEqual(window.contentView.children, attachedBeforePopup)
  console.log("Native popup regression: commit before adoption")
  let earlyChild!: WebContents
  let resumeAdoption!: () => void
  const adoptionResumed = new Promise<void>((resolve) => (resumeAdoption = resolve))
  app.once("web-contents-created", (_event, contents) => {
    earlyChild = contents
    contents.on("focus", () => popupFocusEvents.push(contents.id))
    const sendCommand = contents.debugger.sendCommand.bind(contents.debugger)
    contents.debugger.sendCommand = async (method, ...args) => {
      if (method === "Page.enable") {
        contents.debugger.sendCommand = sendCommand
        await adoptionResumed
      }
      return sendCommand(method, ...args)
    }
  })
  await evaluate(pages[0]!, `window.open('${url}/early'); true`)
  await until(
    () => earlyChild?.getURL() === `${url}/early` && !earlyChild.isLoading(),
    "initial commit before adoption",
  )
  assert.equal(popups.length, 2, "Initial commit must be observable while diagnostics adoption is held")
  await earlyChild.executeJavaScript(`location.assign('${url}/early-next'); true`)
  await until(
    () => earlyChild.getURL() === `${url}/early-next` && !earlyChild.isLoading(),
    "same-origin commit before adoption",
  )
  const unsolicitedURL = `${redirectOrigin}/unsolicited`
  const rejected = new Promise<void>((resolve) => {
    earlyChild.once("will-navigate", (event) => {
      assert.equal(event.defaultPrevented, true, "A committed child cannot reuse its initial navigation grant")
      resolve()
    })
  })
  await earlyChild.executeJavaScript(`location.assign('${unsolicitedURL}'); true`)
  await rejected
  resumeAdoption()
  await until(() => popups.length === 3)
  assert.equal(popups[2]!.state().url, `${url}/early-next`)
  assert.ok(deniedNavigations.some((event) => event.pageId === popups[2]!.state().id && event.url === unsolicitedURL))
  assert.equal(popupFocusEvents.length, 0, "Adopted popup must not take native focus")
  assert.deepEqual(window.contentView.children, attachedBeforePopup)
  await popups[2]!.destroy()
  await evaluate(popups[0]!, "setTimeout(()=>window.close(),0); true")
  await until(() => !pool.find(base.ownerKey, popups[0]!.state().id))
  await until(() => events.includes("page.closed"))
  assert.equal(await evaluate(pages[0]!, "window.marker"), 0)
  await pages[1]!.destroy()
  assert.equal(await evaluate(popups[1]!, "window.received"), "token=fixture-value")
  const crashed = views[2]!.webContents
  const crashedId = crashed.id
  let replacementId: number | undefined
  const stopObserving = pool.onGeneration(base.ownerKey, "page-2", (view) => {
    replacementId = view.webContents.id
  })
  const rendererPid = crashed.getOSProcessId()
  assert(rendererPid > 0 && rendererPid !== process.pid)
  process.kill(rendererPid, "SIGKILL")
  await until(() => recovery.includes("ready"))
  stopObserving()
  assert.deepEqual(recovery, ["restarting", "ready"])
  assert.notEqual(replacementId, undefined)
  assert.notEqual(replacementId, crashedId)
  assert.equal(crashed.isDestroyed(), true)
  assert.equal(await evaluate(pages[2]!, "document.title"), "/2")
  assert.equal(await evaluate(pages[2]!, "typeof window.marker"), "undefined")
  assert.equal(await evaluate(pages[3]!, "window.marker"), 3)
  views[3]!.webContents.downloadURL(`${url}/download`)
  await until(() => download?.state === "awaiting_approval")
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(download?.state, "awaiting_approval")
  await pages[3]!.execute({ type: "download.accept", id: download!.id })
  await until(() => download?.state === "completed")
  if (download?.path) await rm(download.path, { force: true })
  const temporary = { id: "temporary", partition: "synergy-browser-temporary-fixture", revision: 0 }
  const tempA = await pool.create({
    ...base,
    profile: temporary,
    page: { ...pages[0]!.state(), id: "temp-a", url: `${url}/temp-a` },
  })
  const tempB = await pool.create({
    ...base,
    ownerKey: "task-two",
    profile: temporary,
    page: { ...pages[0]!.state(), id: "temp-b", url: `${url}/temp-b` },
  })
  await evaluate(tempA, 'document.cookie="temporary=fixture;path=/"')
  await tempA.destroy()
  assert.match(String(await evaluate(tempB, "document.cookie")), /temporary=fixture/)
  await tempB.destroy()
  const tempC = await pool.create({
    ...base,
    profile: temporary,
    page: { ...pages[0]!.state(), id: "temp-c", url: `${url}/temp-c` },
  })
  assert.equal(await evaluate(tempC, "document.cookie"), "")
  await pool.destroy()
  window.destroy()
  server.close()
  redirectServer.close()
  console.log(
    "ACCEPTED: 8 real pages, identity sharing/isolation, popup opener/cross-origin POST redirect/close without focus theft, independent recovery, download approval and temporary cleanup",
  )
  app.exit(0)
}
async function evaluate(page: BrowserNativePageHandle, expression: string) {
  const result = await page.execute({ type: "evaluate", mode: "trusted", expression })
  assert.equal(result.type, "evaluation")
  return result.type === "evaluation" ? result.value : undefined
}
async function until(read: () => boolean | Promise<boolean>, label = "Condition") {
  const end = Date.now() + 12000
  while (Date.now() < end) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${label} did not converge`)
}
