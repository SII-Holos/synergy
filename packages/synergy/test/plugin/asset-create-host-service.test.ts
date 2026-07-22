import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { capability, compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import type { PluginInvocationContext } from "@ericsanchezok/synergy-plugin"
import type { MessageV2 } from "../../src/session/message-v2"
import { Asset } from "../../src/asset/asset"
import { Tool } from "../../src/tool/tool"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { deserializePluginRuntimeError, serializePluginRuntimeError } from "../../src/plugin-runtime/protocol"
import { tmpdir } from "../fixture/fixture"

type AssetCreateInput = {
  data: string
  encoding: "utf8" | "base64"
  mime: string
  filename?: string
}

type AssetCreateContext = PluginInvocationContext & {
  asset?: {
    create(input: AssetCreateInput): Promise<MessageV2.AttachmentPart>
  }
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'

function context(
  input: {
    capabilities?: string[]
    actor?: PluginInvocationContext["actor"]
    sessionId?: string
    invokeHost?: (method: string, params: unknown) => Promise<unknown>
  } = {},
): AssetCreateContext {
  return createPluginInvocationContext({
    requestId: "request-asset-create",
    runtime: {
      hostVersion: "test",
      pluginVersion: "1.0.0",
      pluginGeneration: "generation-one",
      protocolVersion: 6,
    },
    data: {
      scopeId: "scope-one",
      sessionId: input.sessionId ?? "session-one",
      directory: "/workspace",
      actor: input.actor ?? { type: "agent", agent: "synergy", messageId: "message-one", callId: "call-one" },
    },
    signal: AbortSignal.any([]),
    capabilities: new Set(input.capabilities ?? ["asset.write"]),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    async invokeHost(method, params) {
      return input.invokeHost?.(method, params)
    },
  }) as AssetCreateContext
}

async function assetFiles() {
  return (await fs.readdir(Asset.dir()).catch(() => [] as string[])).sort()
}

async function setupHostInvocation() {
  const tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const manifest = compilePluginManifest(
    definePlugin({
      id: "asset-create-test",
      version: "1.0.0",
      description: "Asset create Host Service test",
      capabilities: [capability("asset.write")],
      contributions: [],
    }),
    { generation: "generation-one" },
  )
  let sessionID = ""
  let messageID = ""
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const session = await Session.create({})
      sessionID = session.id
      messageID = `msg-${session.id}`
    },
  })

  return {
    tmp,
    scope,
    sessionID,
    messageID,
    manifest,
    invoke(
      params: Record<string, unknown>,
      overrides: {
        scopeId?: string
        sessionId?: string
        actor?: PluginInvocationContext["actor"]
      } = {},
    ) {
      return executePluginHostService({
        pluginId: manifest.id,
        pluginDir: tmp.path,
        manifest,
        invocation: {
          scopeId: overrides.scopeId ?? scope.id,
          sessionId: overrides.sessionId ?? sessionID,
          directory: tmp.path,
          actor:
            overrides.actor ?? ({ type: "agent", agent: "synergy", messageId: messageID, callId: "call-one" } as const),
        },
        method: "asset.create" as never,
        params,
        signal: AbortSignal.timeout(5_000),
      }) as Promise<MessageV2.AttachmentPart>
    },
  }
}

describe("plugin asset.create context", () => {
  test("is injected only for an approved agent tool invocation with message identity", () => {
    expect(context().asset?.create).toBeFunction()
    expect(context({ capabilities: [] }).asset).toBeUndefined()
    expect(context({ actor: { type: "ui" } }).asset).toBeUndefined()
    expect(context({ actor: { type: "lifecycle" } }).asset).toBeUndefined()
    expect(
      context({
        actor: { type: "agent", agent: "synergy", messageId: "message-one", callId: "call-one" },
        sessionId: "",
      }).asset,
    ).toBeUndefined()
  })

  test("sends only plugin-controlled content metadata in one Host call", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const input: AssetCreateInput = {
      data: svg,
      encoding: "utf8",
      mime: "image/svg+xml",
      filename: "diagram.svg",
    }
    const ctx = context({
      async invokeHost(method, params) {
        calls.push({ method, params })
        return { type: "attachment", url: "asset://host-owned.svg" }
      },
    })

    await ctx.asset!.create(input)

    expect(calls).toEqual([{ method: "asset.create", params: input }])
    expect(calls[0]?.params).not.toHaveProperty("sessionID")
    expect(calls[0]?.params).not.toHaveProperty("messageID")
    expect(calls[0]?.params).not.toHaveProperty("id")
    expect(calls[0]?.params).not.toHaveProperty("path")
    expect(calls[0]?.params).not.toHaveProperty("url")
  })
})

