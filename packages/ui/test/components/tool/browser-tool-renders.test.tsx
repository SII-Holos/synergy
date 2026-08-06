import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

const registrations = new Map<string, (props: Record<string, any>) => unknown>()
let capturedTrigger: Record<string, unknown> | undefined
let capturedRows: Array<{ label: string; value?: unknown } | undefined> = []
let capturedOutput: string | undefined
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function") return type({ ...(props ?? {}), children })
    return null
  },
}

beforeAll(async () => {
  mock.module("@lingui/solid", () => ({
    useLingui: () => ({
      _: (descriptor: { message?: string; id: string; values?: Record<string, unknown> }) => {
        let message = descriptor.message ?? descriptor.id
        for (const [key, value] of Object.entries(descriptor.values ?? {})) {
          message = message.replaceAll(`{${key}}`, String(value))
          message = message.replace(
            new RegExp(`\\{${key}, plural, one \\{# ([^}]+)\\} other \\{# ([^}]+)\\}\\}`),
            (_match, one, other) => `${value} ${Number(value) === 1 ? one : other}`,
          )
        }
        return message
      },
    }),
  }))
  mock.module("../../../src/components/basic-tool", () => ({
    BasicTool: (props: { trigger: Record<string, unknown>; children?: unknown }) => {
      capturedTrigger = props.trigger
      return null
    },
  }))
  mock.module("../../../src/components/message-part", () => ({
    browserToolLabels: {
      browser_navigation: { icon: "route", title: { id: "browser.title.navigation", message: "Navigate web" } },
      browser_snapshot: {
        icon: "binoculars",
        title: { id: "browser.title.snapshot", message: "Capture page snapshot" },
      },
      browser_action: { icon: "mouse-pointer-click", title: { id: "browser.title.action", message: "Operate page" } },
      browser_wait: { icon: "hourglass", title: { id: "browser.title.wait", message: "Wait for page" } },
      browser_read: { icon: "glasses", title: { id: "browser.title.read", message: "Read page" } },
      browser_inspect: { icon: "scan-eye", title: "Inspect page" },
      browser_screenshot: { icon: "image", title: "Capture screenshot" },
      browser_eval: { icon: "braces", title: "Evaluate page script" },
      browser_console: { icon: "file-terminal", title: "Inspect console" },
      browser_network: { icon: "network", title: "Inspect network requests" },
      browser_performance: { icon: "gauge", title: "Analyze page performance" },
      browser_audit: { icon: "shield-check", title: "Audit page" },
      browser_emulate: { icon: "sliders-horizontal", title: "Emulate device" },
      browser_dialog: { icon: "message-square-more", title: "Handle page dialog" },
      browser_upload: { icon: "upload", title: "Upload file" },
      browser_downloads: { icon: "download-cloud", title: "Inspect downloads" },
      browser_clipboard: { icon: "clipboard-list", title: "Read or write clipboard" },
      browser_assets: { icon: "package", title: "Inspect page assets" },
      browser_annotate: { icon: "square-pen", title: "Annotate page" },
      browser_view: { icon: "panel-right", title: "View browser" },
    },
    ToolRegistry: {
      register: (entry: { name: string; render: (props: Record<string, any>) => unknown }) => {
        registrations.set(entry.name, entry.render)
      },
    },
  }))
  mock.module("../../../src/components/tool/body-primitives", () => ({
    shortText: (value: unknown, max = 42) => {
      if (typeof value !== "string") return undefined
      const trimmed = value.trim()
      if (!trimmed) return undefined
      return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
    },
    SummaryGrid: (props: { rows: Array<{ label: string; value?: unknown } | undefined> }) => {
      capturedRows = props.rows
      return null
    },
    RawOutput: (props: { output?: string }) => {
      capturedOutput = props.output
      return null
    },
  }))

  await import("../../../src/components/tool/renders/browser" + "?browser-tool-renders")
})

function render(name: string, props: Record<string, any>) {
  registrations.get(name)?.({ tool: name, ...props })
}

beforeEach(() => {
  capturedTrigger = undefined
  capturedRows = []
  capturedOutput = undefined
})

