import { afterAll, beforeAll, expect, test } from "bun:test"
import { openUIFixture } from "../fixtures/plugin-ui5/browser"
let fixture: Awaited<ReturnType<typeof openUIFixture>>
beforeAll(async () => {
  fixture = await openUIFixture("skin.tsx")
  await fixture.page.waitForSelector("#surface")
}, 30000)
afterAll(async () => {
  await fixture?.close()
})

test("Skin changes modes and density without styling protected host surfaces or intercepting input", async () => {
  const { page } = fixture
  const radius = () => page.locator("#surface").evaluate((node) => getComputedStyle(node).borderRadius)
  expect(await radius()).toBe("24px")
  expect(await page.locator("#host").evaluate((node) => getComputedStyle(node).borderRadius)).toBe("0px")
  expect(await page.locator("#surface").evaluate((node) => getComputedStyle(node, "::after").pointerEvents)).toBe(
    "none",
  )
  await page.click("#interaction")
  await page.click("#motion")
  expect(await page.locator("#surface").evaluate((node) => getComputedStyle(node, "::after").content)).toBe("none")
  await page.click("#mode")
  expect(await radius()).toBe("8px")
  await page.click("#narrow")
  expect(await radius()).toBe("0px")
})

test("Skin fonts load through declared assets and yield to explicit user fonts", async () => {
  const { page } = fixture
  const family = await page.locator("#surface").evaluate(async (node) => {
    const value = getComputedStyle(node).fontFamily
    await document.fonts.load(`16px ${value}`)
    return value
  })
  expect(family).toContain("synergy-skin-")
  await page.click("#custom")
  expect(await page.locator("#surface").evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Courier New")
  await page.click("#disable")
  expect(await page.locator("#surface").evaluate((node) => getComputedStyle(node, "::before").backgroundImage)).toBe(
    "none",
  )
  expect(fixture.errors).toEqual([])
})
