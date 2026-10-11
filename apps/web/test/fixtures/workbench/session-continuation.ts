import assert from "node:assert/strict"
import type { Page } from "playwright"

export async function verifySessionContinuation(page: Page, origin: string, scopeID = "home") {
  let releaseCreation!: () => void
  const creation = new Promise<void>((resolve) => (releaseCreation = resolve))
  const sessionRoute = /\/session(?:\?|$)/
  await page.route(sessionRoute, async (route) => {
    if (route.request().method() === "POST") await creation
    await route.continue()
  })
  const editor = page.getByRole("textbox", { name: /^(发送消息|Send message)$/ })
  const first = "界面连续发送测试：这是第一条。请简短回复，不要调用工具。"
  const second = "界面连续发送测试：这是第二条。请简短回复，不要调用工具。"
  try {
    await page.goto(`${origin}/${Buffer.from(scopeID).toString("base64url")}/session`)
    await editor.fill(first)
    await editor.press("Enter")
    const viewport = page.locator("[data-conversation-current] [data-conversation-viewport]")
    await viewport.waitFor()
    const node = await viewport.elementHandle()
    const composer = await editor.elementHandle()
    await editor.fill(second)
    releaseCreation()
    await page.waitForURL(/\/session\/ses_[^/?#]+$/, { timeout: 60_000 })
    await page
      .getByText(/^(已完成|Completed)$/)
      .first()
      .waitFor({ timeout: 90_000 })
    assert.equal(await node!.evaluate((element) => element.isConnected), true, "first-send viewport remains mounted")
    assert.equal(await composer!.evaluate((element) => element.isConnected), true, "first-send editor remains mounted")
    assert.equal(await editor.innerText(), second, "creation and first reply retain the next draft")
    const sessionURL = page.url()
    const sessionID = new URL(sessionURL).pathname.split("/").at(-1)!
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === `/session/${sessionID}/input`,
      { timeout: 15_000 },
    )
    await editor.press("Enter")
    assert.equal((await accepted).ok(), true, "the second request reaches the same session")
    await page
      .getByText(/^(已完成|Completed)$/)
      .nth(1)
      .waitFor({ timeout: 90_000 })
    assert.equal(await editor.innerText(), "", "accepted follow-up clears only its own draft")
    assert.equal(page.url(), sessionURL, "the follow-up stays in its captured session")
    assert.equal(await node!.evaluate((element) => element.isConnected), true, "follow-up retains the viewport")
    assert.equal(await page.getByText(/^(会话正在转换|Session transition in progress)$/).count(), 0)
    return { sessionURL: page.url(), retainedViewport: true, retainedDraft: true, completedTurns: 2 }
  } finally {
    releaseCreation()
    await page.unroute(sessionRoute)
  }
}
