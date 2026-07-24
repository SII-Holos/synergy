import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Asset } from "../../src/asset/asset"
import { Auth } from "../../src/provider/api-key"
import { CodexProvider } from "../../src/provider/codex"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { OpenAIImageEditTool } from "../../src/tool/openai-image-edit"
import { openAIImageEditDisplay } from "../../src/tool/openai-image-shared"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
)
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary"),
  Buffer.from([0x56, 0x50, 0x38, 0x20]),
])

const originalFetch = globalThis.fetch
const originalCodexBaseURL = process.env.SYNERGY_CODEX_BASE_URL

const ctx = {
  sessionID: "ses_image_edit_test",
  messageID: "msg_image_edit_test",
  callID: "call_image_edit_test",
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
      chatgpt_account_id: input?.accountID ?? "acct_image_edit_test",
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

async function writeFixture(filepath: string, content: string | Buffer) {
  await Bun.write(filepath, content, { createPath: true })
}

async function connectCodex() {
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: accessToken(),
    refresh: "refresh-image-edit-test",
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

describe("tool.openai_image_edit", () => {
  test("is registered with generation when OpenAI Codex OAuth credentials are available", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await ToolRegistry.ids()).not.toContain("openai_image_edit")

        await connectCodex()
        await ToolRegistry.reload()
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("openai_image_gen")
        expect(ids).toContain("openai_image_edit")

        await Auth.markDead(CodexProvider.PROVIDER_ID, "invalid_grant")
        await ToolRegistry.reload()
        expect(await ToolRegistry.ids()).not.toContain("openai_image_edit")
      },
    })
  })

  test("successful edit sends data URL inputs, writes PNG output, stores an asset attachment, and returns metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    process.env.SYNERGY_CODEX_BASE_URL = "https://codex.test/backend-api/codex"
    const inputPath = path.join(tmp.path, "inputs", "source.png")
    const outputPath = path.join(tmp.path, "edited", "source-remix.png")
    await writeFixture(inputPath, PNG_BYTES)
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    globalThis.fetch = asFetch(async (input, init) => {
      captured = { input, init }
      return jsonResponse({
        created: 456,
        background: "opaque",
        data: [{ b64_json: PNG_BYTES.toString("base64") }],
        output_format: "png",
        quality: "high",
        size: "1024x1024",
        usage: { total_tokens: 20 },
      })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageEditTool.init()
        const result = await tool.execute(
          {
            prompt: "Preserve the object shape, recolor it warm amber, no text, no watermark.",
            input_paths: [inputPath],
            output_path: outputPath,
            size: "1024x1024",
            quality: "high",
            background: "opaque",
          },
          ctx,
        )

        expect(String(captured?.input)).toBe("https://codex.test/backend-api/codex/images/edits")
        const body = JSON.parse(String(captured?.init?.body))
        expect(body.prompt).toBe("Preserve the object shape, recolor it warm amber, no text, no watermark.")
        expect(body.background).toBe("opaque")
        expect(body.model).toBe("gpt-image-2")
        expect(body.quality).toBe("high")
        expect(body.size).toBe("1024x1024")
        expect(body.images).toHaveLength(1)
        expect(body.images[0]).toEqual({ image_url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` })
        const headers = new Headers(captured?.init?.headers)
        expect(headers.get("authorization")).toStartWith("Bearer ")
        expect(headers.get("chatgpt-account-id")).toBe("acct_image_edit_test")

        expect(Buffer.from(await Bun.file(outputPath).arrayBuffer())).toEqual(PNG_BYTES)
        expect(result.title).toBe("source-remix.png")
        expect(result.output).toBe(`Edited image saved to ${outputPath} (${PNG_BYTES.length} B).`)
        expect(result.output).not.toContain(PNG_BYTES.toString("base64"))
        expect(result.metadata).toMatchObject({
          prompt: "Preserve the object shape, recolor it warm amber, no text, no watermark.",
          model: "gpt-image-2",
          outputPath,
          inputImages: [{ path: inputPath, mime: "image/png", bytes: PNG_BYTES.length }],
          requested: { size: "1024x1024", quality: "high", background: "opaque" },
          response: {
            created: 456,
            size: "1024x1024",
            quality: "high",
            background: "opaque",
            outputFormat: "png",
            usage: { total_tokens: 20 },
          },
          bytes: PNG_BYTES.length,
          display: openAIImageEditDisplay,
          truncated: false,
        })

        const attachment = result.attachments?.[0]
        expect(attachment).toBeDefined()
        expect(attachment?.sessionID).toBe(ctx.sessionID)
        expect(attachment?.messageID).toBe(ctx.messageID)
        expect(attachment?.mime).toBe("image/png")
        expect(attachment?.filename).toBe("source-remix.png")
        expect(attachment?.url).toStartWith("asset://")
        expect(attachment?.url).not.toStartWith("data:")
        expect(attachment?.localPath).toBe(outputPath)
        expect(attachment?.presentation).toEqual({ renderer: "image", size: "medium", crop: false })
        expect(attachment?.model).toEqual({
          mode: "provider-file",
          summary: `Edited image saved to ${outputPath}`,
        })

        const assetID = attachment!.url.slice("asset://".length)
        const asset = await Asset.read(assetID)
        expect(asset).toBeDefined()
        expect(Buffer.from(await asset!.arrayBuffer())).toEqual(PNG_BYTES)
      },
    })
  })

  test("relative input_paths and output_path resolve under the current workspace and support JPEG/WebP inputs", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    await writeFixture(path.join(tmp.path, "inputs", "photo.jpg"), JPEG_BYTES)
    await writeFixture(path.join(tmp.path, "inputs", "texture.webp"), WEBP_BYTES)
    let body: any
    globalThis.fetch = asFetch(async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return jsonResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }], output_format: "png" })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageEditTool.init()
        const result = await tool.execute(
          {
            prompt: "Combine these into one warm product image, no text.",
            input_paths: ["inputs/photo.jpg", "inputs/texture.webp"],
            output_path: "outputs/combined.png",
            size: "auto",
            quality: "auto",
            background: "auto",
          },
          ctx,
        )

        expect(body.images).toEqual([
          { image_url: `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}` },
          { image_url: `data:image/webp;base64,${WEBP_BYTES.toString("base64")}` },
        ])
        const resolvedOutput = path.join(tmp.path, "outputs", "combined.png")
        expect(Buffer.from(await Bun.file(resolvedOutput).arrayBuffer())).toEqual(PNG_BYTES)
        expect(result.metadata.outputPath).toBe(resolvedOutput)
        expect(result.metadata.inputImages).toEqual([
          { path: path.join(tmp.path, "inputs", "photo.jpg"), mime: "image/jpeg", bytes: JPEG_BYTES.length },
          { path: path.join(tmp.path, "inputs", "texture.webp"), mime: "image/webp", bytes: WEBP_BYTES.length },
        ])
      },
    })
  })

  test("invalid input image content rejects before making a network call", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    await writeFixture(path.join(tmp.path, "inputs", "fake.png"), "not a png")
    let fetchCalls = 0
    globalThis.fetch = asFetch(async () => {
      fetchCalls++
      return jsonResponse({})
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageEditTool.init()
        await expect(
          tool.execute(
            {
              prompt: "Fix this image.",
              input_paths: ["inputs/fake.png"],
              output_path: "outputs/fixed.png",
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("fake.png: file content does not match image/png.")
        expect(fetchCalls).toBe(0)
      },
    })
  })

  test("unsupported input image extension rejects before making a network call", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    await writeFixture(path.join(tmp.path, "inputs", "notes.txt"), "hello")
    let fetchCalls = 0
    globalThis.fetch = asFetch(async () => {
      fetchCalls++
      return jsonResponse({})
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageEditTool.init()
        await expect(
          tool.execute(
            {
              prompt: "Edit this image.",
              input_paths: ["inputs/notes.txt"],
              output_path: "outputs/fixed.png",
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("notes.txt: text/plain is not a supported image input. Use PNG, JPEG, or WebP.")
        expect(fetchCalls).toBe(0)
      },
    })
  })

  test("empty input_paths rejects before making a network call", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    let fetchCalls = 0
    globalThis.fetch = asFetch(async () => {
      fetchCalls++
      return jsonResponse({})
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageEditTool.init()
        await expect(
          tool.execute(
            {
              prompt: "Edit this image.",
              input_paths: [],
              output_path: "outputs/fixed.png",
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("The openai_image_edit tool was called with invalid arguments")
        expect(fetchCalls).toBe(0)
      },
    })
  })

  test("non-2xx provider errors are concise and do not leak tokens or base64 payloads", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    await writeFixture(path.join(tmp.path, "inputs", "source.png"), PNG_BYTES)
    const token = accessToken()
    const imageData = PNG_BYTES.toString("base64").repeat(4)
    const quotedImageData = `"${imageData}"`
    globalThis.fetch = asFetch(async () =>
      jsonResponse(
        {
          error: {
            message: `request failed token ${token} image ${imageData} quoted ${quotedImageData}`,
          },
        },
        { status: 500 },
      ),
    )

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageEditTool.init()
        let thrown: unknown
        try {
          await tool.execute(
            {
              prompt: "Edit this image.",
              input_paths: ["inputs/source.png"],
              output_path: "outputs/fixed.png",
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
        expect(message).toContain("Codex image edit failed with status 500")
        expect(message).toContain("[redacted token]")
        expect(message).toContain("[redacted image data]")
        expect(message).not.toContain(token)
        expect(message).not.toContain(imageData.slice(0, 80))
      },
    })
  })

  test("missing image data rejects without writing output", async () => {
    await using tmp = await tmpdir({ git: true })
    await connectCodex()
    await writeFixture(path.join(tmp.path, "inputs", "source.png"), PNG_BYTES)
    const outputPath = path.join(tmp.path, "outputs", "missing.png")
    globalThis.fetch = asFetch(async () => jsonResponse({ data: [{}] }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageEditTool.init()
        await expect(
          tool.execute(
            {
              prompt: "Edit this image.",
              input_paths: ["inputs/source.png"],
              output_path: outputPath,
              size: "auto",
              quality: "auto",
              background: "auto",
            },
            ctx,
          ),
        ).rejects.toThrow("Codex image edit response did not include image data.")
        expect(await Bun.file(outputPath).exists()).toBe(false)
      },
    })
  })

  test("execution-time missing Codex credentials produces the relogin guidance", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFixture(path.join(tmp.path, "inputs", "source.png"), PNG_BYTES)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await OpenAIImageEditTool.init()
        await expect(
          tool.execute(
            {
              prompt: "Edit this image.",
              input_paths: ["inputs/source.png"],
              output_path: "outputs/missing-auth.png",
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
})
