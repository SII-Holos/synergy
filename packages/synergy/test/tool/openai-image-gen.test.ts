import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Asset } from "../../src/asset/asset"
import { Auth } from "../../src/provider/api-key"
import { CodexProvider } from "../../src/provider/codex"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { OpenAIImageGenTool, openAIImageGenDisplay } from "../../src/tool/openai-image-gen"
import { OPENAI_IMAGE_REQUEST_TIMEOUT_MS } from "../../src/tool/openai-image-shared"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
)

const originalFetch = globalThis.fetch
const originalCodexBaseURL = process.env.SYNERGY_CODEX_BASE_URL

const ctx = {
  sessionID: "ses_image_gen_test",
  messageID: "msg_image_gen_test",
  callID: "call_image_gen_test",
  agent: "synergy-max",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function makeJWT(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.signature`
}

function accessToken(input?: { exp?: number; accountID?: string }) {
  return makeJWT({
    exp: input?.exp ?? nowSeconds() + 60 * 60,
    "https://api.openai.com/auth": {
      chatgpt_account_id: input?.accountID ?? "acct_image_gen_test",
    },
  })
}

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  })
}

function asFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return fn as unknown as typeof fetch
}

async function connectCodex() {
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: accessToken(),
    refresh: "refresh-image-gen-test",
    expires: nowSeconds() + 60 * 60,
  })
}

async function resetCodexState() {
  globalThis.fetch = originalFetch
  if (originalCodexBaseURL === undefined) {
    delete process.env.SYNERGY_CODEX_BASE_URL
  } else {
    process.env.SYNERGY_CODEX_BASE_URL = originalCodexBaseURL
  }
  await Auth.remove(CodexProvider.PROVIDER_ID)
  await Provider.reload()
  await ToolRegistry.reload()
}

beforeEach(resetCodexState)
afterEach(resetCodexState)

describe("tool.openai_image_gen", () => {
  test("is registered only when OpenAI Codex OAuth credentials are available", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await ToolRegistry.ids()).not.toContain("openai_image_gen")

        await connectCodex()
        await ToolRegistry.reload()
        expect(await ToolRegistry.ids()).toContain("openai_image_gen")

        await Auth.markDead(CodexProvider.PROVIDER_ID, "invalid_grant")
        await ToolRegistry.reload()
        expect(await ToolRegistry.ids()).not.toContain("openai_image_gen")
      },
    })
  })

  test("successful generation writes PNG output, stores an asset attachment, and returns hidden media display metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    process.env.SYNERGY_CODEX_BASE_URL = "https://codex.test/backend-api/codex"
    const outputPath = path.join(tmp.path, "generated", "star.png")
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    globalThis.fetch = asFetch(async (input, init) => {
      captured = { input, init }
      return jsonResponse({
        created: 123,
        background: "auto",
        data: [{ b64_json: PNG_BYTES.toString("base64") }],
        output_format: "png",
        quality: "low",
        size: "1254x1254",
        usage: { total_tokens: 10 },
      })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        const result = await tool.execute(
          {
            prompt: "A tiny yellow star on a warm white background, no text, no watermark.",
            output_path: outputPath,
            size: "1024x1024",
            quality: "low",
            background: "auto",
          },
          ctx,
        )

        expect(String(captured?.input)).toBe("https://codex.test/backend-api/codex/images/generations")
        const body = JSON.parse(String(captured?.init?.body))
        expect(body).toEqual({
          prompt: "A tiny yellow star on a warm white background, no text, no watermark.",
          background: "auto",
          model: "gpt-image-2",
          quality: "low",
          size: "1024x1024",
        })
        const headers = new Headers(captured?.init?.headers)
        expect(headers.get("authorization")).toStartWith("Bearer ")
        expect(headers.get("chatgpt-account-id")).toBe("acct_image_gen_test")

        expect(Buffer.from(await Bun.file(outputPath).arrayBuffer())).toEqual(PNG_BYTES)
        expect(result.title).toBe("star.png")
        expect(result.output).toBe(`Generated image saved to ${outputPath} (${PNG_BYTES.length} B).`)
        expect(result.output).not.toContain(PNG_BYTES.toString("base64"))
        expect(result.metadata).toMatchObject({
          prompt: "A tiny yellow star on a warm white background, no text, no watermark.",
          model: "gpt-image-2",
          outputPath,
          requested: { size: "1024x1024", quality: "low", background: "auto" },
          response: {
            created: 123,
            size: "1254x1254",
            quality: "low",
            background: "auto",
            outputFormat: "png",
            usage: { total_tokens: 10 },
          },
          bytes: PNG_BYTES.length,
          display: openAIImageGenDisplay,
          truncated: false,
        })

        const attachment = result.attachments?.[0]
        expect(attachment).toBeDefined()
        expect(attachment?.sessionID).toBe(ctx.sessionID)
        expect(attachment?.messageID).toBe(ctx.messageID)
        expect(attachment?.mime).toBe("image/png")
        expect(attachment?.filename).toBe("star.png")
        expect(attachment?.url).toStartWith("asset://")
        expect(attachment?.url).not.toStartWith("data:")
        expect(attachment?.localPath).toBe(outputPath)
        expect(attachment?.presentation).toEqual({ renderer: "image", size: "medium", crop: false })
        expect(attachment?.model).toEqual({
          mode: "provider-file",
          summary: `Generated image saved to ${outputPath}`,
        })

        const assetID = attachment!.url.slice("asset://".length)
        const asset = await Asset.read(assetID)
        expect(asset).toBeDefined()
        expect(Buffer.from(await asset!.arrayBuffer())).toEqual(PNG_BYTES)
      },
    })
  })

  test("relative output_path resolves under the current workspace and creates parent directories", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    globalThis.fetch = asFetch(async () =>
      jsonResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }], output_format: "png" }),
    )

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        const result = await tool.execute(
          {
            prompt: "One small green leaf, no text, no watermark.",
            output_path: "assets/generated/leaf.png",
            size: "auto",
            quality: "auto",
            background: "auto",
          },
          ctx,
        )

        const resolved = path.join(tmp.path, "assets", "generated", "leaf.png")
        expect(Buffer.from(await Bun.file(resolved).arrayBuffer())).toEqual(PNG_BYTES)
        expect(result.metadata.outputPath).toBe(resolved)
        expect(result.attachments?.[0]?.filename).toBe("leaf.png")
      },
    })
  })

  test("invalid size rejects before making a network call", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    let fetchCalls = 0
    globalThis.fetch = asFetch(async (input) => {
      // Test shards share globalThis.fetch, so unrelated requests must not
      // affect the assertion that invalid image arguments make no image call.
      if (!String(input).includes("/images/")) {
        return jsonResponse({ error: { message: "unrelated" } }, { status: 200 })
      }
      fetchCalls++
      return jsonResponse({})
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        await expect(
          tool.execute(
            {
              prompt: "A square icon.",
              output_path: "generated/icon.png",
              size: "123x456",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("The openai_image_gen tool was called with invalid arguments")
        expect(fetchCalls).toBe(0)
      },
    })
  })

  test("non-2xx provider errors are concise and do not leak tokens or base64 payloads", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    const token = accessToken()
    const imageData = PNG_BYTES.toString("base64").repeat(4)
    globalThis.fetch = asFetch(async () =>
      jsonResponse(
        {
          error: {
            message: `request failed token ${token} image ${imageData}`,
          },
        },
        { status: 500 },
      ),
    )

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        let thrown: unknown
        try {
          await tool.execute(
            {
              prompt: "A red circle.",
              output_path: "generated/red.png",
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          )
        } catch (error) {
          thrown = error
        }

        expect(thrown).toBeInstanceOf(Error)
        const message = String((thrown as Error).message)
        expect(message).toContain("Codex image generation failed with status 500")
        expect(message).toContain("[redacted token]")
        expect(message).toContain("[redacted image data]")
        expect(message).not.toContain(token)
        expect(message).not.toContain(imageData.slice(0, 80))
      },
    })
  }, 20_000)
  test("missing image data rejects without writing output", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    const outputPath = path.join(tmp.path, "generated", "missing.png")
    globalThis.fetch = asFetch(async () => jsonResponse({ data: [{}] }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        await expect(
          tool.execute(
            {
              prompt: "A blue square.",
              output_path: outputPath,
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("Codex image generation response did not include image data.")
        expect(await Bun.file(outputPath).exists()).toBe(false)
      },
    })
  })

  test("invalid base64 image data rejects without writing output", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    const outputPath = path.join(tmp.path, "generated", "invalid.png")
    globalThis.fetch = asFetch(async () => jsonResponse({ data: [{ b64_json: "not base64!!!" }] }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        await expect(
          tool.execute(
            {
              prompt: "A purple square.",
              output_path: outputPath,
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("Codex image generation returned invalid base64 image data.")
        expect(await Bun.file(outputPath).exists()).toBe(false)
      },
    })
  })

  test("execution-time missing Codex credentials produces the relogin guidance", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        await expect(
          tool.execute(
            {
              prompt: "A small test image.",
              output_path: "generated/missing-auth.png",
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("OpenAI Codex is not connected. Run synergy auth login and choose OpenAI Codex.")
      },
    })
  })
  test("request timeout constant is 600 seconds", async () => {
    expect(OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(600_000)
  })

  test("transient 500 response retries with backoff and succeeds on the second attempt", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    let fetchCalls = 0
    globalThis.fetch = asFetch(async (input) => {
      if (!String(input).includes("/images/")) return jsonResponse({ error: { message: "unrelated" } }, { status: 200 })
      fetchCalls++
      if (fetchCalls === 1) return jsonResponse({ error: { message: "boom" } }, { status: 500 })
      return jsonResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }] })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        const result = await tool.execute(
          {
            prompt: "A small star.",
            output_path: "generated/star.png",
            size: "auto",
            quality: "auto",
            background: "auto",
          },
          ctx,
        )
        expect(fetchCalls).toBe(2)
        expect(result.output).toContain("Generated image saved")
      },
    })
  })

  test("persistent 5xx fails after the configured number of attempts", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    let fetchCalls = 0
    globalThis.fetch = asFetch(async (input) => {
      // Count only the image-generation endpoint so concurrent tests in the
      // same shard (which share globalThis.fetch) cannot pollute the count.
      if (!String(input).includes("/images/")) return jsonResponse({ error: { message: "unrelated" } }, { status: 200 })
      fetchCalls++
      return jsonResponse({ error: { message: "boom" } }, { status: 500 })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        await expect(
          tool.execute(
            {
              prompt: "A small star.",
              output_path: "generated/star.png",
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("Codex image generation failed with status 500")
        expect(fetchCalls).toBe(3)
      },
    })
  }, 20_000)

  test("429 with retry-after retries after the indicated delay and succeeds", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    let imageCalls = 0
    globalThis.fetch = asFetch(async (input) => {
      if (String(input).includes("/images/")) imageCalls++
      if (imageCalls === 1) {
        return jsonResponse({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "1" } })
      }
      return jsonResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }] })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        const started = Date.now()
        const result = await tool.execute(
          {
            prompt: "A small moon.",
            output_path: "generated/moon.png",
            size: "auto",
            quality: "auto",
            background: "auto",
          },
          ctx,
        )
        expect(imageCalls).toBe(2)
        expect(Date.now() - started).toBeGreaterThanOrEqual(800)
        expect(result.output).toContain("Generated image saved")
      },
    })
  })
  test("429 with retry-after over the cap surfaces the rate limit without retrying", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    let imageCalls = 0
    globalThis.fetch = asFetch(async (input) => {
      if (String(input).includes("/images/")) imageCalls++
      return jsonResponse({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "31" } })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        const started = Date.now()
        await expect(
          tool.execute(
            {
              prompt: "A tiny probe image.",
              output_path: "generated/ratelimited.png",
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("Codex image generation is rate-limited or quota-limited. Retry after 31 seconds.")
        expect(imageCalls).toBe(1)
        expect(Date.now() - started).toBeLessThan(5_000)
      },
    })
  })

  test("transient network failure retries and succeeds on the second attempt", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    let fetchCalls = 0
    globalThis.fetch = asFetch(async (input) => {
      if (!String(input).includes("/images/")) return jsonResponse({ error: { message: "unrelated" } }, { status: 200 })
      fetchCalls++
      if (fetchCalls === 1) throw new TypeError("fetch failed")
      return jsonResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }] })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        const result = await tool.execute(
          {
            prompt: "A tiny sun.",
            output_path: "generated/sun.png",
            size: "auto",
            quality: "auto",
            background: "auto",
          },
          ctx,
        )
        expect(fetchCalls).toBe(2)
        expect(result.output).toContain("Generated image saved")
      },
    })
  })

  test("401 credential rejection does not retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    let imageCalls = 0
    globalThis.fetch = asFetch(async (input) => {
      if (String(input).includes("/images/")) imageCalls++
      return jsonResponse({ error: { message: "unauthorized" } }, { status: 401 })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        await expect(
          tool.execute(
            {
              prompt: "A small test image.",
              output_path: "generated/unauthorized.png",
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow()
        expect(imageCalls).toBe(1)
      },
    })
  })

  test("cancellation before execution aborts without sending a request", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    const controller = new AbortController()
    controller.abort()
    let fetchCalls = 0
    globalThis.fetch = asFetch(async () => {
      fetchCalls++
      return jsonResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }] })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageGenTool.init()
        await expect(
          tool.execute(
            {
              prompt: "A tiny square.",
              output_path: "generated/cancelled.png",
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            { ...ctx, abort: controller.signal },
          ),
        ).rejects.toThrow("Aborted")
        expect(fetchCalls).toBe(0)
      },
    })
  })
})
