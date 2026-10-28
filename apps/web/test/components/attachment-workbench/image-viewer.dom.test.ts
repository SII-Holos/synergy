import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser, page: Page, server: BrowserFixture
beforeAll(async () => {
  server = await createBrowserFixture({
    root: path.resolve(import.meta.dir, "../../fixtures/image-viewer"),
    entries: ["viewer.html"],
    styled: true,
    localized: false,
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
}, 60000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
})

beforeEach(async () => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto(`${server.url}viewer.html`)
  await page.getByRole("button", { name: "Open images", exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement))
  await page.locator('[data-slot="image-viewer-image"]').evaluate((element: HTMLImageElement) => element.decode())
  await page.waitForFunction(
    () => document.querySelector('[data-slot="image-viewer-stage"]')?.getAttribute("aria-busy") === "false",
  )
})

test("fit and actual size use source pixels and rotation refits the stage", async () => {
  await page.getByRole("button", { name: "Fit image", exact: true }).waitFor({ timeout: 3000 })
  const image = page.locator('[data-slot="image-viewer-image"]')
  await image.evaluate((element: HTMLImageElement) => element.decode())
  await page.getByRole("button", { name: "Actual size (1:1)", exact: true }).click()
  expect((await image.boundingBox())!.width).toBeCloseTo(4000, 0)
  await page.getByRole("button", { name: "Fit image", exact: true }).click()
  await page.getByRole("button", { name: "Rotate image clockwise", exact: true }).click()
  const bounds = (await image.boundingBox())!
  const stage = (await page.locator('[data-slot="image-viewer-stage"]').boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(stage.x)
  expect(bounds.y).toBeGreaterThanOrEqual(stage.y)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(stage.x + stage.width)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(stage.y + stage.height)
})

test("same-source gallery entries load and restore their own transform", async () => {
  await page.getByRole("button", { name: "Actual size (1:1)", exact: true }).click()
  await page.getByRole("button", { name: "Next image", exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('[data-slot="image-viewer-stage"]')?.getAttribute("aria-busy") === "false",
  )
  expect(await page.getByRole("dialog").getAttribute("aria-labelledby")).toBeTruthy()
  expect(await page.getByRole("button", { name: "Fit image", exact: true }).getAttribute("aria-pressed")).toBe("true")
  await page.getByRole("button", { name: "Previous image", exact: true }).click()
  await page.locator('[data-slot="image-viewer-image"]').evaluate((element: HTMLImageElement) => element.decode())
  expect((await page.locator('[data-slot="image-viewer-image"]').boundingBox())!.width).toBeCloseTo(4000, 0)
})

test("a cached viewer opens fitted before its first resize notification", async () => {
  await page.getByRole("button", { name: "Close image preview", exact: true }).click()
  const opening = await page.evaluate(async () => {
    const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Open images",
    )!
    trigger.click()
    await Promise.resolve()
    const stage = document.querySelector<HTMLElement>('[data-slot="image-viewer-stage"]')!
    const image = document.querySelector<HTMLImageElement>('[data-slot="image-viewer-image"]')!
    return {
      busy: stage.getAttribute("aria-busy"),
      image: { width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height },
      stage: { width: stage.clientWidth, height: stage.clientHeight },
    }
  })
  expect(opening.busy).toBe("false")
  expect(opening.image.width).toBeGreaterThan(0)
  expect(opening.image.width).toBeLessThanOrEqual(opening.stage.width)
  expect(opening.image.height).toBeLessThanOrEqual(opening.stage.height)
})

test("cached gallery switches keep the toolbar ready before the next load event", async () => {
  const switches = await page.evaluate(async () => {
    await Promise.all(
      [...document.querySelectorAll<HTMLImageElement>('[data-slot="image-viewer-thumbnails"] img')].map((image) =>
        image.decode(),
      ),
    )
    const commands = [...document.querySelectorAll<HTMLButtonElement>("[data-viewer-command]")]
    const results = []
    for (const side of ["next", "next", "previous", "previous"]) {
      document.querySelector<HTMLButtonElement>(`[data-slot="image-viewer-nav"][data-side="${side}"]`)!.click()
      await Promise.resolve()
      const image = document.querySelector<HTMLImageElement>('[data-slot="image-viewer-image"]')!
      results.push({
        filename: image.alt,
        busy: document.querySelector('[data-slot="image-viewer-stage"]')!.getAttribute("aria-busy"),
        disabled: commands.filter((button) => button.disabled).map((button) => button.dataset.viewerCommand),
        sameControls: commands.every((button) => button.isConnected),
        visible: getComputedStyle(image).visibility,
        width: image.style.width,
        naturalWidth: image.naturalWidth,
      })
    }
    return results
  })
  expect(switches.map((state) => state.filename)).toEqual([
    "same-source.svg",
    "small.svg",
    "same-source.svg",
    "large.svg",
  ])
  for (const state of switches) {
    expect(state.busy).toBe("false")
    expect(state.disabled).toEqual(["zoomOut"])
    expect(state.sameControls).toBe(true)
    expect(state.visible).toBe("visible")
    expect(state.width).toBe(`${state.naturalWidth}px`)
  }
})

const navigationAppearance = (button: Locator) =>
  button.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return {
      background: style.backgroundColor,
      focus: style.backgroundImage,
      transform: style.transform,
      cursor: style.cursor,
      width: box.width,
      height: box.height,
      centerX: box.x + box.width / 2,
      centerY: box.y + box.height / 2,
    }
  })

