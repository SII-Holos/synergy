import { expect, test } from "bun:test"
import { rename } from "node:fs/promises"
import path from "node:path"
import { workbench } from "../../src/component"
import { registerHttp } from "../../src/http"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"

async function fixture(
  body: (input: {
    execute(
      params: WorkbenchView.Parameters,
      callID?: string,
      signal?: AbortSignal,
      sessionID?: string,
    ): Promise<WorkbenchView.Result>
    connect(): Promise<{
      socket: WebSocket
      frames: Array<{ scopeID: string | null; payload: { type: string; properties: Record<string, unknown> } }>
      send(type: string, properties: Record<string, unknown>): void
      barrier(): Promise<void>
      ready(targets?: WorkbenchView.TargetKind[]): void
      active(sessionID?: string, generation?: number, publication?: number): void
      request(index?: number): Promise<WorkbenchView.Request>
      receipt(requestId: string, outcome?: WorkbenchView.Outcome): void
    }>
    sessionID: string
  }) => Promise<void>,
  options: { workspace?: boolean } = {},
) {
  const component = workbench()
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime({
          workers: false,
          environment: false,
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
        component.register()
        registerHttp()
      },
      services: () => component.services?.() ?? {},
    },
  })
  await runtime.run(async () => {
    await using tmp = options.workspace ? await tmpdir({ git: true }) : undefined
    const scope = tmp ? await tmp.scope() : Scope.home()
    return ScopeContext.provide({
      scope,
      workspace: options.workspace ? undefined : null,
      async fn() {
        const declared = (await ToolRegistry.tools("openai")).find((tool) => tool.id === "workbench_view")
        expect(declared).toBeDefined()
        if (!declared) throw new Error("workbench_view is not registered")
        expect(declared.requiresWorkspace).toBe(false)
        expect(declared.parameters.toJSONSchema().type).toBe("object")
        expect(declared.exposure?.mode).toBe("search")
        const session = await Session.create(options.workspace ? {} : { workspace: null })
        const server = Server.listen({ hostname: "127.0.0.1", port: 0, preferDefaultPort: false })
        const sockets: WebSocket[] = []
        const wait = async (predicate: () => boolean) => {
          const deadline = Date.now() + 5000
          while (!predicate()) {
            if (Date.now() > deadline) throw new Error("workbench transport did not settle")
            await Bun.sleep(5)
          }
        }
        const execute = async (
          params: WorkbenchView.Parameters,
          callID = crypto.randomUUID(),
          signal = AbortSignal.any([]),
          sessionID = session.id,
        ) => {
          const needs = declared.resourceNeeds?.(params)
          const caller = needs?.workspace ? await Session.get(sessionID) : undefined
          await using resources =
            needs?.workspace && caller?.workspaceID
              ? await EnvironmentResources.resolve({
                  scopeID: caller.scope.id,
                  workspaceID: caller.workspaceID,
                  workspaceGeneration: ScopeContext.current.workspace?.generation,
                  needs,
                })
              : undefined
          const context: Tool.Context = {
            sessionID,
            messageID: "msg_workbench_fixture",
            callID,
            agent: "fixture",
            abort: signal,
            metadata() {},
            async ask() {},
            resources,
          }
          const result = resources
            ? await EnvironmentResources.provide(resources, callID, () => declared.execute(params, context))
            : await declared.execute(params, context)
          const outcome = WorkbenchView.Result.strip().parse(result.metadata)
          expect(result.output).toContain(outcome.status)
          return outcome
        }
        const connect = async () => {
          const url = new URL("/global/event/ws?stream=projection-v2", server.url)
          url.protocol = "ws:"
          const Socket = WebSocket as typeof WebSocket & {
            new (url: URL, options: { headers: Record<string, string> }): WebSocket
          }
          const socket = new Socket(url, { headers: { origin: server.url.origin } })
          sockets.push(socket)
          const frames: Array<{
            scopeID: string | null
            payload: { type: string; properties: Record<string, unknown> }
          }> = []
          socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))))
          const send = (type: string, properties: Record<string, unknown>) =>
            socket.send(JSON.stringify({ payload: { type, properties } }))
          const barrier = async () => {
            const count = frames.filter((frame) => frame.payload.type === "server.pong").length
            send("client.ping", {})
            await wait(() => frames.filter((frame) => frame.payload.type === "server.pong").length > count)
          }
          await wait(() => frames.some((frame) => frame.payload.type === "server.connected"))
          return {
            socket,
            frames,
            send,
            barrier,
            ready: (targets: WorkbenchView.TargetKind[] = ["note", "workspace-file", "asset", "browser-page"]) =>
              send("client.workbench.ready", { version: WorkbenchView.VERSION, targets }),
            active: (sessionID = session.id, generation = 1, publication = generation) =>
              send("client.view.interests", {
                generation: publication,
                active: { scopeID: scope.id, sessionID, generation },
                parts: [],
                details: [],
              }),
            async request(index = 0) {
              await wait(
                () => frames.filter((frame) => frame.payload.type === "server.workbench.request").length > index,
              )
              return WorkbenchView.Request.parse(
                frames.filter((frame) => frame.payload.type === "server.workbench.request")[index]!.payload.properties,
              )
            },
            receipt(requestId: string, outcome?: WorkbenchView.Outcome) {
              const request = frames.find(
                (frame) =>
                  frame.payload.type === "server.workbench.request" && frame.payload.properties.requestId === requestId,
              )
              const command = request ? WorkbenchView.Request.parse(request.payload.properties).command : undefined
              outcome ??= {
                status: "applied",
                views:
                  command?.action === "open"
                    ? [
                        {
                          viewId: "view:fixture",
                          target: command.target,
                          surface: "side",
                          visible: true,
                          contentState: "ready",
                        },
                      ]
                    : [],
              }
              send("client.workbench.receipt", { requestId, outcome })
            },
          }
        }
        try {
          await body({ execute, connect, sessionID: session.id })
        } finally {
          for (const socket of sockets) socket.close()
          await server.stop(true)
        }
      },
    })
  })
}

