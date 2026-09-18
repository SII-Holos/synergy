import { afterEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { messages as enMessages } from "../../../../src/locales/en/messages.mjs"
import { messages as zhMessages } from "../../../../src/locales/zh-CN/messages.mjs"

// The panel's TSX must be compiled with Solid's DOM runtime; Bun's own test
// transform emits React.createElement. Same loader trick as StoragePanel.test.ts,
// and this file is registered under `browserOnly` so `solid-js/web` resolves to
// the client build.
await plugin({
  name: "mcp-panel-render-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (await transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          [import.meta.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
        ],
        sourceMaps: "inline",
      }))!.code!,
      loader: "js",
    }))
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})

// Real compiled catalogs, so the assertions are about the copy a user reads
// rather than about descriptor ids. Switching the active locale between tests
// exercises the same runtime the app uses.
const i18n = setupI18n()
i18n.load("en", enMessages)
i18n.load("zh-CN", zhMessages)
i18n.activate("en")

mock.module("@lingui/solid", () => ({
  useLingui: () => ({ _: i18n._.bind(i18n), i18n }),
}))

const { McpPanel } = await import("../../../../src/components/settings/panels/McpPanel")
const { McpCard } = await import("../../../../src/components/settings/components/McpCard")

const builtin = (overrides: Record<string, unknown> = {}) =>
  ({
    name: "anysearch",
    url: "https://api.anysearch.com/mcp",
    status: { status: "uninitialized" },
    keyConfigured: false,
    toggle: true,
    apiKeyDraft: "",
    clearApiKey: false,
    ...overrides,
  }) as never

const mcpEntry = (overrides: Record<string, unknown> = {}) =>
  ({
    key: "notion",
    type: "remote",
    enabled: true,
    expandByDefault: false,
    command: "",
    url: "https://mcp.notion.com/mcp",
    timeout: "",
    environment: "",
    headers: "",
    ...overrides,
  }) as never

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length) disposers.pop()!()
  i18n.activate("en")
})

function mountPanel(builtins: unknown[], statuses?: Record<string, unknown>) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  disposers.push(
    render(
      () =>
        createComponent(McpPanel, {
          entries: [],
          builtins: builtins as never,
          statuses: statuses as never,
          onAdd: () => {},
          onChange: () => {},
          onRemove: () => {},
          onBuiltinToggle: () => {},
          onBuiltinApiKeyChange: () => {},
          onBuiltinClearKey: () => {},
        }),
      host,
    ),
  )
  return host
}

function mountCard(entry: unknown, status?: unknown) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  disposers.push(
    render(
      () =>
        createComponent(McpCard, {
          entry: entry as never,
          status: status as never,
          onChange: () => {},
          onRemove: () => {},
        }),
      host,
    ),
  )
  return host
}

const stateLabel = (host: HTMLElement) => host.querySelector(".settings-mcp-state")?.textContent?.trim()
const chipLabel = (host: HTMLElement) => host.querySelector(".settings-mcp-key-chip")?.textContent?.trim()
const errorLine = (host: HTMLElement) => host.querySelector(".settings-mcp-card-error")?.textContent?.trim()
const switchChecked = (host: HTMLElement) => {
  const input = host.querySelector<HTMLInputElement>('[data-slot="switch-input"]')
  return input?.checked
}