async function previewChrome(close: Locator) {
  const dialog = page.getByRole("dialog")
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  const surface = await dialog.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      radius: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ],
      background: style.backgroundColor,
      border: [style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
      shadow: style.boxShadow,
    }
  })
  await close.evaluate((element: HTMLElement) => element.blur())
  await page.mouse.move(0, 0)
  const appearance = () =>
    close.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      const surface = element.closest('[role="dialog"]')!.getBoundingClientRect()
      return {
        width: box.width,
        height: box.height,
        top: box.top - surface.top,
        right: surface.right - box.right,
        radius: style.borderRadius,
        background: style.backgroundColor,
        border: style.borderWidth,
        shadow: style.boxShadow,
        icon: getComputedStyle(element.querySelector('[data-slot="icon-svg"]')!).color,
      }
    })
  const resting = await appearance()
  await close.hover()
  const hovered = await appearance()
  await page.mouse.down()
  const pressed = await appearance()
  await page.mouse.move(0, 0)
  await page.mouse.up()
  await close.focus()
  await close.press("Tab")
  await page.keyboard.press("Shift+Tab")
  expect(await close.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
  const focused = await appearance()
  return { surface, resting, hovered, pressed, focused }
}

for (const theme of ["light", "dark"] as const) {
  test(`preview shell and close control match Settings in ${theme} mode`, async () => {
    await page.evaluate((theme) => {
      const fixture = (window as unknown as { imageFixture: { theme: (theme: "light" | "dark") => void } }).imageFixture
      fixture.theme(theme)
    }, theme)
    await page.waitForFunction((theme) => document.documentElement.dataset.colorScheme === theme, theme)
    const close = page.getByRole("button", { name: "Close image preview", exact: true })
    const preview = await previewChrome(close)
    expect(await close.evaluate((element) => getComputedStyle(element).backgroundImage)).not.toBe("none")
    await close.click()
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.textContent === "Open images")
    await page.getByRole("button", { name: "Open reference settings", exact: true }).click()
    const reference = await previewChrome(page.getByRole("button", { name: "Close reference settings", exact: true }))
    expect(preview).toEqual(reference)
  })

  test(`gallery arrows distinguish hover and press without moving their center in ${theme} mode`, async () => {
    await page.evaluate((theme) => {
      const fixture = (window as unknown as { imageFixture: { theme: (theme: "light" | "dark") => void } }).imageFixture
      fixture.theme(theme)
    }, theme)
    await page.waitForFunction((theme) => document.documentElement.dataset.colorScheme === theme, theme)
    for (const [name, filename] of [
      ["Previous image", "large.svg"],
      ["Next image", "small.svg"],
    ] as const) {
      await page.getByRole("button", { name: "same-source.svg", exact: true }).click()
      await page.locator('[data-slot="image-viewer-stage"]').focus()
      await page.mouse.move(0, 0)
      const button = page.getByRole("button", { name, exact: true })
      const resting = await navigationAppearance(button)
      await button.hover()
      const hovering = await navigationAppearance(button)
      expect(hovering.background).not.toBe(resting.background)
      expect(hovering.cursor).toBe("pointer")
      expect(hovering.transform).toBe(resting.transform)
      await page.mouse.down()
      try {
        const pressed = await navigationAppearance(button)
        expect(pressed.background).not.toBe(hovering.background)
        expect(pressed.width).toBeLessThan(resting.width)
        expect(pressed.centerX).toBeCloseTo(resting.centerX, 1)
        expect(pressed.centerY).toBeCloseTo(resting.centerY, 1)
      } finally {
        await page.mouse.up()
      }
      expect(await page.locator('[data-slot="image-preview-title"]').innerText()).toBe(filename)

      await page.locator('[data-slot="image-viewer-stage"]').focus()
      await page.mouse.move(0, 0)
      expect(await button.isDisabled()).toBe(true)
      const disabled = await navigationAppearance(button)
      await button.hover()
      await page.mouse.down()
      try {
        expect(await navigationAppearance(button)).toEqual(disabled)
      } finally {
        await page.mouse.up()
      }
      expect(await page.locator('[data-slot="image-preview-title"]').innerText()).toBe(filename)
    }
  })
}

