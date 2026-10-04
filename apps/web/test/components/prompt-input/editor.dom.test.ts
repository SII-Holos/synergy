import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer

beforeAll(async () => {
  const root = path.resolve(import.meta.dir, "../../fixtures/plugin-ui5")
  server = await createServer({
    configFile: false,
    root,
    plugins: [
      solidPlugin(),
      {
        name: "prompt-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.includes("/session/")) return next()
            res.setHeader("Content-Type", "text/html")
            res.end('<div id="root"></div><script type="module" src="/prompt.tsx"></script>')
          })
        },
      },
    ],
    resolve: { alias: { "@": path.resolve(import.meta.dir, "../../../src") } },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.goto(`${server.resolvedUrls!.local[0]}c2NvcGU/session/a`)
  await page.waitForSelector("#seed")
}, 30000)

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
})

test("late restoration writes the captured draft, never the newly navigated session", async () => {
  await page.click("#seed")
  await page.click("#capture")
  await page.click("#b")
  await page.click("#restore")
  expect(await page.locator("#session").textContent()).toBe("b")
  expect(await page.locator("#value").textContent()).toBe("")
  await page.click("#a")
  expect(await page.locator("#value").textContent()).toBe("restored A")
})

test("a draft capture remains current while typing but is invalidated by resetting the draft", async () => {
  await page.evaluate(() => {
    const fixture = (window as unknown as { projectDraftFixture: { prompt: { capture(): unknown } } })
      .projectDraftFixture
    ;(window as unknown as { draftCapture: unknown }).draftCapture = fixture.prompt.capture()
  })
  await page.click("#seed")
  expect(await page.evaluate<boolean>("window.draftCapture.isCurrent()")).toBe(true)
  await page.evaluate("window.projectDraftFixture.prompt.resetDraft()")
  expect(await page.evaluate<boolean>("window.draftCapture.isCurrent()")).toBe(false)
  await page.evaluate("window.draftCapture.release()")
})

test("late submit failure restores an untouched draft and preserves subsequent user edits", async () => {
  await page.click("#submit")
  await page.click("#fail-submit")
  expect(await page.locator("#value").textContent()).toBe("submitted")
  await page.click("#submit")
  await page.click("#b")
  await page.click("#seed")
  await page.click("#a")
  await page.click("#seed")
  await page.click("#fail-submit")
  expect(await page.locator("#value").textContent()).toBe("hello")
  await page.click("#b")
  expect(await page.locator("#value").textContent()).toBe("hello")
  await page.click("#a")
})

test("headless edits survive native editor replacement and native range selection uses the same document", async () => {
  await page.click("#seed")
  await page.click("#edit")
  expect(await page.locator("#value").textContent()).toBe("h你好o")
  await page.click("#mount")
  expect(await page.locator("#editor").textContent()).toBe("h你好o")
  await page.click("#seed")
  await page.click("#select")
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("ell")
  await page.click("#edit")
  expect(await page.locator("#editor").textContent()).toBe("h你好o")
  await page.click("#mount")
  await page.click("#seed")
  await page.click("#edit")
  expect(await page.locator("#value").textContent()).toBe("h你好o")
})

test("plain-text paste replaces the selection and participates in native undo and redo", async () => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  for (const text of [
    "第一行\nSecond line",
    '<img src="missing" onerror="alert(1)"> & <script>throw 1</script>',
    "第一行\r\n\r\nLast line\n",
    "  if (ready) {\n    work()  \n  }\n",
    "中文 English 123，长文本粘贴验收。".repeat(500),
  ]) {
    await page.reload()
    await page.click("#seed")
    await page.click("#mount")
    await page.click("#select")
    await page.evaluate((text) => navigator.clipboard.writeText(text), text)
    await page.locator("#editor").press("ControlOrMeta+v")
    const expected = `h${text.replace(/\r\n?/g, "\n")}o`
    expect(await page.locator("#value").textContent()).toBe(expected)
    expect(await page.locator("#editor img, #editor script").count()).toBe(0)
    await page.locator("#editor").press("ControlOrMeta+z")
    expect(await page.locator("#value").textContent()).toBe("hello")
    await page.locator("#editor").press("ControlOrMeta+Shift+z")
    expect(await page.locator("#value").textContent()).toBe(expected)
    await page.locator("#editor").press("ControlOrMeta+a")
    await page.locator("#editor").press("Backspace")
    expect(await page.locator("#value").textContent()).toBe("")
    await page.locator("#editor").press("ControlOrMeta+z")
    expect(await page.locator("#value").textContent()).toBe(expected)
  }
}, 20_000)