describe("plugin asset.create Host Service", () => {
  test("creates one message-bound SVG attachment whose bytes are readable from host storage", async () => {
    const host = await setupHostInvocation()
    try {
      const before = await assetFiles()
      const attachment = await host.invoke({
        data: svg,
        encoding: "utf8",
        mime: "image/svg+xml",
        filename: "diagram.svg",
        sessionID: "plugin-session",
        messageID: "plugin-message",
        id: "plugin-part",
        path: "/tmp/plugin-selected.svg",
        url: "https://plugin.invalid/selected.svg",
      })
      const after = await assetFiles()

      expect(attachment).toMatchObject({
        type: "attachment",
        sessionID: host.sessionID,
        messageID: host.messageID,
        mime: "image/svg+xml",
        filename: "diagram.svg",
        model: { mode: "summary" },
      })
      expect(attachment.id).toStartWith("part_")
      expect(attachment.sessionID).not.toBe("plugin-session")
      expect(attachment.messageID).not.toBe("plugin-message")
      expect(attachment.id).not.toBe("plugin-part")
      expect(attachment.url).not.toBe("https://plugin.invalid/selected.svg")
      expect(attachment.localPath).toBeUndefined()
      expect(attachment.url).toStartWith("asset://")
      expect(after.filter((file) => !before.includes(file))).toEqual([attachment.url.slice("asset://".length)])
      expect(await (await Asset.read(attachment.url.slice("asset://".length)))?.text()).toBe(svg)
      expect(() =>
        Tool.validateAttachmentResult("plugin__asset-create-test__render", {
          output: "Created diagram.svg",
          attachments: [attachment],
        }),
      ).not.toThrow()
    } finally {
      await Session.remove(host.sessionID).catch(() => {})
    }
  })

  test("stores Uint8Array data without string encoding", async () => {
    const host = await setupHostInvocation()
    try {
      const bytes = new Uint8Array([0, 1, 2, 127, 128, 255])
      const attachment = await host.invoke({ data: bytes, mime: "application/octet-stream", filename: "bytes.bin" })
      expect(await (await Asset.read(attachment.url.slice("asset://".length)))?.bytes()).toEqual(bytes)
    } finally {
      await Session.remove(host.sessionID).catch(() => {})
    }
  })

  test("rejects invalid base64 and oversized payloads before writing any asset", async () => {
    const host = await setupHostInvocation()
    try {
      const before = await assetFiles()

      await expect(
        host.invoke({ data: "%%%not-base64%%%", encoding: "base64", mime: "image/png", filename: "bad.png" }),
      ).rejects.toThrow(/base64/i)
      expect(await assetFiles()).toEqual(before)

      await expect(
        host.invoke({
          data: "x".repeat(10 * 1024 * 1024 + 1),
          encoding: "utf8",
          mime: "image/svg+xml",
          filename: "too-large.svg",
        }),
      ).rejects.toThrow(/large|size|limit|10.*mb/i)
      expect(await assetFiles()).toEqual(before)
    } finally {
      await Session.remove(host.sessionID).catch(() => {})
    }
  })

  test("rejects non-agent, missing-session, and cross-Scope invocation identity", async () => {
    const host = await setupHostInvocation()
    await using other = await tmpdir({ git: true })
    const otherScope = await other.scope()
    try {
      const params = { data: svg, encoding: "utf8", mime: "image/svg+xml", filename: "diagram.svg" }
      await expect(host.invoke(params, { actor: { type: "ui" } })).rejects.toThrow(/agent invocation/i)
      await expect(host.invoke(params, { sessionId: "" })).rejects.toThrow(/session|agent invocation/i)
      await expect(host.invoke(params, { scopeId: otherScope.id })).rejects.toThrow(/scope/i)
    } finally {
      await Session.remove(host.sessionID).catch(() => {})
    }
  })

  test("preserves Host Service errors across the runtime process boundary", async () => {
    const hostError = Object.assign(new Error("asset.create rejected malformed base64"), {
      name: "PluginHostServiceError",
      code: "PLUGIN_ASSET_INPUT_INVALID",
    })
    const restored = deserializePluginRuntimeError(serializePluginRuntimeError(hostError))
    const ctx = context({
      async invokeHost() {
        throw restored
      },
    })

    await expect(
      ctx.asset!.create({ data: "%%%", encoding: "base64", mime: "image/png", filename: "bad.png" }),
    ).rejects.toMatchObject({
      name: "PluginHostServiceError",
      code: "PLUGIN_ASSET_INPUT_INVALID",
      message: "asset.create rejected malformed base64",
    })
  })
})