test("reduced-motion gallery arrows retain keyboard press feedback without scaling", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.mouse.move(0, 0)
  await page.locator('[data-slot="image-viewer-stage"]').focus()
  await page.keyboard.press("Tab")
  const next = page.getByRole("button", { name: "Next image", exact: true })
  expect(await next.evaluate((element) => element === document.activeElement)).toBe(true)
  const resting = await navigationAppearance(next)
  expect(resting.focus).not.toBe("none")
  await page.keyboard.down("Space")
  try {
    const pressed = await navigationAppearance(next)
    expect(pressed.background).not.toBe(resting.background)
    expect(pressed.transform).toBe(resting.transform)
    expect(await next.evaluate((element) => element.getAnimations().length)).toBe(0)
  } finally {
    await page.keyboard.up("Space")
  }
  expect(await page.locator('[data-slot="image-preview-title"]').innerText()).toBe("same-source.svg")
})

test("touch gallery arrows keep their hit area and do not retain hover after a tap", async () => {
  const touch = await browser.newPage({ viewport: { width: 375, height: 320 }, hasTouch: true })
  try {
    await touch.goto(`${server.url}viewer.html`)
    await touch.getByRole("button", { name: "Open images", exact: true }).tap()
    const next = touch.getByRole("button", { name: "Next image", exact: true })
    const resting = await navigationAppearance(next)
    expect(resting.width).toBeGreaterThanOrEqual(44)
    expect(resting.height).toBeGreaterThanOrEqual(44)
    await next.tap()
    expect(await touch.locator('[data-slot="image-preview-title"]').innerText()).toBe("same-source.svg")
    expect(await navigationAppearance(next)).toEqual(resting)
    const close = touch.getByRole("button", { name: "Close image preview", exact: true })
    const closeBounds = (await close.boundingBox())!
    expect(closeBounds.width).toBeGreaterThanOrEqual(44)
    expect(closeBounds.height).toBeGreaterThanOrEqual(44)
    await close.tap()
    await touch.getByRole("dialog").waitFor({ state: "hidden" })
  } finally {
    await touch.close()
  }
})

