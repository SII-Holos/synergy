import { afterEach, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { get } from "node:http"
import os from "node:os"
import path from "node:path"
import { text } from "node:stream/consumers"
import { pathToFileURL } from "node:url"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

const roots: string[] = []
const servers: BrowserFixture[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  delete document.body.dataset.compiledFixture
})

test("compiled fixtures retain their aliases and stubs across cache reuse without changing the test environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-browser-fixture-"))
  roots.push(root)
  await Bun.write(path.join(root, "index.html"), '<script type="module" src="/main.js"></script>')
  await Bun.write(
    path.join(root, "main.js"),
    'import value from "fixture-value"; document.body.dataset.compiledFixture = value',
  )
  await Bun.write(path.join(root, "first.js"), 'export default "first fixture"')
  await Bun.write(path.join(root, "second.js"), 'export default "second fixture"')
  const environment = process.env.NODE_ENV
  async function prepare(stub: string, fixtureRoot = root) {
    const server = await createBrowserFixture({
      root: fixtureRoot,
      aliases: [{ find: /^fixture-value$/, replacement: path.join(fixtureRoot, stub) }],
    })
    servers.push(server)
    return server
  }
  async function evaluate(server: BrowserFixture) {
    const html = await new Promise<string>((resolve, reject) => {
      get(server.url, (response) => void text(response).then(resolve, reject)).once("error", reject)
    })
    const entry = /src="([^"]+\.js)"/.exec(html)?.[1]
    expect(entry).toBeDefined()
    await import(pathToFileURL(path.join(server.directory, entry!)).href)
    return document.body.dataset.compiledFixture
  }
  const first = await prepare("first.js")
  expect(await evaluate(first)).toBe("first fixture")
  expect((await prepare("first.js")).directory).toBe(first.directory)
  const relocated = await mkdtemp(path.join(os.tmpdir(), "web-browser-fixture-"))
  roots.push(relocated)
  await cp(root, relocated, { recursive: true })
  expect((await prepare("first.js", relocated)).directory).toBe(first.directory)
  const second = await prepare("second.js")
  expect(second.directory).not.toBe(first.directory)
  expect(await evaluate(second)).toBe("second fixture")
  await Bun.write(path.join(root, "first.js"), 'export default "updated fixture"')
  const changed = await prepare("first.js")
  expect(changed.directory).not.toBe(first.directory)
  expect(await evaluate(changed)).toBe("updated fixture")
  expect(process.env.NODE_ENV).toBe(environment)
}, 30_000)
