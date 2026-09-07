import path from "node:path"
import { createRequire } from "node:module"
import { startPluginPreview, approvePreviewPlugins } from "../../packages/plugin-kit/src/testing"
import { importPreviewConversation } from "./session-fixture"

const root = path.resolve(import.meta.dir, "../..")
const require = createRequire(path.join(root, "packages/app/package.json"))
const { chromium } = await import(require.resolve("playwright"))
const baseline = process.argv[2]
const output = process.argv[3]
if (!baseline || !output) throw new Error("Usage: bun test/plugin-ui5/benchmark.ts <baseline-checkout> <output.json>")
const browser = await chromium.launch({ headless: true })
const results = []
try {
  for (const [label, checkout] of [
    ["baseline", path.resolve(baseline)],
    ["ui5", root],
  ]) {
    const { createFixtureProject, writeMinimalPlugin } = await import(
      path.join(checkout!, "packages/plugin-kit/test/fixtures.ts")
    )
    const { buildPluginProject } = await import(path.join(checkout!, "packages/plugin-kit/src/commands/build.ts"))
    const project = createFixtureProject("ui-benchmark")
    let preview: Awaited<ReturnType<typeof startPluginPreview>> | undefined
    try {
      writeMinimalPlugin(
        project,
        `import { definePlugin, navigationItem } from "@ericsanchezok/synergy-plugin"
export default definePlugin({ id: "benchmark-panel", version: "1.0.0", description: "Benchmark panel", contributions: [navigationItem({ id: "panel", label: "Benchmark panel", placement: "sidebar", component: { source: "./src/ui.tsx" } })] })`,
        "benchmark-panel",
      )
      project.writeFile(
        "src/ui.tsx",
        "export default function Panel() { return <div data-benchmark-panel>Benchmark panel ready</div> }",
      )
      if (!(await buildPluginProject(project.root))) throw new Error("Benchmark plugin build failed")
      preview = await startPluginPreview({
        artifacts: [path.join(project.root, "dist")],
        command: [process.execPath, path.join(checkout!, "packages/synergy/src/index.ts")],
      })
      await approvePreviewPlugins(preview)
      const a = await importPreviewConversation(preview, { title: "Benchmark A", turns: 160 })
      const b = await importPreviewConversation(preview, { title: "Benchmark B", turns: 160 })
      const trials = []
      for (let trial = 0; trial < 3; trial++) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
        try {
          const page = await context.newPage()
          page.setDefaultTimeout(20000)
          const errors: string[] = []
          const requests: { method: string; url: string }[] = []
          page.on("pageerror", (error) => errors.push(error.message))
          page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }))
          const frame = () =>
            page.evaluate(
              () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
            )
          const navigate = async (url: string) => {
            await page.evaluate((href) => {
              const anchor = document.createElement("a")
              anchor.href = href
              document.body.append(anchor)
              anchor.click()
              anchor.remove()
            }, url)
          }
          const firstStart = performance.now()
          await page.goto(preview.url)
          await page.locator("[data-component=prompt-input]").waitFor()
          await frame()
          const firstScreenMs = performance.now() - firstStart
          const initial = await page.evaluate(() =>
            performance
              .getEntriesByType("resource")
              .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
              .filter((entry) => /\.(js|css)(\?|$)/.test(entry.name))
              .map((entry) => ({ path: new URL(entry.name).pathname, bytes: entry.encodedBodySize })),
          )
          await navigate(a.url)
          await page.getByText("Question 160", { exact: true }).waitFor()
          const switches = []
          for (const target of [b, a, b, a]) {
            const start = performance.now()
            await navigate(target.url)
            await page.waitForURL(target.url)
            await page.locator(`[data-message-role="user"]`).first().waitFor()
            await frame()
            switches.push(performance.now() - start)
          }
          const snapshot = await preview.client.session.messages(
            { scopeID: "home", sessionID: a.id },
            { throwOnError: true },
          )
          const latest =
            snapshot.data?.find((item) =>
              item.parts.some((part) => part.type === "text" && part.text === "Answer 160"),
            ) ?? snapshot.data?.at(-1)
          const textPart = latest?.parts.find((part) => part.type === "text")
          if (!latest || !textPart) throw new Error("Benchmark message part is missing")
          const requestStart = requests.length
          const updateStart = performance.now()
          for (let index = 0; index < 60; index++) {
            await preview.client.part.update(
              {
                scopeID: "home",
                sessionID: a.id,
                messageID: latest.info.id,
                partID: textPart.id,
                part: {
                  ...textPart,
                  sessionID: a.id,
                  type: "text",
                  text: `Stream ${trial}: ${"token ".repeat(index + 1).trimEnd()}`,
                },
              },
              { throwOnError: true },
            )
          }
          await page
            .getByText(`Stream ${trial}: ${"token ".repeat(60).trimEnd()}`, { exact: true })
            .waitFor()
            .catch(async (error) => {
              console.error(
                JSON.stringify({
                  url: page.url(),
                  latest,
                  tail: (await page.locator("body").innerText()).slice(-3500),
                  requests: requests.slice(requestStart),
                }),
              )
              throw error
            })
          await frame()
          const streamMs = performance.now() - updateStart
          const streamReads = requests
            .slice(requestStart)
            .filter((request) => request.method === "GET" && /\/session\//.test(request.url)).length
          const renderedRoots = await page.locator('[data-message-role="user"]').count()
          const panelStart = performance.now()
          await navigate(new URL("/plugins/benchmark-panel/panel", preview.url).href)
          await page.locator("[data-benchmark-panel]").waitFor()
          await frame()
          const firstPluginOpenMs = performance.now() - panelStart
          const bundleRequests = requests.filter((request) =>
            /\/plugin\/assets\/.*\/ui\/index\.js/.test(request.url),
          ).length
          if (errors.length || renderedRoots > 80 || streamReads > 0 || (label === "ui5" && bundleRequests !== 1))
            throw new Error(JSON.stringify({ errors, renderedRoots, streamReads, bundleRequests }))
          trials.push({
            firstScreenMs,
            initialBytes: initial.reduce((sum, entry) => sum + entry.bytes, 0),
            initialFiles: initial.length,
            sessionSwitchMs: switches,
            stream60UpdatesMs: streamMs,
            firstPluginOpenMs,
            renderedRoots,
            streamReads,
            bundleRequests,
          })
        } finally {
          await context.close()
        }
      }
      results.push({ label, trials })
      console.log(JSON.stringify(results.at(-1)))
    } finally {
      await preview?.close()
      project.cleanup()
    }
  }
  await Bun.write(
    output,
    JSON.stringify(
      {
        environment: { platform: process.platform, arch: process.arch, bun: Bun.version, chromium: browser.version() },
        results,
      },
      null,
      2,
    ) + "\n",
  )
} finally {
  await browser.close()
}