test("wheel anchors source pixels and captured dragging remains bounded", async () => {
  await page.getByRole("button", { name: "Actual size (1:1)", exact: true }).click()
  const image = page.locator('[data-slot="image-viewer-image"]')
  const stage = page.locator('[data-slot="image-viewer-stage"]')
  const box = (await stage.boundingBox())!
  const anchor = { x: box.x + box.width / 2 + 45, y: box.y + box.height / 2 + 35 }
  const before = (await image.boundingBox())!
  await page.mouse.move(anchor.x, anchor.y)
  await page.mouse.wheel(0, -100)
  await page.waitForFunction(
    (width) => document.querySelector('[data-slot="image-viewer-image"]')!.getBoundingClientRect().width > width,
    before.width,
  )
  const after = (await image.boundingBox())!
  expect((anchor.x - before.x) / before.width).toBeCloseTo((anchor.x - after.x) / after.width, 3)
  expect((anchor.y - before.y) / before.height).toBeCloseTo((anchor.y - after.y) / after.height, 3)
  await page.getByRole("button", { name: "Actual size (1:1)", exact: true }).click()
  await stage.click({ button: "right", position: { x: 20, y: 20 } })
  await page.getByRole("menu").waitFor()
  await page.waitForFunction(() => document.querySelector('[role="menu"]')?.contains(document.activeElement))
  const beforeDrag = (await image.boundingBox())!
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-slot"), {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    }),
  ).toBe("image-viewer-stage")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  try {
    await page.getByRole("menu").waitFor({ state: "detached", timeout: 2000 })
    await page.mouse.move(1198, 798, { steps: 3 })
  } finally {
    await page.mouse.up()
  }
  const dragged = (await image.boundingBox())!
  expect(dragged.x).toBeGreaterThan(beforeDrag.x)
  expect(dragged.x).toBeLessThanOrEqual(box.x)
  expect(dragged.y).toBeLessThanOrEqual(box.y)
  expect(await stage.getAttribute("data-dragging")).toBeNull()
  await page.getByRole("button", { name: "Fit image", exact: true }).click()
  const fit = (await image.boundingBox())!
  expect(fit.x + fit.width / 2).toBeCloseTo(box.x + box.width / 2, 1)
})

test("context and overflow menus share actions and Escape closes only the menu", async () => {
  await page.locator('[data-slot="image-viewer-stage"]').click({ button: "right" })
  const grid = page.getByRole("menuitemcheckbox", { name: "Transparency grid", exact: true })
  const fit = page.getByRole("menuitemcheckbox", { name: "Fit image", exact: true })
  const actual = page.getByRole("menuitemcheckbox", { name: "Actual size (1:1)", exact: true })
  await grid.waitFor({ timeout: 3000 })
  expect(await grid.getAttribute("aria-checked")).toBe("true")
  await grid.press("Space")
  await page.getByRole("menu").waitFor({ state: "detached" })
  expect(await page.locator('[data-slot="image-viewer-stage"]').getAttribute("data-grid")).toBeNull()
  await page.getByRole("button", { name: "Image actions", exact: true }).click()
  await actual.waitFor()
  expect(await grid.getAttribute("aria-checked")).toBe("false")
  expect(await fit.getAttribute("aria-checked")).toBe("true")
  expect(await actual.getAttribute("aria-checked")).toBe("false")
  await actual.press("Enter")
  await page.getByRole("menu").waitFor({ state: "detached" })
  expect((await page.locator('[data-slot="image-viewer-image"]').boundingBox())!.width).toBeCloseTo(4000, 0)
  await page.locator('[data-slot="image-viewer-stage"]').click({ button: "right" })
  await actual.waitFor()
  expect(await actual.getAttribute("aria-checked")).toBe("true")
  expect(await fit.getAttribute("aria-checked")).toBe("false")
  await page.keyboard.press("Escape")
  expect(await page.getByRole("menu").count()).toBe(0)
  expect(await page.getByRole("dialog").count()).toBe(1)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Open images")
  expect(
    await page
      .getByRole("button", { name: "Open images", exact: true })
      .evaluate((element) => element === document.activeElement),
  ).toBe(true)
})

test("keyboard context menus return focus to the image stage", async () => {
  const stage = page.locator('[data-slot="image-viewer-stage"]')
  for (const key of ["Shift+F10", "ContextMenu"]) {
    await stage.focus()
    await page.keyboard.press(key)
    await page.getByRole("menuitem", { name: "Save image", exact: true }).waitFor({ timeout: 3000 })
    await page.keyboard.press("Escape")
    await page.locator('[data-component="image-viewer-menu"]').waitFor({ state: "detached" })
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-slot") === "image-viewer-stage",
      undefined,
      { timeout: 3000 },
    )
    expect(await page.getByRole("dialog").count()).toBe(1)
  }
})

