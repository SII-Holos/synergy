import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { TOOL_TITLE_DESC } from "../../../../src/components/tool-title-descriptors"

const registrations = new Map<string, (props: Record<string, any>) => unknown>()
let capturedTrigger: Record<string, unknown> | undefined
const capturedPreviews: { path?: string; patch?: string }[] = []
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
    For: (props: { each?: unknown[]; children: [(value: unknown) => unknown] }) =>
      props.each?.map((value) => props.children[0](value)),
    Show: () => null,
  }))
  mock.module("solid-js/web", () => ({ Dynamic: () => null }))
  mock.module("../../../../src/components/basic-tool", () => ({
    BasicTool: (props: { trigger: Record<string, unknown> }) => {
      capturedTrigger = props.trigger
      return null
    },
    SmartTool: () => null,
    useToolResultPresentation: () => false,
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
  mock.module("../../../../src/components/tool/content-preview", () => ({
    ToolFilePreview: () => null,
    ToolPatchPreview: (props: { path?: string; patch?: string }) => {
      capturedPreviews.push({ path: props.path, patch: props.patch })
      return null
    },
  }))
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
  capturedPreviews.length = 0
})

test("patch card retains partial and unresolved outcomes", () => {
  expect(registrations.has("apply_patch")).toBe(true)
  for (const outcome of ["partial", "unresolved"]) {
    registrations.get("apply_patch")?.({ input: {}, metadata: { outcome, sections: [] }, status: "error" })
    expect(capturedTrigger?.tags).toEqual([
      { label: outcome === "partial" ? "Partially applied" : "Outcome unconfirmed", tone: "warning" },
    ])
  }
})

test("move card renders the recorded destination replacement and source deletion", () => {
  registrations.get("apply_patch")?.({
    input: {},
    status: "completed",
    metadata: {
      outcome: "applied",
      sections: [
        {
          source: "old.ts",
          destination: "nested/new.ts",
          state: "committed",
          observedPath: "old.ts",
          diff: "-source",
          filediff: { file: "old.ts", preview: "-source" },
          files: [
            { file: "nested/new.ts", additions: 1, deletions: 1, preview: "-destination\n+replacement" },
            { file: "old.ts", additions: 0, deletions: 1, preview: "-source" },
          ],
        },
      ],
    },
  })
  expect(capturedPreviews).toEqual([
    { path: "nested/new.ts", patch: "-destination\n+replacement" },
    { path: "old.ts", patch: "-source" },
  ])
})

test("partial move card renders only the recorded destination write", () => {
  registrations.get("apply_patch")?.({
    input: {},
    status: "error",
    metadata: {
      outcome: "partial",
      sections: [
        {
          source: "old.ts",
          destination: "nested/new.ts",
          state: "failed",
          files: [{ file: "nested/new.ts", additions: 1, deletions: 0, preview: "+replacement" }],
          operations: [
            { phase: "write", path: "nested/new.ts", state: "committed" },
            { phase: "delete", path: "old.ts", state: "failed" },
          ],
        },
      ],
    },
  })
  expect(capturedPreviews).toEqual([{ path: "nested/new.ts", patch: "+replacement" }])
})

test("historical move card renders one saved diff at its recorded path", () => {
  registrations.get("apply_patch")?.({
    input: {},
    status: "completed",
    metadata: {
      outcome: "applied",
      sections: [
        {
          source: "old.ts",
          destination: "new.ts",
          state: "committed",
          diff: "+legacy",
          filediff: { file: "old.ts" },
        },
      ],
    },
  })
  expect(capturedPreviews).toEqual([{ path: "old.ts", patch: "+legacy" }])
})

test("patch cards keep previewless files without inventing effects from empty or unknown receipts", () => {
  registrations.get("apply_patch")?.({
    input: {},
    status: "error",
    metadata: {
      outcome: "unresolved",
      sections: [
        {
          source: "old.ts",
          destination: "new.ts",
          state: "unknown",
          observedPath: "old.ts",
          diff: "+stale",
          files: [],
        },
        { source: "old.ts", destination: "new.ts", state: "unknown", diff: "+planned" },
        {
          source: "old.ts",
          destination: "new.ts",
          state: "unknown",
          diff: "+planned",
          files: [{ file: "recorded.ts", additions: 0, deletions: 0 }],
        },
      ],
    },
  })
  expect(capturedPreviews).toEqual([{ path: "recorded.ts", patch: undefined }])
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