describe("rendered built-in MCP status copy", () => {
  test("a switch-on built-in that is not connected yet reads as ready, never as unavailable", () => {
    const host = mountPanel([builtin()])

    expect(stateLabel(host)).toBe("Ready")
    expect(stateLabel(host)).not.toBe("Unavailable")
    // The contradiction this fixes: the switch is on, so the label must not
    // claim the server is unavailable.
    expect(switchChecked(host)).toBe(true)
  })

  test("the Simplified Chinese result is 就绪, not 不可用", () => {
    i18n.activate("zh-CN")
    const host = mountPanel([builtin()])

    expect(stateLabel(host)).toBe("就绪")
    expect(stateLabel(host)).not.toBe("不可用")
  })

  test("a connected built-in reads as connected", () => {
    const host = mountPanel([builtin({ status: { status: "connected" } })])

    expect(stateLabel(host)).toBe("Connected")
  })

  test("a failed built-in reads as failed and shows its error detail line", () => {
    const host = mountPanel([builtin({ status: { status: "failed", error: "connect ECONNREFUSED 127.0.0.1:9" } })])

    expect(stateLabel(host)).toBe("Failed")
    expect(errorLine(host)).toBe("connect ECONNREFUSED 127.0.0.1:9")
  })

  test("a failed built-in in Simplified Chinese reads 失败 with its error", () => {
    i18n.activate("zh-CN")
    const host = mountPanel([builtin({ status: { status: "failed", error: "连接被拒绝" } })])

    expect(stateLabel(host)).toBe("失败")
    expect(errorLine(host)).toBe("连接被拒绝")
  })

  test("a needs-auth built-in reads as needing auth", () => {
    const host = mountPanel([builtin({ status: { status: "needs_auth", error: "401 unauthorized" } })])

    expect(stateLabel(host)).toBe("Needs auth")
  })

  test("a disabled built-in reads as disabled with the switch off", () => {
    const host = mountPanel([builtin({ status: { status: "disabled" }, toggle: false })])

    expect(stateLabel(host)).toBe("Disabled")
    expect(switchChecked(host)).toBe(false)
  })

  test("the live status wins over the stale catalog snapshot", () => {
    const host = mountPanel([builtin()], { anysearch: { status: "connected" } })

    expect(stateLabel(host)).toBe("Connected")
  })
})

describe("rendered built-in MCP key feedback", () => {
  test("a stored key persistently shows the masked-hint chip and a replacement prompt", () => {
    const host = mountPanel([builtin({ keyConfigured: true, keyHint: "••••9876" })])

    expect(chipLabel(host)).toBe("Key saved ••••9876")
    // Scope to the key field: the card also renders a switch input.
    expect(host.querySelector(".settings-mcp-builtin-key input")?.getAttribute("placeholder")).toBe(
      "Paste a new key to replace the saved one",
    )
  })

  test("a typed-but-unsaved key shows the pending chip", () => {
    const host = mountPanel([builtin({ keyConfigured: true, keyHint: "••••9876", apiKeyDraft: "as_sk_new" })])

    expect(chipLabel(host)).toBe("Not saved yet")
  })

  test("a cleared key returns to the unset chip", () => {
    const host = mountPanel([builtin({ keyConfigured: false })])

    expect(chipLabel(host)).toBe("No key set")
  })

  test("a stored key without a hint still reads as saved", () => {
    const host = mountPanel([builtin({ keyConfigured: true })])

    expect(chipLabel(host)).toBe("Key saved")
  })

  test("the Simplified Chinese chips are the translated ones", () => {
    i18n.activate("zh-CN")
    const host = mountPanel([builtin({ keyConfigured: true, keyHint: "••••9876" })])

    expect(chipLabel(host)).toBe("已设置密钥 ••••9876")
  })
})

describe("rendered custom MCP server status", () => {
  test("an enabled custom server reports its real connection status, not a bare Enabled", () => {
    const host = mountCard(mcpEntry(), { status: "connecting" })

    expect(stateLabel(host)).toBe("Connecting")
    expect(stateLabel(host)).not.toBe("Enabled")
  })

  test("a paused custom server reads as paused rather than claiming a connection", () => {
    const host = mountCard(mcpEntry({ enabled: false }), { status: "connected" })

    expect(stateLabel(host)).toBe("Paused")
  })

  test("an enabled custom server with no known status reads as not-yet-connected, not failed", () => {
    const host = mountCard(mcpEntry())

    expect(stateLabel(host)).toBe("Ready")
    expect(stateLabel(host)).not.toBe("Failed")
  })
})
