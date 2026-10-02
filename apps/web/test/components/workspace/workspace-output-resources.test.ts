import { expect, test } from "bun:test"
import type { AttachmentPart, ToolPart } from "@ericsanchezok/synergy-sdk"
import { workspaceOutputResources } from "../../../src/components/workspace/workspace-output-resources"

const message = { id: "message", sessionID: "one", role: "assistant" as const, time: { created: 100 } }
const tool = (name: string, metadata: Record<string, unknown>): ToolPart => ({
  id: name,
  sessionID: "one",
  messageID: "message",
  type: "tool",
  callID: "call",
  tool: name,
  state: { status: "completed", input: {}, title: name, output: "done", metadata, time: { start: 100, end: 101 } },
})
const attachment: AttachmentPart = {
  id: "attachment",
  sessionID: "one",
  messageID: "message",
  type: "attachment",
  filename: "report.pdf",
  mime: "application/pdf",
  url: "asset://report",
}

test("only viewable outputs from the current assistant task become reveal candidates", () => {
  const parts = [
    tool("file_read", {}),
    tool("note_write", { action: "create", id: "note", title: "Note" }),
    tool("browser_navigation", { action: "goto", pageId: "page", url: "https://example.com" }),
    attachment,
    { ...attachment, id: "image", mime: "image/png" },
  ]
  const resources = workspaceOutputResources({ message, parts, currentSessionID: "one", scopeID: "project" })
  expect(resources.map((value) => value.panelId)).toEqual(["notes", "browser", "attachment"])
  expect(resources[0]).toMatchObject({ completedAt: 101, init: { resourceId: "note", source: "project" } })
  expect(workspaceOutputResources({ message, parts, currentSessionID: "background", scopeID: "project" })).toEqual([])
  expect(
    workspaceOutputResources({
      message: { ...message, role: "user" },
      parts,
      currentSessionID: "one",
      scopeID: "project",
    }),
  ).toEqual([])
})

test("updates, scans, blank webpages and incomplete tools do not reveal resources", () => {
  const running = tool("note_write", { id: "pending" })
  running.state = { status: "running", input: {}, time: { start: 100 } }
  const resources = workspaceOutputResources({
    message,
    currentSessionID: "one",
    scopeID: "project",
    parts: [
      running,
      tool("note_write", { action: "update", id: "existing" }),
      tool("file_scan", {}),
      tool("browser_navigation", { action: "open", pageId: "page", url: "about:blank" }),
      {
        ...tool("export", {}),
        state: {
          ...tool("export", {}).state,
          status: "completed",
          input: {},
          title: "Export",
          output: "done",
          metadata: {},
          time: { start: 100, end: 101 },
          attachments: [attachment],
        },
      },
    ],
  })
  expect(resources.map((value) => value.panelId)).toEqual(["attachment"])
})
