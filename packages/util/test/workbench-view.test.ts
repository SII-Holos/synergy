import { describe, expect, test } from "bun:test"
import { WorkbenchView } from "../src/workbench-view"

describe("WorkbenchView", () => {
  test("one object-root tool contract presents existing resources without arbitrary UI commands", () => {
    for (const target of [
      { kind: "note", id: "note" },
      { kind: "workspace-file", path: "src/index.ts", location: { kind: "text", line: 12 } },
      { kind: "browser-page", pageId: "page" },
      { kind: "asset", url: "asset://0123456789abcdef.pdf" },
    ] satisfies WorkbenchView.Target[]) {
      expect(WorkbenchView.Parameters.parse({ input: { action: "open", target } }).input).toEqual({
        action: "open",
        target,
      })
    }
    expect(
      WorkbenchView.Parameters.safeParse({ input: { action: "open", panelId: "settings", state: {} } }).success,
    ).toBe(false)
    expect(
      WorkbenchView.Parameters.safeParse({
        input: { action: "open", target: { kind: "url", url: "https://example.com" } },
      }).success,
    ).toBe(false)
    expect(WorkbenchView.Parameters.safeParse({ input: { action: "hide" } }).success).toBe(false)
    expect(WorkbenchView.Parameters.parse({ input: { action: "hide", viewId: "view" } }).input).toEqual({
      action: "hide",
      viewId: "view",
    })
  })

  test("locations and immutable references retain their canonical validation", () => {
    expect(
      WorkbenchView.Target.safeParse({ kind: "note", id: "note", location: { kind: "heading", id: "block" } }).success,
    ).toBe(true)
    expect(
      WorkbenchView.Target.safeParse({ kind: "workspace-file", path: "file.ts", location: { kind: "text", line: 0 } })
        .success,
    ).toBe(false)
    expect(WorkbenchView.Target.safeParse({ kind: "asset", url: "https://example.com/report.pdf" }).success).toBe(false)
    expect(
      WorkbenchView.Target.safeParse({ kind: "browser-page", pageId: "page", url: "https://example.com" }).success,
    ).toBe(false)
  })

  test("requests bind a session and captured Workspace instead of borrowing the viewer's files", () => {
    const request: WorkbenchView.ServerMessage = {
      type: "server.workbench.request",
      properties: {
        requestId: "request",
        scopeID: "project",
        sessionID: "session",
        command: { action: "open", target: { kind: "workspace-file", path: "file.ts" } },
        context: { state: "bound", workspace: { id: "workspace", generation: 2, root: "/fixture" }, directory: "" },
      },
    }
    expect(WorkbenchView.ServerMessage.parse(request)).toEqual(request)
    expect(
      WorkbenchView.ServerMessage.safeParse({ ...request, properties: { ...request.properties, sessionID: "" } })
        .success,
    ).toBe(false)
  })

  test("a receipt distinguishes visible application, loading content and uncertain dispatch", () => {
    const outcome: WorkbenchView.Outcome = {
      status: "applied",
      views: [
        {
          viewId: "view",
          surface: "side",
          target: { kind: "note", id: "note" },
          visible: true,
          contentState: "loading",
        },
      ],
    }
    expect(WorkbenchView.Outcome.parse(outcome)).toEqual(outcome)
    expect(
      WorkbenchView.ClientMessage.parse({
        type: "client.workbench.receipt",
        properties: { requestId: "request", outcome },
      }),
    ).toEqual({
      type: "client.workbench.receipt",
      properties: { requestId: "request", outcome },
    })
    expect(WorkbenchView.Outcome.parse({ status: "unknown", reason: "frontend_disconnected" })).toEqual({
      status: "unknown",
      reason: "frontend_disconnected",
    })
    expect(
      WorkbenchView.ClientMessage.safeParse({
        type: "client.workbench.receipt",
        properties: { requestId: "request", outcome: { status: "shown" } },
      }).success,
    ).toBe(false)
  })

  test("only a matching protocol advertises a typed presentation capability", () => {
    expect(
      WorkbenchView.ClientMessage.parse({
        type: "client.workbench.ready",
        properties: { version: 1, targets: ["note", "browser-page"] },
      }),
    ).toEqual({
      type: "client.workbench.ready",
      properties: { version: 1, targets: ["note", "browser-page"] },
    })
    expect(
      WorkbenchView.ClientMessage.safeParse({
        type: "client.workbench.ready",
        properties: { version: 0, targets: ["note"] },
      }).success,
    ).toBe(false)
    expect(
      WorkbenchView.ClientMessage.safeParse({
        type: "client.workbench.ready",
        properties: { version: 1, targets: ["javascript"] },
      }).success,
    ).toBe(false)
  })
})