for (const mode of ["dialog", "inline", "fullscreen"] as const) {
  test(`context menu dismisses on canvas and image clicks without leaving ${mode}`, async () => {
    if (mode === "inline") await page.goto(`${server.url}viewer.html?inline`)
    if (mode === "fullscreen") {
      await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click()
      await page.waitForFunction(() => !!document.fullscreenElement)
    }
    await page.getByRole("button", { name: "small.svg", exact: true }).click()
    const stage = page.locator('[data-slot="image-viewer-stage"]')
    const image = page.locator('[data-slot="image-viewer-image"]')
    await image.evaluate((element: HTMLImageElement) => element.decode())
    const box = (await stage.boundingBox())!
    for (const target of ["canvas", "image"] as const) {
      await stage.click({ button: "right", position: { x: 20, y: 20 } })
      await page.getByRole("menu").waitFor()
      if (mode === "fullscreen") {
        expect(await page.getByRole("menu").evaluate((element) => document.fullscreenElement?.contains(element))).toBe(
          true,
        )
      }
      await stage.click({
        position:
          target === "canvas" ? { x: box.width - 20, y: box.height - 20 } : { x: box.width / 2, y: box.height / 2 },
      })
      await page.getByRole("menu").waitFor({ state: "detached", timeout: 2000 })
      expect(await page.getByRole("dialog").count()).toBe(mode === "inline" ? 0 : 1)
      expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(mode === "fullscreen")
      expect(await stage.evaluate((element) => element === document.activeElement)).toBe(true)
    }
    const width = (await image.boundingBox())!.width
    await page.keyboard.press("+")
    expect((await image.boundingBox())!.width).toBeGreaterThan(width)
    if (mode === "fullscreen") {
      await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click()
      await page.waitForFunction(() => !document.fullscreenElement)
    }
  })
}

test("context menu retains internal clicks and reopens across mouse and keyboard triggers", async () => {
  const stage = page.locator('[data-slot="image-viewer-stage"]')
  const box = (await stage.boundingBox())!
  await stage.click({ button: "right", position: { x: 20, y: 20 } })
  const menu = page.getByRole("menu")
  await menu.waitFor()
  const first = (await menu.boundingBox())!
  const disabled = page.getByRole("menuitem", { name: "Zoom out", exact: true })
  expect(await disabled.getAttribute("aria-disabled")).toBe("true")
  const item = (await disabled.boundingBox())!
  await page.mouse.click(item.x + item.width / 2, item.y + item.height / 2)
  expect(await menu.count()).toBe(1)
  await menu.click({ position: { x: 2, y: 2 } })
  expect(await menu.count()).toBe(1)
  await stage.click({ button: "right", position: { x: box.width - 100, y: box.height - 100 } })
  expect((await menu.boundingBox())!.x).toBeGreaterThan(first.x)
  await stage.click({ position: { x: 20, y: 20 } })
  await menu.waitFor({ state: "detached", timeout: 2000 })
  const next = page.getByRole("button", { name: "Next image", exact: true })
  await next.focus()
  await page.keyboard.press("Shift+F10")
  await menu.waitFor()
  await page.waitForFunction(
    () => document.querySelector('[data-component="image-viewer-menu"]')?.contains(document.activeElement),
    undefined,
    { timeout: 3000 },
  )
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Next image", undefined, {
    timeout: 3000,
  })
  expect(await next.evaluate((element) => element === document.activeElement)).toBe(true)
  await stage.click({ button: "right", position: { x: 20, y: 20 } })
  await menu.waitFor()
  await stage.click({ position: { x: box.width - 20, y: box.height - 20 } })
  await menu.waitFor({ state: "detached", timeout: 2000 })
  expect(await stage.evaluate((element) => element === document.activeElement)).toBe(true)
})