const open = { input: { action: "open", target: { kind: "note", id: "nte_fixture" } } } as const

test("registered root-object tool is workspace-independent and cannot borrow a viewer workspace", async () => {
  await fixture(async ({ execute, connect }) => {
    expect((await execute(open)).status).toBe("unavailable")
    const viewer = await connect()
    viewer.ready()
    viewer.active()
    await viewer.barrier()
    expect(
      (await execute({ input: { action: "open", target: { kind: "workspace-file", path: "README.md" } } })).status,
    ).toBe("blocked")
    expect(viewer.frames.filter((frame) => frame.payload.type === "server.workbench.request")).toHaveLength(0)
  })
}, 20000)

test("only a ready active supported client can acknowledge, including applied loading content", async () => {
  await fixture(async ({ execute, connect, sessionID }) => {
    const first = await connect()
    const second = await connect()
    first.active()
    second.ready(["asset"])
    second.active()
    await Promise.all([first.barrier(), second.barrier()])
    expect((await execute(open)).status).toBe("unavailable")
    first.ready()
    await first.barrier()
    let settled = false
    const pending = execute(open).then((result) => {
      settled = true
      return result
    })
    const request = await first.request()
    expect(request.scopeID).toBe("home")
    expect(request.sessionID).toBe(sessionID)
    const views: WorkbenchView.View[] = [
      { viewId: "note:fixture", surface: "side", target: open.input.target, visible: true, contentState: "loading" },
    ]
    second.receipt(request.requestId, { status: "applied", views })
    first.receipt("wrong-request", { status: "applied", views })
    await Promise.all([first.barrier(), second.barrier()])
    expect(settled).toBe(false)
    expect((await execute({ input: { action: "status", requestId: request.requestId } })).status).toBe("unknown")
    first.receipt(request.requestId, { status: "applied", views: [...views] })
    const result = await pending
    expect(result.status).toBe("applied")
    expect(result.views).toEqual(views)
    expect((await execute({ input: { action: "status", requestId: result.requestId } })).views).toEqual(views)
    expect(second.frames.filter((frame) => frame.payload.type === "server.workbench.request")).toHaveLength(0)
  })
}, 20000)

test("multiple eligible clients require explicit clientId and identical dispatches do not replay", async () => {
  await fixture(async ({ execute, connect }) => {
    const first = await connect()
    const second = await connect()
    for (const viewer of [first, second]) {
      viewer.ready()
      viewer.active()
      await viewer.barrier()
    }
    const ambiguity = await execute(open)
    expect(ambiguity.status).toBe("ambiguous")
    expect(ambiguity.clients).toHaveLength(2)
    expect((await execute({ ...open, clientId: "unconnected" })).status).toBe("unavailable")
    const selected = { ...open, clientId: ambiguity.clients![0]!.clientId }
    const pending = execute(selected, "call_dedupe")
    const duplicate = execute(selected, "call_dedupe")
    const request = await first.request()
    first.receipt(request.requestId)
    expect(await pending).toEqual(await duplicate)
    expect((await execute(selected, "call_dedupe")).requestId).toBe(request.requestId)
    expect((await execute({ ...selected, input: { action: "hide", viewId: "other" } }, "call_dedupe")).status).toBe(
      "blocked",
    )
    await first.barrier()
    expect(first.frames.filter((frame) => frame.payload.type === "server.workbench.request")).toHaveLength(1)
    expect(second.frames.filter((frame) => frame.payload.type === "server.workbench.request")).toHaveLength(0)
  })
}, 20000)