describe("Browser tool renderers", () => {
  test("registers every browser tool label", () => {
    expect([...registrations.keys()].toSorted()).toEqual([
      "browser_action",
      "browser_annotate",
      "browser_assets",
      "browser_audit",
      "browser_clipboard",
      "browser_console",
      "browser_dialog",
      "browser_downloads",
      "browser_emulate",
      "browser_eval",
      "browser_inspect",
      "browser_navigation",
      "browser_network",
      "browser_performance",
      "browser_read",
      "browser_screenshot",
      "browser_snapshot",
      "browser_upload",
      "browser_view",
      "browser_wait",
    ])
  })

  test("summarizes browser actions without exposing typed values", () => {
    render("browser_action", {
      input: {
        action: {
          type: "fill",
          target: { kind: "role", role: "textbox", name: "Email address" },
          value: "secret@example.com",
        },
      },
      metadata: {
        actionType: "fill",
        target: { kind: "role", role: "textbox", name: "Email address" },
        valueLength: 18,
        settled: true,
        settleReason: "networkquiet",
        settleElapsedMs: 840,
        url: "https://mail.example.com/compose?draft=long-value",
        title: "Compose message",
        isLoading: false,
        elementsCount: 42,
      },
      output: "Filled the email field.",
    })

    expect(capturedTrigger).toEqual({
      icon: "mouse-pointer-click",
      title: { id: "browser.title.action", message: "Operate page" },
      subtitle: "fill · Email address",
      tags: [{ label: "fill" }, { label: "settled", tone: "success" }, { label: "42 elements" }],
    })
    expect(capturedRows).toEqual([
      { label: "Target", value: "textbox · Email address" },
      { label: "URL", value: "https://mail.example.com/compose?draft=lo…" },
      { label: "Title", value: "Compose message" },
      { label: "Settle time", value: "840 ms" },
      { label: "Settle reason", value: "networkquiet" },
      { label: "Value length", value: "18" },
      { label: "Elements", value: "42" },
    ])
    expect(JSON.stringify({ trigger: capturedTrigger, rows: capturedRows })).not.toContain("secret@example.com")
    expect(capturedOutput).toBe("Filled the email field.")
  })

  test("summarizes navigation state and loading", () => {
    render("browser_navigation", {
      input: { action: "goto", url: "https://mail.163.com/js6/main.jsp?sid=very-long-session-token" },
      metadata: {
        action: "goto",
        url: "https://mail.163.com/js6/main.jsp?sid=very-long-session-token",
        title: "163 Mail",
        isLoading: true,
        settled: false,
        settleReason: "timeout",
        settleElapsedMs: 30_000,
      },
      output: "Navigation started.",
    })

    expect(capturedTrigger).toEqual({
      icon: "route",
      title: { id: "browser.title.navigation", message: "Navigate web" },
      subtitle: "goto · https://mail.163.com/js6/main.jsp?sid=ver…",
      tags: [
        { label: "goto" },
        { label: "unsettled", tone: "warning" },
        { label: "loading" },
        { label: "timeout", tone: "warning" },
      ],
    })
    expect(capturedRows).toEqual([
      { label: "URL", value: "https://mail.163.com/js6/main.jsp?sid=ver…" },
      { label: "Title", value: "163 Mail" },
      { label: "Settle time", value: "30000 ms" },
      { label: "Settle reason", value: "timeout" },
    ])
  })

  test("summarizes wait conditions and timeout without object stringification", () => {
    render("browser_wait", {
      input: { condition: { type: "text", values: ["保存成功"], match: "all" }, timeoutMs: 10_000 },
      metadata: {
        condition: { type: "text", values: ["保存成功"], match: "all" },
        timeoutMs: 10_000,
        matched: false,
        elapsedMs: 10_000,
        url: "https://example.com/editor",
        title: "Editor",
        isLoading: false,
      },
      output: "Timed out waiting for text.",
    })

    expect(capturedTrigger).toEqual({
      icon: "hourglass",
      title: { id: "browser.title.wait", message: "Wait for page" },
      subtitle: 'wait · text "保存成功"',
      tags: [{ label: "text" }, { label: "unsettled", tone: "warning" }, { label: "timeout", tone: "warning" }],
    })
    expect(capturedRows).toEqual([
      { label: "Condition", value: 'text "保存成功"' },
      { label: "Timeout", value: "10000 ms" },
      { label: "Elapsed", value: "10000 ms" },
      { label: "URL", value: "https://example.com/editor" },
      { label: "Title", value: "Editor" },
    ])
    expect(JSON.stringify({ trigger: capturedTrigger, rows: capturedRows })).not.toContain("[object Object]")
  })

  test("summarizes snapshot element counts", () => {
    render("browser_snapshot", {
      input: {},
      metadata: {
        pageId: "page-1",
        url: "https://example.com/inbox",
        snapshotId: "snapshot-1",
        elementsCount: 42,
        truncated: true,
        outputTruncated: false,
      },
      output: "Snapshot output",
    })

    expect(capturedTrigger).toEqual({
      icon: "binoculars",
      title: { id: "browser.title.snapshot", message: "Capture page snapshot" },
      subtitle: "snapshot · 42 elements",
      tags: [{ label: "42 elements" }],
    })
    expect(capturedRows).toEqual([
      { label: "URL", value: "https://example.com/inbox" },
      { label: "Elements", value: "42" },
    ])
  })

  test("keeps generic browser tools useful without rendering nested objects", () => {
    render("browser_read", {
      input: { action: { type: "text", target: { kind: "role", name: "Inbox" } } },
      metadata: { url: "https://example.com/inbox", entryCount: 3, captureKind: { kind: "accessibility" } },
      output: "Page text",
    })

    expect(capturedTrigger).toEqual({
      icon: "glasses",
      title: { id: "browser.title.read", message: "Read page" },
      subtitle: "https://example.com/inbox",
      tags: [{ label: "3 console" }],
    })
    expect(JSON.stringify(capturedTrigger)).not.toContain("[object Object]")
    expect(capturedOutput).toBe("Page text")
  })
})
