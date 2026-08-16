import { describe, expect, test } from "bun:test"
import { definePlugin } from "../src/index"
import "../src/auth-types"
import "../src/display"
import "../src/shell"
import "../src/theme/types"
import type { AuthHook, AuthImportResult, AuthOuathResult, AuthPrompt } from "../src/auth-types"
import type { ToolDisplay, ToolMediaDisplay } from "../src/display"
import type { BunShell, BunShellOutput, ShellExpression, ShellFunction } from "../src/shell"
import type {
  PluginComposerDocumentSnapshot,
  PluginComposerService,
  PluginMessageSurfaceContext,
  PluginSelectionService,
  PluginSurfaceContext,
  PluginToolMessageSurfaceContext,
} from "../src/ui"

function snapshot(): PluginComposerDocumentSnapshot {
  return { revision: 1, text: "", selection: { start: 0, end: 0 }, mode: "normal" }
}

function composerStub(): PluginComposerService {
  return {
    current: () => snapshot(),
    onDraftSettled: () => () => undefined,
    onBeforeSubmit: () => async () => undefined,
    setCompletion: () => undefined,
    setDecorations: () => undefined,
    applyEdits: async () => snapshot(),
  }
}

function selectionStub(): PluginSelectionService {
  return {
    current: () => undefined,
    onSettled: () => () => undefined,
  }
}