test("project transfer checks both draft revisions and cancellation leaves both drafts intact", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}c2NvcGU/session/a`)
  await page.waitForSelector("#seed")
  await page.evaluate(`window.projectDraftFixture.navigate('/c2NvcGU/session')`)
  await page.click("#seed")
  await page.evaluate(
    `window.sourceCapture = window.projectDraftFixture.prompt.capture(); window.transfer = window.projectDraftFixture.prompt.prepareProjectTransfer('dGFyZ2V0', 'scope', '/source')`,
  )
  await page.evaluate(`window.transfer.release()`)
  expect(await page.locator("#value").textContent()).toBe("hello")
  await page.evaluate(
    `window.transfer = window.projectDraftFixture.prompt.prepareProjectTransfer('dGFyZ2V0', 'scope', '/source'); window.projectDraftFixture.prompt.set([{type:'text',content:'later source',start:0,end:12}],3)`,
  )
  expect(await page.evaluate<boolean>(`window.transfer.commit()`)).toBe(false)
  await page.evaluate(`window.transfer.release(); window.projectDraftFixture.navigate('/dGFyZ2V0/session')`)
  await page.click("#seed")
  await page.evaluate(
    `window.targetCapture = window.projectDraftFixture.prompt.capture(); window.projectDraftFixture.navigate('/c2NvcGU/session')`,
  )
  await page.evaluate(
    `window.transfer = window.projectDraftFixture.prompt.prepareProjectTransfer('dGFyZ2V0', 'scope', '/source')`,
  )
  expect(await page.evaluate<boolean>(`window.transfer.conflict`)).toBe(true)
  await page.evaluate(`window.targetCapture.draft.set([{type:'text',content:'later target',start:0,end:12}])`)
  expect(await page.evaluate<boolean>(`window.transfer.commit()`)).toBe(false)
  expect(await page.locator("#value").textContent()).toBe("later source")
  await page.evaluate(
    `window.transfer.release(); window.transfer = window.projectDraftFixture.prompt.prepareProjectTransfer('dGFyZ2V0', 'scope', '/source')`,
  )
  expect(await page.evaluate<boolean>(`window.transfer.commit()`)).toBe(true)
  await page.evaluate(`window.transfer.release(); window.projectDraftFixture.navigate('/dGFyZ2V0/session')`)
  expect(await page.locator("#value").textContent()).toBe("later target\nlater source".replace("\n", "\n\n"))
  await page.evaluate(
    `window.projectDraftFixture.navigate('/c2NvcGU/session'); window.sourceCapture.release(); window.targetCapture.release()`,
  )
  expect(await page.locator("#value").textContent()).toBe("")
}, 20_000)

test("project transfer preserves the editing cursor when the destination draft is empty", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}c2NvcGU/session/a`)
  await page.waitForSelector("#seed")
  await page.evaluate(`window.projectDraftFixture.navigate('/Y3Vyc29y/session')`)
  await page.evaluate(
    `window.projectDraftFixture.prompt.set([{type:'text',content:'keep typing here',start:0,end:16}],5)`,
  )
  await page.evaluate(
    `window.transfer=window.projectDraftFixture.prompt.prepareProjectTransfer('ZW1wdHk','cursor','/source');window.transfer.commit();window.transfer.release();window.projectDraftFixture.navigate('/ZW1wdHk/session')`,
  )
  expect(await page.evaluate<number>(`window.projectDraftFixture.prompt.cursor()`)).toBe(5)
}, 20_000)

test("optimistic submission clears the captured draft immediately and carries later typing into the new session", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}c2NvcGU/session/a`)
  await page.waitForSelector("#seed")
  await page.evaluate(`window.projectDraftFixture.navigate('/c2NvcGU/session')`)
  await page.click("#seed")
  expect(
    await page.evaluate<boolean>(
      `window.sent = window.projectDraftFixture.prompt.capture(); window.sent.clearIfUnchanged(window.sent.draft.revision()) !== undefined`,
    ),
  ).toBe(true)
  expect(await page.locator("#value").textContent()).toBe("")
  expect(await page.evaluate<boolean>(`window.sent.isCurrent()`)).toBe(true)
  await page.evaluate(`window.projectDraftFixture.prompt.set([{type:'text',content:'next message',start:0,end:12}],4)`)
  expect(await page.evaluate<boolean>(`window.sent.transferToSession('new-session')`)).toBe(true)
  await page.evaluate(`window.projectDraftFixture.navigate('/c2NvcGU/session/new-session')`)
  expect(await page.locator("#value").textContent()).toBe("next message")
  expect(await page.evaluate<number>(`window.projectDraftFixture.prompt.cursor()`)).toBe(4)
  await page.evaluate(`window.projectDraftFixture.navigate('/c2NvcGU/session'); window.sent.release()`)
  expect(await page.locator("#value").textContent()).toBe("")
})

test("retry sends the recovered draft while keeping the user's next draft and rejecting late restoration", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}c2NvcGU/session/a`)
  await page.waitForSelector("#seed")
  await page.evaluate(
    `window.projectDraftFixture.prompt.set([{type:'text',content:'keep my next draft',start:0,end:18}],5)`,
  )
  await page.evaluate(
    `window.projectDraftFixture.prompt.recoverDraft({prompt:[{type:'text',content:'failed message',start:0,end:14}],context:{items:[]}},true)`,
  )
  expect(await page.locator("#value").textContent()).toBe("failed message")
  expect(
    await page.evaluate<boolean>(
      `window.retry = window.projectDraftFixture.prompt.capture(); window.restoreRevision = window.retry.clearIfUnchanged(window.retry.draft.revision()); window.restoreRevision !== undefined`,
    ),
  ).toBe(true)
  expect(await page.locator("#value").textContent()).toBe("keep my next draft")
  expect(await page.evaluate<number>(`window.projectDraftFixture.prompt.cursor()`)).toBe(5)
  expect(
    await page.evaluate<boolean>(
      `window.retry.draft.restoreIfUnchanged(window.restoreRevision,{prompt:[{type:'text',content:'failed message',start:0,end:14}],context:{items:[]}})`,
    ),
  ).toBe(false)
  await page.evaluate(`window.retry.release()`)
})