test("stale interest publications cannot select old sessions and active changes fence late receipts", async () => {
  await fixture(async ({ execute, connect, sessionID }) => {
    const viewer = await connect()
    viewer.ready()
    viewer.active("another-session", 2, 2)
    viewer.active(sessionID, 1, 1)
    await viewer.barrier()
    expect((await execute(open)).status).toBe("unavailable")
    viewer.active(sessionID, 3, 3)
    await viewer.barrier()
    const pending = execute(open)
    const request = await viewer.request()
    viewer.active("another-session", 4, 4)
    await viewer.barrier()
    expect((await pending).status).toBe("unknown")
    expect(viewer.frames).toContainEqual({
      scopeID: "home",
      payload: { type: "server.workbench.cancel", properties: { requestId: request.requestId } },
    })
    viewer.receipt(request.requestId)
    viewer.active(sessionID, 5, 5)
    await viewer.barrier()
    expect((await execute({ input: { action: "status", requestId: request.requestId } })).status).toBe("unknown")
  })
}, 20000)

test("cancellation and receipt timeout preserve uncertainty, and reconnect never replays", async () => {
  await fixture(async ({ execute, connect }) => {
    const viewer = await connect()
    viewer.ready()
    viewer.active()
    await viewer.barrier()
    const before = AbortSignal.abort()
    expect((await execute(open, "before", before)).status).toBe("cancelled")
    const controller = new AbortController()
    const cancelled = execute(open, "after", controller.signal)
    const first = await viewer.request()
    controller.abort()
    expect((await cancelled).status).toBe("unknown")
    await viewer.barrier()
    expect(
      viewer.frames.some(
        (frame) =>
          frame.payload.type === "server.workbench.cancel" && frame.payload.properties.requestId === first.requestId,
      ),
    ).toBe(true)
    const timeout = execute({ ...open, timeoutSeconds: 0.03 }, "timeout")
    const expired = await viewer.request(1)
    expect((await timeout).status).toBe("unknown")
    viewer.receipt(expired.requestId)
    await viewer.barrier()
    expect((await execute({ input: { action: "status", requestId: expired.requestId } })).status).toBe("unknown")
    const disconnected = execute({ ...open, timeoutSeconds: 60 }, "disconnect")
    const request = await viewer.request(2)
    viewer.socket.close()
    expect((await disconnected).status).toBe("unknown")
    const replacement = await connect()
    replacement.ready()
    replacement.active()
    await replacement.barrier()
    replacement.receipt(request.requestId, {
      status: "applied",
      views: [
        { viewId: "note:fixture", surface: "side", target: open.input.target, visible: true, contentState: "ready" },
      ],
    })
    await replacement.barrier()
    expect((await execute({ ...open, timeoutSeconds: 60 }, "disconnect")).status).toBe("unknown")
    expect(replacement.frames.filter((frame) => frame.payload.type === "server.workbench.request")).toHaveLength(0)
  })
}, 20000)

test("status queries are isolated by caller identity and live status waits for its own receipt", async () => {
  await fixture(async ({ execute, connect }) => {
    const viewer = await connect()
    viewer.ready()
    viewer.active()
    await viewer.barrier()
    const pending = execute(open)
    const request = await viewer.request()
    viewer.receipt(request.requestId)
    expect((await pending).status).toBe("applied")
    await using other = await tmpdir({ git: true })
    const foreign = await ScopeContext.provide({
      scope: await other.scope(),
      workspace: null,
      fn: () => execute({ input: { action: "status", requestId: request.requestId } }),
    })
    expect(foreign.status).toBe("unknown")
    expect(
      (
        await execute(
          { input: { action: "status", requestId: request.requestId } },
          undefined,
          undefined,
          "different-session",
        )
      ).status,
    ).toBe("unknown")
    const current = execute({ input: { action: "status" } })
    const statusRequest = await viewer.request(1)
    expect(statusRequest.command).toEqual({ action: "status" })
    viewer.receipt(statusRequest.requestId)
    expect((await current).status).toBe("applied")
    expect((await execute({ input: { action: "status", requestId: "not-retained" } })).status).toBe("unknown")
    const closed = new Promise<void>((resolve) =>
      viewer.socket.addEventListener("close", () => resolve(), { once: true }),
    )
    viewer.socket.close()
    await closed
    const deadline = Date.now() + 5000
    let retained = await execute({ input: { action: "status", requestId: request.requestId } })
    while (retained.status !== "unknown" && Date.now() < deadline) {
      await Bun.sleep(5)
      retained = await execute({ input: { action: "status", requestId: request.requestId } })
    }
    expect(retained.status).toBe("unknown")
  })
}, 20000)

