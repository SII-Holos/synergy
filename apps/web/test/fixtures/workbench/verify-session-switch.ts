import assert from "node:assert/strict"
import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { createSynergyClient, type Session } from "@ericsanchezok/synergy-sdk/client"

const [home, origin] = process.argv.slice(2)
if (!home || !origin) throw new Error("Usage: verify-session-switch.ts <isolated-home> <production-origin>")
const url = new URL(origin)
assert.ok(url.hostname === "127.0.0.1" && url.protocol === "http:" && url.port)
const selectedHome = await realpath(home)
assert.notEqual(selectedHome, await realpath(homedir()))
const client = createSynergyClient({ baseUrl: url.origin })
const options = { throwOnError: true } as const
assert.equal(await realpath((await client.path.get({ scopeID: "home" }, options)).data.home), selectedHome)
const fixtureFile = Bun.file(path.join(home, "session-switch-fixtures.json"))
const sessions: Session[] = (await fixtureFile.exists()) ? await fixtureFile.json() : []
const run = Date.now()
for (const title of sessions.length ? [] : [`Switch fixture A ${run}`, `Switch fixture B ${run}`]) {
  const session = (await client.session.create({ scopeID: "home", title }, options)).data
  sessions.push(session)
  for (let index = 0; index < 8; index++) {
    await client.session.input(
      {
        scopeID: "home",
        sessionID: session.id,
        model: { providerID: "fixture", modelID: "fixture-chat" },
        parts: [{ type: "text", text: `${title} message ${index}\n\n` + "Synthetic reading content. ".repeat(70) }],
      },
      options,
    )
  }
  const until = Date.now() + 90_000
  while ((await client.session.timelinePage({ scopeID: "home", sessionID: session.id }, options)).data.total < 8) {
    if (Date.now() > until) throw new Error("Synthetic input did not materialize")
    await Bun.sleep(50)
  }
  while (true) {
    const status = (await client.session.statuses(options)).data[session.id]
    if (!status || status.type === "idle") break
    if (Date.now() > until) throw new Error("Synthetic execution did not settle")
    await Bun.sleep(100)
  }
}
await Bun.write(fixtureFile, JSON.stringify(sessions))
const output = path.join(home, "acceptance-session-switch")
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const errors: string[] = []
type FrameMeasurements = {
  samples: number[]
  missingBodies: number
  pendingFrames: number
  exposedPendingFrames: number
  active: boolean
}
const measurements: {
  theme: string
  width: number
  preparationReads: number
  switches: number
  largestVisibleGap: number
  pendingFrames: number
}[] = []
try {
  for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("**/global/capabilities", async (route) => {
      await Bun.sleep(250)
      await route.continue()
    })
    await page.route("**/event/replay*", async (route) => {
      await Bun.sleep(250)
      await route.continue()
    })
    const preparationReads = new Map<string, number>()
    page.on("request", (request) => {
      for (const session of sessions) {
        if (request.url().includes(`/global/storage/upgrade/sessions/${session.id}/prepare`))
          preparationReads.set(session.id, (preparationReads.get(session.id) ?? 0) + 1)
      }
    })
    await page.addInitScript(() => {
      const state: FrameMeasurements = {
        samples: [],
        missingBodies: 0,
        pendingFrames: 0,
        exposedPendingFrames: 0,
        active: true,
      }
      Object.assign(window, { switchMeasurements: state })
      const sample = () => {
        if (!state.active) return
        const viewport = document.querySelector("[data-conversation-viewport]")
        if (viewport?.getAttribute("aria-hidden") === "true") {
          state.pendingFrames++
          const exposed = [...viewport.querySelectorAll<HTMLElement>("[data-display-row]")].some((row) => {
            const bounds = row.getBoundingClientRect()
            if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.top >= innerHeight) return false
            if (getComputedStyle(row).visibility !== "visible") return false
            for (let element: HTMLElement | null = row; element; element = element.parentElement) {
              const style = getComputedStyle(element)
              if (style.display === "none" || Number(style.opacity) === 0) return false
            }
            return true
          })
          if (exposed) state.exposedPendingFrames++
        } else if (viewport) {
          state.samples.push(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)
          if (!viewport.textContent?.includes("Synthetic reading content.")) state.missingBodies++
        }
        requestAnimationFrame(() => setTimeout(sample, 0))
      }
      requestAnimationFrame(sample)
    })
    await page.goto(`${url.origin}/aG9tZQ/session/${sessions[0].id}`)
    const viewport = page.locator('[data-conversation-viewport][aria-hidden="false"]')
    await viewport.waitFor()
    assert.ok((await viewport.innerText()).includes("Synthetic reading content."), "cold admission contains its body")
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 })
      if (width === 375) {
        await page.goto(`${url.origin}/aG9tZQ/session/${sessions[0].id}`)
        await viewport.waitFor()
        assert.ok(
          (await viewport.innerText()).includes("Synthetic reading content."),
          "phone admission contains its body",
        )
      }
      if (width === 1440) {
        for (let index = 0; index < 6; index++) {
          const target = sessions[(index + 1) % 2]
          await page.getByText(target.title, { exact: true }).first().click()
          await page.waitForURL(`**/session/${target.id}`)
          await viewport.waitFor()
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          )
          assert.ok(
            (await viewport.innerText()).includes(`${target.title} message 7`),
            "admitted navigation contains its user body",
          )
          assert.ok(
            await viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop <= 2),
            "visible navigation starts at latest content",
          )
        }
        for (let index = 0; index < 6; index++) {
          await page
            .getByText(sessions[(index + 1) % 2].title, { exact: true })
            .first()
            .click()
        }
        await page.waitForURL(`**/session/${sessions[0].id}`)
        await viewport.waitFor()
        assert.ok(
          (await viewport.innerText()).includes(`${sessions[0].title} message 7`),
          "rapid target replacement admits only the final target's body",
        )
      }
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      const frames = await page.evaluate(() => {
        const state = (window as unknown as { switchMeasurements: FrameMeasurements }).switchMeasurements
        state.active = false
        return state
      })
      const { samples, missingBodies, pendingFrames, exposedPendingFrames } = frames
      assert.equal(missingBodies, 0, "every admitted animation frame retains its user body")
      assert.ok(pendingFrames > 0, "pending admission was observed")
      assert.equal(exposedPendingFrames, 0, "pending admission never exposes virtual rows")
      const largestVisibleGap = Math.max(0, ...samples)
      await Bun.write(path.join(output, `${theme}-${width}-frames.json`), JSON.stringify(frames))
      assert.ok(largestVisibleGap <= 2, "every admitted animation frame stays at latest")
      if (width === 1440) {
        assert.ok(
          [...preparationReads.values()].every((count) => count <= 1),
          "cached return does not repeat preparation",
        )
        assert.equal(preparationReads.size, 2, "both cold preparations were observed")
      }
      measurements.push({
        theme,
        width,
        preparationReads: [...preparationReads.values()].reduce((sum, count) => sum + count, 0),
        switches: width === 1440 ? 12 : 0,
        largestVisibleGap,
        pendingFrames,
      })
      await page.screenshot({ path: path.join(output, `${theme}-${width}.png`) })
    }
    await context.close()
  }
  assert.deepEqual(errors, [])
  await Bun.write(path.join(output, "measurements.json"), JSON.stringify(measurements, null, 2))
  console.log(
    JSON.stringify({
      checks:
        "production Session switching, pending visibility, rapid replacement, cached preparation, first visible scroll, both themes and phone layout",
      measurements,
    }),
  )
} finally {
  await browser.close()
}