test("a touch long-press menu dismisses on an outside tap without reopening", async () => {
  const touch = await browser.newPage({ viewport: { width: 1200, height: 800 }, hasTouch: true })
  const session = await touch.context().newCDPSession(touch)
  try {
    await touch.goto(`${server.url}viewer.html`)
    await touch.getByRole("button", { name: "Open images", exact: true }).tap()
    await touch.locator('[data-slot="image-viewer-image"]').evaluate((element: HTMLImageElement) => element.decode())
    const stage = touch.locator('[data-slot="image-viewer-stage"]')
    const box = (await stage.boundingBox())!
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + 20, y: box.y + 20, id: 1 }],
    })
    try {
      await touch.getByRole("menu").waitFor({ timeout: 3000 })
    } finally {
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    }
    await touch.touchscreen.tap(box.x + box.width - 20, box.y + box.height - 20)
    await touch.getByRole("menu").waitFor({ state: "detached", timeout: 2000 })
    expect(await touch.getByRole("dialog").count()).toBe(1)
    expect(await stage.getAttribute("data-dragging")).toBeNull()
    await touch.getByRole("button", { name: "Next image", exact: true }).tap()
    expect(await touch.locator('[data-slot="image-preview-title"]').innerText()).toBe("same-source.svg")
    expect(await touch.getByRole("menu").count()).toBe(0)
  } finally {
    await session.detach()
    await touch.close()
  }
})

test("keyboard gallery navigation keeps the selected thumbnail in view", async () => {
  await page.evaluate(() => {
    const image = document.querySelector<HTMLImageElement>('[data-slot="image-viewer-image"]')!
    const fixture = (window as unknown as { imageFixture: { setImages: (images: unknown[]) => void } }).imageFixture
    fixture.setImages(
      Array.from({ length: 24 }, (_, index) => ({
        id: `image-${index}`,
        src: image.src,
        filename: `image-${index}.svg`,
        mime: "image/svg+xml",
      })),
    )
  })
  await page.locator('[data-slot="image-viewer-stage"]').focus()
  for (let index = 1; index < 24; index++) await page.keyboard.press("PageDown")
  const strip = (await page.locator('[data-slot="image-viewer-thumbnails"]').boundingBox())!
  const selected = (await page.getByRole("button", { name: "image-23.svg", exact: true }).boundingBox())!
  expect(selected.x).toBeGreaterThanOrEqual(strip.x)
  expect(selected.x + selected.width).toBeLessThanOrEqual(strip.x + strip.width)
  expect(await page.locator('[data-slot="image-viewer-footer"]').innerText()).toContain("24 / 24")
})

test("uncached images stay loading and a late load cannot replace the current image", async () => {
  const release = Promise.withResolvers<void>()
  await page.route("**/slow.svg", async (route) => {
    await release.promise
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="777" height="111"/>',
    })
  })
  try {
    await page.evaluate(() => {
      const image = document.querySelector<HTMLImageElement>('[data-slot="image-viewer-image"]')!
      const fixture = (window as unknown as { imageFixture: { setImages: (images: unknown[]) => void } }).imageFixture
      fixture.setImages([
        { id: "first", src: image.src, filename: "large.svg", mime: "image/svg+xml" },
        { id: "slow", src: `${location.origin}/slow.svg`, filename: "slow.svg", mime: "image/svg+xml" },
      ])
    })
    await page.getByRole("button", { name: "Next image", exact: true }).click()
    const stage = page.locator('[data-slot="image-viewer-stage"]')
    expect(await stage.getAttribute("aria-busy")).toBe("true")
    expect(await page.getByRole("button", { name: "Zoom in", exact: true }).isDisabled()).toBe(true)
    await stage.click({ button: "right", position: { x: 20, y: 20 } })
    await page.getByRole("menu").waitFor()
    const box = (await stage.boundingBox())!
    await stage.click({ position: { x: box.width - 20, y: box.height - 20 } })
    await page.getByRole("menu").waitFor({ state: "detached", timeout: 2000 })
    await page.getByRole("button", { name: "Previous image", exact: true }).click()
    const response = page.waitForResponse("**/slow.svg")
    release.resolve()
    await (await response).finished()
    const image = page.locator('[data-slot="image-viewer-image"]')
    await image.evaluate((element: HTMLImageElement) => element.decode())
    expect(await image.getAttribute("alt")).toBe("large.svg")
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(4000)
    expect(await stage.getAttribute("aria-busy")).toBe("false")
    await page.getByRole("button", { name: "Next image", exact: true }).click()
    await image.evaluate((element: HTMLImageElement) => element.decode())
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(777)
    expect(await page.getByRole("button", { name: "Zoom in", exact: true }).isEnabled()).toBe(true)
  } finally {
    release.resolve()
    await page.unrouteAll({ behavior: "wait" })
  }
})

