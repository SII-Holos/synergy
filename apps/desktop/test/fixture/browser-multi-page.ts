import { app, BrowserWindow } from "electron"
import { createServer } from "node:http"
import assert from "node:assert/strict"
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
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    res.setHeader("Content-Type", "text/html")
    res.end(
      `<title>${req.url}</title><h1>${req.url}</h1><script>window.received=${JSON.stringify(body)}; window.messages=[]; onmessage=e=>messages.push(e.data)</script>`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  const pool = new BrowserNativePagePool()
  const window = new BrowserWindow({ width: 1000, height: 720, show: false })
  const popups: BrowserNativePageHandle[] = []
  const events: string[] = []
  const base: Omit<BrowserNativePageInput, "page"> = {
    ownerKey: "task-one",
    profile: { id: "personal", partition: "persist:synergy-browser-multi-personal", revision: 0 },
    networkProxy: { server: "direct://", username: "unused", password: "unused" },
    downloadDir: app.getPath("temp"),
    emit: (event) => {
      events.push(event.type)
      if (event.type === "page.error") console.log(event)
    },
    onPopup: (_input, page) => {
      console.log("popup adopted", page.state().id)
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
  console.log("const views =")
  const views = pages.map((page) => pool.attach(window, base.ownerKey, page.state().id))
  assert.equal(new Set(views.map((view) => view.webContents.id)).size, 8)
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
  console.log("await evaluate")
  await evaluate(pages[0]!, `window.popup=window.open('${url}/popup'); 'opened'`)
  console.log("window.open dispatched")
  await until(() => popups.length === 1)
  console.log("popup ready")
  await until(async () => (await evaluate(popups[0]!, "document.title")) === "/popup")
  assert.equal(await evaluate(popups[0]!, "!!window.opener"), true)
  await evaluate(popups[0]!, "window.opener.postMessage('login-complete','*'); true")
  await until(async () => (await evaluate(pages[0]!, "messages.includes('login-complete')")) === true)
  assert.match(String(await evaluate(popups[0]!, "document.cookie")), /identity=personal/)
  console.log("await evaluate")
  await evaluate(
    pages[1]!,
    `let form=document.createElement('form'); form.method='POST'; form.action='${url}/post'; form.target='_blank'; form.innerHTML='<input name="token" value="fixture-value">'; document.body.append(form); form.submit(); true`,
  )
  await until(() => popups.length === 2)
  await until(async () => (await evaluate(popups[1]!, "window.received")) === "token=fixture-value")
  console.log("await evaluate")
  await evaluate(popups[0]!, "setTimeout(()=>window.close(),0); true")
  await until(() => !pool.find(base.ownerKey, popups[0]!.state().id))
  await until(() => events.includes("page.closed"))
  assert.equal(await evaluate(pages[0]!, "window.marker"), 0)
  console.log("await pages[1]!.destroy")
  await pages[1]!.destroy()
  assert.equal(await evaluate(popups[1]!, "window.received"), "token=fixture-value")
  console.log("views[2]!.webContents.forcefullyCrashRenderer")
  views[2]!.webContents.forcefullyCrashRenderer()
  await until(async () => {
    try {
      return (await evaluate(pages[2]!, "document.title")) === "/2"
    } catch {
      return false
    }
  })
  assert.equal(await evaluate(pages[3]!, "window.marker"), 3)
  console.log("await pool.destroy")
  await pool.destroy()
  window.destroy()
  server.close()
  console.log("ACCEPTED: 8 real pages, identity sharing/isolation, popup opener/POST/close, independent recovery")
  app.exit(0)
}
async function evaluate(page: BrowserNativePageHandle, expression: string) {
  const result = await page.execute({ type: "evaluate", mode: "trusted", expression })
  assert.equal(result.type, "evaluation")
  return result.type === "evaluation" ? result.value : undefined
}
async function until(read: () => boolean | Promise<boolean>) {
  const end = Date.now() + 12000
  while (Date.now() < end) {
    if (await read()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("Condition did not converge")
}
