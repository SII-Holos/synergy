import assert from "node:assert/strict"
import { createServer } from "node:http"
import { app, BrowserWindow, session } from "electron"
import { BrowserNativePagePool } from "../../src/browser-native-page-pool"
import { browserRuntimeOwnerKey, browserRuntimePartition } from "../../src/browser-profile"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})

async function run() {
  await app.whenReady()
  const website = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html")
    response.end("<!doctype html><title>Member isolation</title><textarea id=draft></textarea>")
  })
  await new Promise<void>((resolve) => website.listen(0, "127.0.0.1", resolve))
  const address = website.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  const window = new BrowserWindow({ show: false })
  const pool = new BrowserNativePagePool({ captureWindow: () => window })
  const partitions = new Set<string>()
  const create = async (runtimeKey: string | undefined, owner = "scope:shared", temporary = false) => {
    const ownerKey = browserRuntimeOwnerKey(runtimeKey, owner)
    const partition = browserRuntimePartition(
      runtimeKey,
      `${temporary ? "" : "persist:"}synergy-browser-shared-${temporary ? "temporary" : "personal"}`,
    )
    partitions.add(partition)
    const page = await pool.create({
      ownerKey,
      profile: { id: temporary ? "temporary" : "personal", partition, revision: 1 },
      page: { id: "same-page", url, title: "", isLoading: false, lastActiveAt: null },
      networkProxy: { server: "direct://", username: "unused", password: "unused" },
      downloadDir: app.getPath("temp"),
      emit: () => {},
    })
    const entry = pool.find(ownerKey, page.state().id)!
    await page.execute({ type: "navigate", url })
    return { page, ownerKey, partition, contents: entry.generation.contents, view: entry.generation.view }
  }
  try {
    const personal = await create(undefined)
    const memberA = await create("member-a")
    const memberB = await create("member-b")
    const primary = [personal, memberA, memberB]
    assert.equal(new Set(primary.map((entry) => entry.contents.id)).size, 3)
    assert.equal(new Set(primary.map((entry) => entry.contents.session)).size, 3)
    assert.equal(personal.partition, "persist:synergy-browser-shared-personal")
    for (const [index, entry] of primary.entries()) {
      await entry.contents.executeJavaScript(
        `document.cookie='member=${index}; path=/'; localStorage.setItem('member','${index}')`,
      )
    }
    const peers = await Promise.all([
      create(undefined, "scope:peer"),
      create("member-a", "scope:peer"),
      create("member-b", "scope:peer"),
    ])
    for (const [index, entry] of peers.entries()) {
      assert.equal(entry.contents.session, primary[index]!.contents.session)
      assert.deepEqual(await entry.contents.executeJavaScript("[document.cookie, localStorage.getItem('member')]"), [
        `member=${index}`,
        String(index),
      ])
    }
    pool.attach(window, memberB.ownerKey, memberB.page.state().id)
    await memberB.contents.executeJavaScript("document.getElementById('draft').value='unsaved member draft'")
    const children = [...window.contentView.children]
    await Promise.all([memberA.page.destroy(), peers[1]!.page.destroy()])
    assert.deepEqual(window.contentView.children, children)
    assert.equal(
      await memberB.contents.executeJavaScript("document.getElementById('draft').value"),
      "unsaved member draft",
    )
    const restartedA = await create("member-a")
    assert.equal(restartedA.partition, memberA.partition)
    assert.equal(await restartedA.contents.executeJavaScript("document.cookie"), "member=1")
    const temporaryA = await create("member-a", "scope:temporary-one", true)
    const temporaryPeerA = await create("member-a", "scope:temporary-two", true)
    const temporaryB = await create("member-b", "scope:temporary-one", true)
    await temporaryA.contents.session.cookies.set({ url, name: "temporary", value: "a" })
    await temporaryB.contents.session.cookies.set({ url, name: "temporary", value: "b" })
    await temporaryA.page.destroy()
    assert.equal((await session.fromPartition(temporaryA.partition).cookies.get({ name: "temporary" }))[0]?.value, "a")
    await temporaryPeerA.page.destroy()
    assert.deepEqual(await session.fromPartition(temporaryA.partition).cookies.get({}), [])
    assert.equal((await temporaryB.contents.session.cookies.get({ name: "temporary" }))[0]?.value, "b")
    assert.equal(temporaryB.page.isAlive(), true)
    assert.equal(await memberB.contents.executeJavaScript("document.cookie"), "member=2")
    console.log(
      "Member native Browser isolation passed: colliding IDs; private cookies and localStorage; same-Runtime reuse; stable restart; independent close; last-use temporary cleanup.",
    )
  } finally {
    await pool.destroy()
    window.destroy()
    await Promise.all([...partitions].map((partition) => session.fromPartition(partition).clearStorageData()))
    await new Promise<void>((resolve, reject) => website.close((error) => (error ? reject(error) : resolve())))
  }
  app.exit(0)
}