describe("public API surface contracts", () => {
  test("ToolDisplay and ToolMediaDisplay carry media-generation metadata", () => {
    const media: ToolMediaDisplay = { type: "image", aspectRatio: "16:9", size: "large" }
    const display: ToolDisplay = { kind: "media-generation", toolCard: "hidden", media }
    expect(display.media?.type).toBe("image")
    expect(display.toolCard).toBe("hidden")
  })

  test("AuthHook methods remain callable at runtime", async () => {
    const hook: AuthHook = {
      provider: "fixture",
      loader: async () => ({ loaded: true }),
      methods: [
        {
          type: "oauth",
          label: "OAuth",
          async authorize() {
            return {
              url: "https://example.com/authorize",
              instructions: "Approve",
              method: "code",
              async callback(code: string) {
                return code === "good" ? { type: "success", key: "k" } : { type: "failed" }
              },
            }
          },
        },
        {
          type: "api",
          label: "API",
          async authorize() {
            return { type: "success", key: "secret" }
          },
        },
        {
          type: "import",
          label: "Import",
          async import() {
            return { type: "success", refresh: "r", access: "a", expires: 1 }
          },
        },
      ],
    }

    const [oauth, api, importMethod] = hook.methods
    if (oauth?.type !== "oauth") throw new Error("Expected oauth method")
    if (api?.type !== "api") throw new Error("Expected api method")
    if (importMethod?.type !== "import") throw new Error("Expected import method")

    const result = await oauth.authorize()
    if (result.method !== "code") throw new Error("Expected code flow")
    expect(await result.callback("good")).toEqual({ type: "success", key: "k" })
    expect(await result.callback("bad")).toEqual({ type: "failed" })
    expect(await api.authorize?.()).toEqual({ type: "success", key: "secret" })
    expect(await importMethod.import()).toEqual({ type: "success", refresh: "r", access: "a", expires: 1 })
    expect(await hook.loader?.(async () => ({ providerID: "p" }) as never, {} as never)).toEqual({ loaded: true })
  })

  test("AuthPrompt predicates run against collected inputs", () => {
    const prompt: AuthPrompt = {
      type: "text",
      key: "token",
      message: "Token",
      validate: (value) => (value.length < 3 ? "too short" : undefined),
      condition: (inputs) => Boolean(inputs.advanced),
    }
    expect(prompt.validate?.("ab")).toBe("too short")
    expect(prompt.validate?.("abc")).toBeUndefined()
    expect(prompt.condition?.({ advanced: "1" })).toBe(true)
    expect(prompt.condition?.({})).toBe(false)

    const select: AuthPrompt = {
      type: "select",
      key: "region",
      message: "Region",
      options: [
        { label: "US", value: "us", hint: "North America" },
        { label: "EU", value: "eu" },
      ],
    }
    expect(select.type).toBe("select")
  })

  test("AuthImportResult and AuthOuathResult unions stay structurally intact", () => {
    const imported: AuthImportResult = { type: "success", key: "k", provider: "p" }
    const failed: AuthImportResult = { type: "failed", message: "no" }
    const oauth: AuthOuathResult = {
      url: "https://example.com",
      instructions: "continue",
      method: "auto",
      async callback() {
        return { type: "success", refresh: "r", access: "a", expires: 1 }
      },
    }
    expect(imported.type).toBe("success")
    expect(failed.type).toBe("failed")
    expect(oauth.method).toBe("auto")
  })

  test("ShellExpression accepts strings, raw fragments, objects, and streams", () => {
    const expressions: ShellExpression[] = [
      "echo hi",
      { raw: "piped" },
      new ReadableStream(),
      { toString: () => "obj" },
    ]
    expect(expressions).toHaveLength(4)
    const pipeline: ShellFunction = (input) => input
    expect(pipeline(new Uint8Array([1]))).toEqual(new Uint8Array([1]))
  })

  test("BunShell interfaces expose the documented fluent chain", () => {
    const chain = {
      braces: (pattern: string) => (pattern === "{a,b}" ? ["a", "b"] : [pattern]),
      escape: (input: string) => `'${input}'`,
      env: () => chain,
      cwd: () => chain,
      nothrow: () => chain,
      throws: () => chain,
    }
    const shell: BunShell = chain as never
    expect(shell.braces("{a,b}")).toEqual(["a", "b"])
    expect(shell.escape("a b")).toBe("'a b'")
    expect(shell.env({ HOME: "/tmp" })).toBe(shell)
    expect(shell.cwd("/tmp")).toBe(shell)
    expect(shell.nothrow()).toBe(shell)
    expect(shell.throws(false)).toBe(shell)
    const output = {} as BunShellOutput
    expect(output.text?.("utf8")).toBeUndefined()
    expect(output.json?.()).toBeUndefined()
    expect(output.bytes?.()).toBeUndefined()
    expect(output.blob?.()).toBeUndefined()
    expect(output.arrayBuffer?.()).toBeUndefined()
  })

  test("composer and selection services keep their contract methods", () => {
    const composer = composerStub()
    const selection = selectionStub()
    expect(composer.current().revision).toBe(1)
    expect(composer.onDraftSettled(async () => undefined)).toBeTypeOf("function")
    expect(composer.onBeforeSubmit(async () => undefined)).toBeTypeOf("function")
    composer.setCompletion({ revision: 1, position: 0, text: "hint" })
    composer.setDecorations({ revision: 1, items: [] })
    expect(selection.current()).toBeUndefined()
    expect(selection.onSettled(() => undefined)).toBeTypeOf("function")
  })

  test("message and tool surface contexts compose PluginSurfaceContext", () => {
    const base: PluginSurfaceContext = {
      pluginId: "p",
      scopeId: "s",
      surface: { kind: "tool", id: "t" },
      operations: {
        query: async <Output = unknown>(id: string, input?: unknown): Promise<Output> =>
          (input === undefined ? id : `${id}:${String(input)}`) as Output,
        command: async <Output = unknown>(id: string, input?: unknown): Promise<Output> =>
          (input === undefined ? id : `${id}:${String(input)}`) as Output,
      },
      events: { subscribe: () => () => undefined },
      settings: {
        get: async () => ({}),
        replace: async () => undefined,
        subscribe: () => () => undefined,
      },
      host: {
        openSession: () => undefined,
        openPluginPage: () => undefined,
        openWorkbenchPanel: () => undefined,
        openResource: () => undefined,
        notify: () => undefined,
        confirm: async () => true,
      },
    }

    base.host.openSession("s")
    base.host.openPluginPage("settings", { tab: "general" })
    base.host.openWorkbenchPanel("panel")
    base.host.openResource({ kind: "file", uri: "file:///tmp/a.txt" })
    base.host.notify("done", { kind: "success" })
    expect(base.operations.query<string>("op.id")).resolves.toBe("op.id")
    expect(base.settings.get()).resolves.toEqual({})

    const message: PluginMessageSurfaceContext = { ...base, message: { id: "m", role: "assistant" } }
    expect(message.message.role).toBe("assistant")

    const tool: PluginToolMessageSurfaceContext = {
      ...message,
      tool: { name: "inspect", input: { q: 1 }, metadata: {} },
    }
    expect(tool.tool.name).toBe("inspect")
  })

  test("descriptor compilation accepts handlers typed against the surface contracts", () => {
    const plugin = definePlugin({
      id: "surface-fixture",
      version: "1.0.0",
      description: "Surface contract fixture",
      contributions: [],
    })
    expect(plugin.id).toBe("surface-fixture")
  })
})