test("failed images retry the same URL and recover", async () => {
  let failed = true
  await page.route("**/retry.svg", (route) =>
    route.fulfill(
      failed
        ? { status: 503, body: "unavailable" }
        : { contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="30"/>' },
    ),
  )
  await page.evaluate(() => {
    const fixture = (window as unknown as { imageFixture: { setImages: (images: unknown[]) => void } }).imageFixture
    fixture.setImages([
      { id: "retry", src: `${location.origin}/retry.svg`, filename: "retry.svg", mime: "image/svg+xml" },
    ])
  })
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Zoom in", exact: true }).isDisabled()).toBe(true)
  const stage = page.locator('[data-slot="image-viewer-stage"]')
  const box = (await stage.boundingBox())!
  await stage.click({ button: "right", position: { x: 20, y: 20 } })
  await page.getByRole("menu").waitFor()
  await stage.click({ position: { x: box.width - 20, y: box.height - 20 } })
  await page.getByRole("menu").waitFor({ state: "detached", timeout: 2000 })
  failed = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('[data-slot="image-viewer-stage"]')?.getAttribute("aria-busy") === "false",
  )
  expect(await page.getByRole("button", { name: "Zoom in", exact: true }).isEnabled()).toBe(true)
  await page.unroute("**/retry.svg")
})

test("short windows keep close, stage and all toolbar controls reachable", async () => {
  await page.setViewportSize({ width: 375, height: 320 })
  for (const name of ["Close image preview", "Fit image", "Image actions"]) {
    const button = page.getByRole("button", { name, exact: true })
    await button.scrollIntoViewIfNeeded()
    const box = (await button.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(320)
  }
  const stage = (await page.locator('[data-slot="image-viewer-stage"]').boundingBox())!
  expect(stage.height).toBeGreaterThan(0)
})

test("web save delivers original bytes and reports dispatch, not saved", async () => {
  const pending = page.waitForEvent("download")
  await page.getByRole("button", { name: "Save image", exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe("large.svg")
  const bytes = await Bun.file((await download.path())!).text()
  expect(bytes).toContain('width="4000"')
  await page.getByText("Download started", { exact: true }).waitFor()
  expect(await page.getByText("Image saved", { exact: true }).count()).toBe(0)
})

test("real clipboard receives PNG pixels rather than a link", async () => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.getByRole("button", { name: "Copy image", exact: true }).click()
  await page.getByText("Image copied", { exact: true }).waitFor()
  const result = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const blob = await items[0]!.getType("image/png")
    const image = await createImageBitmap(blob)
    return { type: blob.type, width: image.width, height: image.height }
  })
  expect(result).toEqual({ type: "image/png", width: 4000, height: 3000 })
})

test("fullscreen portals stay inside the image viewer", async () => {
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click()
  await page.waitForFunction(() => document.fullscreenElement?.getAttribute("data-component") === "image-viewer")
  await page.getByRole("button", { name: "Image actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Exit fullscreen", exact: true }).waitFor()
  expect(await page.getByRole("menu").evaluate((element) => document.fullscreenElement?.contains(element))).toBe(true)
  await page.getByRole("menuitem", { name: "Exit fullscreen", exact: true }).click()
  await page.waitForFunction(() => !document.fullscreenElement)
  expect(await page.getByRole("dialog").count()).toBe(1)
})

test("shrinking a gallery clamps its position, selection and next navigation together", async () => {
  await page.getByRole("button", { name: "small.svg", exact: true }).click()
  await page.evaluate(() => {
    const image = document.querySelector<HTMLImageElement>('[data-slot="image-viewer-thumbnails"] img')!
    const fixture = (window as unknown as { imageFixture: { setImages: (images: unknown[]) => void } }).imageFixture
    fixture.setImages([
      { id: "first", src: image.src, filename: "large.svg", mime: "image/svg+xml" },
      { id: "same", src: image.src, filename: "same-source.svg", mime: "image/svg+xml" },
    ])
  })
  expect(await page.locator('[data-slot="image-viewer-footer"]').innerText()).toContain("2 / 2")
  expect(await page.getByRole("button", { name: "same-source.svg", exact: true }).getAttribute("aria-current")).toBe(
    "true",
  )
  await page.getByRole("button", { name: "Previous image", exact: true }).click()
  expect(await page.locator('[data-slot="image-preview-title"]').innerText()).toBe("large.svg")
})

