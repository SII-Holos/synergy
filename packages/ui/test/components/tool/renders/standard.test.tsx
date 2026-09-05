import { describe, expect, mock, test } from "bun:test"
import { setupI18n as coreSetupI18n } from "@lingui/core"
import { TOOL_MISC_DESC } from "../../../../src/components/tool-title-descriptors"

const REMOTE_LABEL_ID = "tool.misc.executed-via-synergy-link"
const REMOTE_LABEL_EN = "Executed via Synergy Link"
const REMOTE_LABEL_ZH = "通过 Synergy Link 执行"

const i18n = coreSetupI18n({ locale: "en", locales: ["en", "zh-CN"], messages: {} })

let registeredRenders: Record<string, (props: Record<string, any>) => unknown> = {}
let capturedTrigger: Record<string, unknown> | undefined
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function") return type({ ...(props ?? {}), children })
    return null
  },
}

mock.module("@lingui/solid", () => ({
  useLingui: () => ({
    _: (descriptor: { id: string; message?: string }) => i18n._(descriptor),
  }),
}))
mock.module("solid-js", () => ({
  createMemo: (fn: () => unknown) => fn,
  For: () => null,
  Show: () => null,
}))
mock.module("../../../../src/context", () => ({
  useData: () => ({ store: { permission: {} } }),
}))
mock.module("../../../../src/hooks", () => ({
  createAutoScroll: () => ({
    contentRef: undefined,
    handleScroll: () => {},
    scrollRef: undefined,
  }),
  createAnimatedNumber: () => 0,
}))
mock.module("../../../../src/components/basic-tool", () => ({
  BasicTool: (props: { trigger: Record<string, unknown> }) => {
    capturedTrigger = props.trigger
    return null
  },
  SmartTool: () => null,
}))
mock.module("../../../../src/components/icon", () => ({ Icon: () => null }))
mock.module("../../../../src/components/checkbox", () => ({ Checkbox: () => null }))
mock.module("../../../../src/components/render-html", () => ({ RenderHtml: () => null }))
let capturedGalleryFiles: unknown[] | undefined
const lastGalleryFiles = () => capturedGalleryFiles
mock.module("../../../../src/components/attachment-card", () => ({
  AttachmentGallery: (props: { files: unknown[] }) => {
    capturedGalleryFiles = props.files
    return null
  },
}))
mock.module("../../../../src/components/tool-output-text", () => ({ ToolTextOutput: () => null }))
mock.module("../../../../src/components/semantic-icon", () => ({ getSemanticIcon: (name: string) => name }))
mock.module("@ericsanchezok/synergy-sdk", () => ({}))
mock.module("../../../../src/components/message-part", () => ({
  ToolRegistry: {
    register: (entry: { name: string; render: (props: Record<string, any>) => unknown }) => {
      registeredRenders[entry.name] = entry.render
    },
  },
  getToolInfo: () => ({ icon: "settings", title: "Tool" }),
  getDirectory: (path: string) => path,
}))

await import("../../../../src/components/tool/renders/standard")

function renderTrigger(tool: string, props: Record<string, any>) {
  registeredRenders[tool]?.(props)
  return capturedTrigger
}

describe("remote Synergy Link provenance on bash/process cards", () => {
  test("descriptor has a semantic ID with English default", () => {
    expect(TOOL_MISC_DESC.executedViaSynergyLink).toEqual({
      id: REMOTE_LABEL_ID,
      message: REMOTE_LABEL_EN,
    })
  })

  test("bash card marks remote execution", () => {
    i18n.loadAndActivate({ locale: "en", messages: { [REMOTE_LABEL_ID]: REMOTE_LABEL_EN } })
    const remote = renderTrigger("bash", {
      input: { command: "ls" },
      metadata: { backend: "remote" },
    })
    expect(remote?.tags).toEqual([{ label: "ls" }, { label: REMOTE_LABEL_EN }])
  })

  test("bash card stays unmarked for local or absent backend", () => {
    const local = renderTrigger("bash", { input: { command: "ls" }, metadata: { backend: "local" } })
    expect(local?.tags).toEqual([{ label: "ls" }])
    const absent = renderTrigger("bash", { input: { command: "ls" }, metadata: {} })
    expect(absent?.tags).toEqual([{ label: "ls" }])
  })

  test("process card marks remote execution", () => {
    const remote = renderTrigger("process", {
      input: { action: "list" },
      metadata: { backend: "remote" },
    })
    expect(remote?.tags).toEqual([{ label: REMOTE_LABEL_EN }])
  })

  test("process card stays unmarked for local backend", () => {
    const local = renderTrigger("process", {
      input: { action: "list" },
      metadata: { backend: "local" },
    })
    expect(local?.tags).toBeUndefined()
  })

  test("remote marker reacts to the active locale", () => {
    i18n.loadAndActivate({ locale: "zh-CN", messages: { [REMOTE_LABEL_ID]: REMOTE_LABEL_ZH } })
    const zh = renderTrigger("bash", { input: { command: "ls" }, metadata: { backend: "remote" } })
    expect(zh?.tags).toEqual([{ label: "ls" }, { label: REMOTE_LABEL_ZH }])
  })
})

describe("attach card gallery routing", () => {
  test("renders gallery from full attachment parts when provided", () => {
    capturedGalleryFiles = undefined
    const attachment = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "attachment" as const,
      mime: "text/html",
      filename: "report.html",
      url: "asset://abc",
    }
    renderTrigger("attach", {
      status: "completed",
      input: {},
      metadata: { files: [{ assetId: "abc", filename: "report.html", mime: "text/html", size: 10 }] },
      attachments: [attachment],
    })
    expect(lastGalleryFiles()).toEqual([attachment])
  })

  test("falls back to legacy metadata files without attachment parts", () => {
    capturedGalleryFiles = undefined
    renderTrigger("attach", {
      status: "completed",
      input: {},
      metadata: { files: [{ assetId: "abc", filename: "report.html", mime: "text/html", size: 10 }] },
    })
    expect(lastGalleryFiles()).toEqual([{ assetId: "abc", filename: "report.html", mime: "text/html", size: 10 }])
  })
})

describe("speak card trigger", () => {
  test("renders an audio icon with the text subtitle", () => {
    const trigger = renderTrigger("speak", {
      status: "running",
      input: { text: "Report ready" },
    })

    expect(trigger).toMatchObject({
      icon: "audio-lines",
      title: { id: "tool.title.speak", message: "Speak" },
      subtitle: "Report ready",
    })
  })
})
