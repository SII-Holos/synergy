import { expect, test } from "bun:test"
import path from "node:path"
import { createRequire } from "node:module"
import { startPluginPreview, approvePreviewPlugins, openPluginPreviewPage } from "../../packages/plugin-kit/src/testing"
import { createFixtureProject } from "../../packages/plugin-kit/test/fixtures"
import { scaffoldPluginProject } from "../../packages/plugin-kit/src/commands/create"
import { buildPluginProject } from "../../packages/plugin-kit/src/commands/build"

const require = createRequire(path.resolve(import.meta.dir, "../../apps/web/package.json"))
const { chromium } = await import(require.resolve("playwright"))

test("custom composer submits once and a running response survives switching to the native workbench", async () => {
  const started = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method === "GET")
        return Response.json({ object: "list", data: [{ id: "fixture", object: "model", owned_by: "fixture" }] })
      const input = await request.json()
      if (new URL(request.url).pathname.endsWith("/embeddings"))
        return Response.json({
          object: "list",
          data: [
            { object: "embedding", index: 0, embedding: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)) },
          ],
          model: "fixture-embedding",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
      if (!input.stream)
        return Response.json({
          id: "fixture-response",
          object: "chat.completion",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, message: { role: "assistant", content: "Fixture response" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder()
            const send = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
                ),
              )
            send({ role: "assistant", content: "Shared response" })
            started.resolve()
            await resume.promise
            send({ content: " completed." })
            send({}, "stop")
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
  const project = createFixtureProject("composer-host")
  const browser = await chromium.launch({ headless: true })
  let preview: Awaited<ReturnType<typeof startPluginPreview>> | undefined
  let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
  try {
    scaffoldPluginProject("composer-shell", "shell", project.root)
    expect(await buildPluginProject(project.root)).toBe(true)
    preview = await startPluginPreview({
      artifacts: [path.join(project.root, "dist")],
      command: [process.execPath, path.resolve(import.meta.dir, "../../packages/product-runtime/src/index.ts")],
    })
    await preview.client.config.domain.update(
      {
        domain: "providers",
        configDomainUpdateInput: {
          config: {
            provider: {
              fixture: {
                name: "Fixture",
                npm: "@ai-sdk/openai-compatible",
                env: [],
                options: { baseURL: `${provider.url.origin}/v1`, apiKey: "fixture-only" },
                models: { fixture: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
              },
            },
          },
        },
      },
      { throwOnError: true },
    )
    await preview.client.config.domain.update(
      {
        domain: "models",
        configDomainUpdateInput: { config: { model: "fixture/fixture", nano_model: "fixture/fixture" } },
      },
      { throwOnError: true },
    )
    await preview.client.config.domain.update(
      {
        domain: "general",
        configDomainUpdateInput: {
          config: {
            embedding: { apiKey: "fixture", baseURL: `${provider.url.origin}/v1`, model: "fixture-embedding" },
          },
        },
      },
      { throwOnError: true },
    )
    await approvePreviewPlugins(preview)
    const page = await browser.newPage()
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = async () => {
        throw new DOMException("Audio output is unavailable", "NotSupportedError")
      }
    })
    page.setDefaultTimeout(20000)
    await page.addInitScript(
      (server) =>
        localStorage.setItem(
          "synergy.global.dat:plugin-shells",
          JSON.stringify({ version: 1, servers: { [server]: "composer-shell:main" } }),
        ),
      new URL(preview.url).origin,
    )
    diagnostics = await openPluginPreviewPage(preview, page)
    const input = page.getByRole("textbox", { name: "Message", exact: true })
    await input.waitFor()
    await input.fill("Keep this response running through a workbench change")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        started.promise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Fixture provider was not called")), 20000)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
    await page.waitForURL(/\/session\/ses_/)
    const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
    const recovery = new URL(page.url())
    recovery.searchParams.set("safe-ui", "1")
    await page.goto(recovery.href)
    await page.locator("[data-component=prompt-input]").waitFor()
    resume.resolve()
    await page
      .locator('[data-component="session-turn"]')
      .getByText("Shared response completed.", { exact: true })
      .first()
      .waitFor()
    const { data } = await preview.client.session.messages({ scopeID: "home", sessionID }, { throwOnError: true })
    expect(
      data?.filter(
        (item) =>
          item.info.role === "user" &&
          item.parts.some(
            (part) => part.type === "text" && part.text === "Keep this response running through a workbench change",
          ),
      ),
    ).toHaveLength(1)
    expect(diagnostics.errors.map((error) => error.message)).toEqual([])
  } catch (error) {
    throw new AggregateError([error, ...(diagnostics?.errors ?? [])], "Composer real-host acceptance failed")
  } finally {
    resume.resolve()
    diagnostics?.dispose()
    await browser.close()
    await preview?.close()
    provider.stop(true)
    project.cleanup()
  }
}, 90000)
