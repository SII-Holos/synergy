import { afterAll, beforeAll, expect, test } from "bun:test"
import { openUIFixture } from "../fixtures/plugin-ui5/browser"

let fixture: Awaited<ReturnType<typeof openUIFixture>>
beforeAll(async () => {
  fixture = await openUIFixture("overlays.tsx")
  await fixture.page.waitForSelector("#confirm")
}, 30000)
afterAll(async () => {
  await fixture?.close()
})

test("Escape settles host confirmation and returns focus to its trigger", async () => {
  const { page } = fixture
  await page.click("#confirm")
  await page.getByRole("dialog").waitFor()
  expect(
    await page.getByRole("dialog").evaluate((node) => node.closest("[data-plugin-ui]")?.getAttribute("data-plugin-ui")),
  ).toBe("synergy")
  expect(await page.getByRole("dialog").evaluate((node) => node.closest("[data-skin-root]"))).toBe(null)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.locator("#result").textContent()).toBe("dismissed")
  await page.waitForFunction(() => document.activeElement?.id === "confirm")
  expect(await page.locator("#confirm").evaluate((node) => document.activeElement === node)).toBe(true)
})

test("targeted owner cleanup leaves a nested dialog alive", async () => {
  const { page } = fixture
  await page.click("#outer")
  await page.click("#inner")
  await page.click("#close-outer")
  expect(await page.getByRole("dialog").count()).toBe(1)
  expect(await page.getByRole("dialog").textContent()).toContain("Inner")
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(fixture.errors).toEqual([])
})