test("fullscreen Tab and Shift+Tab wrap within visible viewer controls", async () => {
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click()
  await page.waitForFunction(() => !!document.fullscreenElement)
  await page.locator('[data-slot="image-viewer-stage"]').click({ button: "right" })
  await page.getByRole("menu").waitFor()
  await page.keyboard.press("Escape")
  await page.locator('[data-component="image-viewer-menu"]').waitFor({ state: "detached" })
  await page.locator('[data-component="image-viewer"] > [data-focus-trap]').first().waitFor({ state: "attached" })
  const first = page.getByRole("button", { name: "Fit image", exact: true })
  const last = page.getByRole("button", { name: "small.svg", exact: true })
  await last.focus()
  await page.keyboard.press("Tab")
  expect(await first.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.keyboard.press("Shift+Tab")
  expect(await last.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click()
  await page.waitForFunction(() => !document.fullscreenElement)
})

test("a late source result does not close a gallery after changing images", async () => {
  await page.evaluate("window.imageFixture.holdSource()")
  await page.getByRole("button", { name: "Image actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "View source in Files", exact: true }).click()
  await page.getByRole("button", { name: "Next image", exact: true }).click()
  await page.evaluate("window.imageFixture.finishSource()")
  expect(await page.getByRole("dialog").count()).toBe(1)
  expect(await page.locator('[data-slot="image-preview-title"]').innerText()).toBe("same-source.svg")
})

test("source failures are local, visible and leave the viewer usable", async () => {
  await page.evaluate("window.imageFixture.failSource()")
  await page.getByRole("button", { name: "Image actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "View source in Files", exact: true }).click()
  await page.getByText("Source is unavailable", { exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Save image", exact: true }).isEnabled()).toBe(true)
})

test("late copy completion cannot overwrite the next image feedback", async () => {
  await page.evaluate("window.imageFixture.holdCopy()")
  await page.getByRole("button", { name: "Copy image", exact: true }).click()
  await page.getByText("Working…", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Next image", exact: true }).click()
  await page.evaluate("window.imageFixture.finishCopy()")
  expect(await page.getByText("Image copied", { exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Save image", exact: true }).isEnabled()).toBe(true)
})

test("inactive viewers close their menu without losing the accepted transform", async () => {
  await page.goto(`${server.url}viewer.html?inline`)
  await page.locator('[data-slot="image-viewer-image"]').evaluate((element: HTMLImageElement) => element.decode())
  await page.waitForFunction(
    () => document.querySelector('[data-slot="image-viewer-stage"]')?.getAttribute("aria-busy") === "false",
  )
  await page.getByRole("button", { name: "Actual size (1:1)", exact: true }).click()
  await page.locator('[data-slot="image-viewer-stage"]').click({ button: "right" })
  await page.getByRole("menu").waitFor()
  await page.evaluate("window.imageFixture.setActive(false)")
  await page.locator('[data-component="image-viewer-menu"]').waitFor({ state: "detached" })
  await page.evaluate("window.imageFixture.setActive(true)")
  expect((await page.locator('[data-slot="image-viewer-image"]').boundingBox())!.width).toBeCloseTo(4000, 0)
})

test("two-finger touch zoom and cancellation preserve a usable viewport", async () => {
  const stage = page.locator('[data-slot="image-viewer-stage"]')
  const box = (await stage.boundingBox())!
  const image = page.locator('[data-slot="image-viewer-image"]')
  const before = (await image.boundingBox())!
  const session = await page.context().newCDPSession(page)
  const y = box.y + box.height / 2
  const x = box.x + box.width / 2
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: x - 40, y, id: 1 },
      { x: x + 40, y, id: 2 },
    ],
  })
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: x - 100, y, id: 1 },
      { x: x + 100, y, id: 2 },
    ],
  })
  await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
  expect((await image.boundingBox())!.width).toBeGreaterThan(before.width * 2)
  expect(await stage.getAttribute("data-dragging")).toBeNull()
  await stage.focus()
  await page.keyboard.press("0")
  expect((await image.boundingBox())!.width).toBeCloseTo(before.width, 0)
  await session.detach()
})
