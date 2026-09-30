import { expect, test } from "bun:test"

test("Desktop release uses bundled Electron without separately published browsers", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/release.yml", import.meta.url)).text(),
  )
  const steps = workflow.jobs.stable_desktop_package.steps as Array<{ name?: string; run?: string }>
  expect(steps.some((step) => /Chromium manifests|Browser Host/.test(step.name ?? ""))).toBe(false)
  expect(steps.some((step) => /browser-host:|chromium-manifest/.test(step.run ?? ""))).toBe(false)
  expect(steps.some((step) => step.name === "Upload desktop artifact bundle")).toBe(true)
})
