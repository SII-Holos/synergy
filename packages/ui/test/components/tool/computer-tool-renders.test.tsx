import { expect, mock, test } from "bun:test"

const registrations = new Map<string, (props: Record<string, unknown>) => unknown>()
let card: Record<string, unknown> | undefined
let output: unknown
let rows: { label: string; value?: unknown }[] = []
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    return typeof type === "function" ? type({ ...props, children }) : null
  },
}
mock.module("@lingui/solid", () => ({
  useLingui: () => ({ _: (descriptor: { message?: string }) => descriptor.message ?? "" }),
}))
mock.module("../../../src/components/basic-tool", () => ({
  BasicTool: (props: Record<string, unknown>) => {
    card = props
    return null
  },
}))
mock.module("../../../src/components/message-part", () => ({
  ToolRegistry: {
    register: (entry: { name: string; render: (props: Record<string, unknown>) => unknown }) =>
      registrations.set(entry.name, entry.render),
  },
}))
mock.module("../../../src/components/tool/body-primitives", () => ({
  SummaryGrid: (props: { rows: { label: string; value?: unknown }[] }) => {
    rows = props.rows
    return null
  },
  RawOutput: (props: { output: unknown }) => {
    output = props.output
    return null
  },
}))
for (const name of ["file-ops", "standard", "task", "dag", "browser", "anysearch", "scholight", "batch"])
  mock.module(`../../../src/components/tool/renders/${name}`, () => ({}))
await import("../../../src/components/tool-renders")

test("the standard render bundle registers native tools and preserves status, output and attachments", () => {
  for (const name of ["computer_apps", "computer_observe", "computer_action"]) {
    const render = registrations.get(name)
    expect(render).toBeDefined()
    const props = {
      input: { input: { action: "type", text: "private value" } },
      output: "Native result",
      status: "completed",
      attachments: [{ mime: "image/png" }],
    }
    render!(props)
    expect(card?.status).toBe("completed")
    expect(card?.attachments).toBe(props.attachments)
    expect(output).toBe("Native result")
    expect(JSON.stringify(card?.trigger)).not.toContain("private value")
  }
})

test("historical observations never imply validated visual quality", () => {
  registrations.get("computer_observe")!({ input: {}, metadata: {}, output: "history", status: "completed" })
  expect(rows.some((row) => row.value === "Quality was not recorded")).toBe(true)
})

test("image delivery and native availability remain separate in the quality card", () => {
  const sha256 = "a".repeat(64)
  const computerObservation = {
    version: 2,
    id: crypto.randomUUID(),
    target: { pid: 1, windowId: 2, app: "Fixture", title: "Window" },
    capturedAt: 1,
    expiresAt: 60001,
    ax: { status: "partial", truncated: true },
    image: { status: "valid", width: 10, height: 20, sha256 },
    actions: Object.fromEntries(
      ["click", "type", "key", "scroll", "drag", "set_value"].map((action) => [action, { available: true }]),
    ),
  }
  for (const stage of ["saved", "included", "submitted", "omitted"] as const) {
    registrations.get("computer_observe")!({
      input: {},
      metadata: { computerObservation },
      attachments: [{ metadata: { imageInput: { sha256, stage } } }],
      output: "fixture",
      status: "completed",
    })
    expect(rows.find((row) => row.label === "Window image")?.value).toBe("Verified image")
    expect(rows.find((row) => row.label === "Accessibility")?.value).toBe("Partial results")
    expect(String(rows.find((row) => row.label === "Actions supported at observation")?.value).includes("Drag")).toBe(
      stage === "submitted",
    )
  }
  registrations.get("computer_observe")!({ metadata: { computerObservation }, attachments: [], input: {} })
  expect(rows.find((row) => row.label === "Model image input")?.value).toBe("Image attachment unavailable")
})

test("cards distinguish explicit foreground dispatch from background preference", () => {
  for (const deliveryMode of ["background", "foreground"]) {
    registrations.get("computer_action")!({
      input: { input: { action: "click", target: { x: 10, y: 20 } } },
      metadata: { deliveryMode },
      output: "Action dispatched",
      status: "completed",
    })
    expect(JSON.stringify(card?.trigger)).toContain(
      deliveryMode === "foreground" ? "Foreground operation" : "Background preferred",
    )
    expect(rows.some((row) => row.value === "Dispatched; observe to confirm")).toBe(true)
  }
})
