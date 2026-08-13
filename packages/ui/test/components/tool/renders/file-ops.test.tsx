import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { TOOL_TITLE_DESC } from "../../../../src/components/tool-title-descriptors"

const registrations = new Map<string, (props: Record<string, any>) => unknown>()
let capturedTrigger: Record<string, unknown> | undefined
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
        }
        return message
      },
    }),
  }))
  mock.module("solid-js", () => ({
    createMemo: (fn: () => unknown) => fn,
    For: () => null,
    Show: () => null,
  }))
  mock.module("solid-js/web", () => ({ Dynamic: () => null }))
  mock.module("../../../../src/components/basic-tool", () => ({
    BasicTool: (props: { trigger: Record<string, unknown> }) => {
      capturedTrigger = props.trigger
      return null
    },
    SmartTool: () => null,
  }))
  mock.module("../../../../src/components/message-part", () => ({
    ToolRegistry: {
      register: (entry: { name: string; render: (props: Record<string, any>) => unknown }) => {
        registrations.set(entry.name, entry.render)
      },
    },
    getDiagnostics: () => [],
    DiagnosticsDisplay: () => null,
    getDirectory: (path: string) => path,
  }))
  mock.module("../../../../src/context/code", () => ({ useCodeComponent: () => () => null }))
  mock.module("../../../../src/components/tool-output-text", () => ({ ToolTextOutput: () => null }))
  mock.module("../../../../src/components/tool/diff-preview", () => ({ ToolDiffPreview: () => null }))
  mock.module("../../../../src/components/diff-patch", () => ({
    DiffPatchGate: () => null,
  }))
  mock.module("../../../../src/components/tool/save-file-preview", () => ({
    hasSaveFileContentInput: () => false,
    saveFilePreviewDiff: () => undefined,
  }))

  await import("../../../../src/components/tool/renders/file-ops")
})

function renderResolveConflicts(props: Record<string, any>) {
  registrations.get("resolve_conflicts")?.({ tool: "resolve_conflicts", ...props })
  return capturedTrigger
}

beforeEach(() => {
  capturedTrigger = undefined
})

describe("resolve_conflicts file-ops renderer", () => {
  test("registers a renderer for resolve_conflicts", () => {
    expect(registrations.has("resolve_conflicts")).toBe(true)
  })

  test("title descriptor has a semantic ID with English default", () => {
    expect(TOOL_TITLE_DESC["resolve_conflicts"]).toEqual({
      id: "tool.title.resolve-conflicts",
      message: "Resolve Conflicts",
    })
  })

  test("trigger shows path, resolved-conflict chip, strategies summary and diff changes", () => {
    const trigger = renderResolveConflicts({
      input: { filePath: "/workspace/src/a.ts" },
      metadata: {
        path: "/workspace/src/a.ts",
        resolvedConflicts: 2,
        strategies: ["ours", "theirs"],
        changeSummary: { additions: 4, deletions: 2 },
        hasConflicts: false,
        conflicts: [],
      },
      output: "Resolved 2 conflict blocks.",
    })
    expect(trigger?.title).toBe("Resolve Conflicts")
    expect(trigger?.icon).toBe("file-pen")
    expect(trigger?.subtitlePath).toBe("/workspace/src/a.ts")
    expect(trigger?.changes).toEqual({ additions: 4, deletions: 2 })
    expect(trigger?.tags).toEqual([{ label: "2 resolved", tone: "success" }])
  })

  test("trigger adds a diagnostics chip when diagnostics are present", () => {
    const trigger = renderResolveConflicts({
      input: { filePath: "/workspace/src/a.ts" },
      metadata: {
        resolvedConflicts: 1,
        strategies: ["both"],
        diagnostics: {
          "/workspace/src/a.ts": [
            {
              severity: 1,
              message: "lint error",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
          ],
        },
      },
    })
    expect(trigger?.tags).toEqual([
      { label: "1 resolved", tone: "success" },
      { label: "diagnostics 1", tone: "danger" },
    ])
  })
})