test("Workspace file presentation captures only the caller binding and rejects unavailable directories", async () => {
  await fixture(
    async ({ execute, connect }) => {
      const viewer = await connect()
      viewer.ready()
      viewer.active()
      await viewer.barrier()
      const workspace = ScopeContext.current.workspace!
      const file = { input: { action: "open", target: { kind: "workspace-file", path: "README.md" } } } as const
      const pending = execute(file)
      const request = await viewer.request()
      expect(request.context).toEqual({
        state: "bound",
        workspace: { id: workspace.id!, generation: workspace.generation!, root: workspace.path },
        directory: "",
      })
      viewer.receipt(request.requestId)
      expect((await pending).status).toBe("applied")
      for (const [index, source] of [
        "./README.md",
        "child/../README.md",
        path.join(workspace.path, "README.md"),
      ].entries()) {
        const equivalent = execute({
          input: { action: "open", target: { kind: "workspace-file", path: source } },
          timeoutSeconds: 0.1,
        })
        const command = await viewer.request(index + 1)
        viewer.receipt(command.requestId, {
          status: "applied",
          views: [
            {
              viewId: "file:readme",
              target: { kind: "workspace-file", path: "README.md" },
              surface: "side",
              visible: true,
              contentState: "ready",
            },
          ],
        })
        expect((await equivalent).status).toBe("applied")
      }
      expect(
        (
          await execute({
            input: { action: "open", target: { kind: "workspace-file", path: "../outside.md" } },
            timeoutSeconds: 0.1,
          })
        ).status,
      ).toBe("blocked")
      await expect(
        ScopeContext.provide({
          scope: ScopeContext.current.scope,
          workspace: { ...workspace, generation: workspace.generation! + 1 },
          fn: () => execute(file),
        }),
      ).rejects.toBeInstanceOf(WorkspaceCatalog.BindingChanged)
      const original = `${workspace.path}.unavailable`
      await rename(workspace.path, original)
      try {
        await expect(execute({ ...file, timeoutSeconds: 0.03 })).rejects.toBeInstanceOf(WorkspaceCatalog.Unavailable)
      } finally {
        await rename(original, workspace.path)
      }
    },
    { workspace: true },
  )
}, 20000)

test("active generation changes and malformed readiness cannot acknowledge an old dispatch", async () => {
  await fixture(async ({ execute, connect }) => {
    const viewer = await connect()
    viewer.send("client.workbench.ready", { version: 0, targets: ["note"] })
    viewer.active()
    await viewer.barrier()
    expect((await execute(open)).status).toBe("unavailable")
    viewer.ready()
    await viewer.barrier()
    const pending = execute(open)
    const request = await viewer.request()
    viewer.send("client.workbench.receipt", {
      requestId: request.requestId,
      outcome: { status: "applied", views: "invalid" },
    })
    await viewer.barrier()
    viewer.active(undefined, 2, 2)
    viewer.receipt(request.requestId)
    await viewer.barrier()
    expect((await pending).status).toBe("unknown")
    expect((await execute({ input: { action: "status", requestId: request.requestId } })).status).toBe("unknown")
  })
}, 20000)

test("applied requires the requested visible resource and hide requires the known view identity", async () => {
  await fixture(async ({ execute, connect }) => {
    const viewer = await connect()
    viewer.ready()
    viewer.active()
    await viewer.barrier()
    let settled = false
    const pending = execute(open).then((result) => {
      settled = true
      return result
    })
    const request = await viewer.request()
    const view: WorkbenchView.View = {
      viewId: "view:target",
      surface: "side",
      target: open.input.target,
      visible: true,
      contentState: "loading",
    }
    for (const views of [
      [],
      [{ ...view, visible: false }],
      [{ ...view, target: { kind: "note" as const, id: "other" } }],
    ]) {
      viewer.receipt(request.requestId, { status: "applied", views })
      await viewer.barrier()
      expect(settled).toBe(false)
    }
    viewer.receipt(request.requestId, {
      status: "applied",
      views: [{ ...view, target: { ...open.input.target, location: { kind: "heading", id: "different-location" } } }],
    })
    expect((await pending).status).toBe("applied")
    let hidden = false
    const hiding = execute({ input: { action: "hide", viewId: view.viewId } }).then((result) => {
      hidden = true
      return result
    })
    const hideRequest = await viewer.request(1)
    for (const views of [
      [],
      [view],
      [{ ...view, viewId: "wrong-view", visible: false }],
      [{ ...view, target: { kind: "note" as const, id: "other" }, visible: false }],
    ]) {
      viewer.receipt(hideRequest.requestId, { status: "applied", views })
      await viewer.barrier()
      expect(hidden).toBe(false)
    }
    viewer.receipt(hideRequest.requestId, { status: "applied", views: [{ ...view, visible: false }] })
    expect((await hiding).status).toBe("applied")
  })
}, 20000)
