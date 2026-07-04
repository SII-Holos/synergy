#!/usr/bin/env bun
type PlaywrightModule = {
  chromium: {
    launch: () => Promise<{
      newContext: (options: { recordHar: { path: string; content: "omit" } }) => Promise<{
        tracing: {
          start: (options: { screenshots: boolean; snapshots: boolean; sources: boolean }) => Promise<void>
          stop: (options: { path: string }) => Promise<void>
        }
        newPage: () => Promise<{
          goto: (url: string, options: { waitUntil: "networkidle" }) => Promise<unknown>
          title: () => Promise<string>
        }>
        close: () => Promise<void>
      }>
      close: () => Promise<void>
    }>
  }
}

const baseUrl = process.env.SYNERGY_PERF_APP_URL ?? "http://127.0.0.1:3000"
const outDir = process.env.SYNERGY_PERF_ARTIFACT_DIR ?? "artifacts/performance/playwright"

async function main() {
  let chromium: PlaywrightModule["chromium"]
  try {
    ;({ chromium } = (await import("playwright")) as PlaywrightModule)
  } catch {
    console.error("playwright is optional. Install it before running: bun add -d playwright")
    process.exit(1)
  }

  await Bun.$`mkdir -p ${outDir}`
  const browser = await chromium.launch()
  const context = await browser.newContext({ recordHar: { path: `${outDir}/performance.har`, content: "omit" } })
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
  const page = await context.newPage()
  const start = performance.now()
  await page.goto(baseUrl, { waitUntil: "networkidle" })
  const title = await page.title().catch(() => "")
  const navigationMs = performance.now() - start
  await context.tracing.stop({ path: `${outDir}/trace.zip` })
  await context.close()
  await browser.close()
  await Bun.write(
    `${outDir}/summary.json`,
    JSON.stringify({ baseUrl, title, navigationMs, artifacts: ["trace.zip", "performance.har"] }, null, 2),
  )
  console.log(JSON.stringify({ baseUrl, navigationMs, outDir }, null, 2))
}

await main()
