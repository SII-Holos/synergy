import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { WorkbenchPresentation } from "../../src/presentation/service"
import { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"
import { RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import path from "node:path"

const parameters: WorkbenchView.Parameters = { input: { action: "open", target: { kind: "note", id: "nte_fixture" } } }
const caller = { scopeID: "home", sessionID: "ses_fixture", requestId: "request_fixture", signal: AbortSignal.any([]) }

test("broker unit: a failed send is unknown and is never retried", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const frames: WorkbenchView.ServerMessage[] = []
    const connection = WorkbenchPresentation.contribution().connect({
      clientId: "fixture",
      send(frame) {
        frames.push(WorkbenchView.ServerMessage.parse(frame.payload))
        return false
      },
    })
    connection.receive({ type: "client.workbench.ready", properties: { version: 1, targets: ["note"] } })
    connection.active({ scopeID: "home", sessionID: "ses_fixture", generation: 1 })
    const result = await WorkbenchPresentation.request(parameters, caller)
    expect(result.status).toBe("unknown")
    expect(await WorkbenchPresentation.request(parameters, caller)).toEqual(result)
    expect(frames.map((frame) => frame.type)).toEqual(["server.workbench.request", "server.workbench.cancel"])
    frames.length = 0
    const expired = await WorkbenchPresentation.request(
      { ...parameters, timeoutSeconds: Number.MIN_VALUE },
      { ...caller, requestId: "expired-before-send" },
    )
    expect(expired.status).toBe("unknown")
    expect(frames.filter((frame) => frame.type === "server.workbench.request")).toEqual([])
    connection.dispose()
  })
}, 20000)

test("broker unit: Runtime close settles an unacknowledged long-window request and clears receipts", async () => {
  let dispose: (() => void) | undefined
  await using home = await runtimeHome()
  await using runtime = await RuntimeHandle.open({
    host: home.host,
    mode: "server",
    storage: {
      kind: "owned",
      async open() {
        const store = await TransactionalStore.open({
          backend: "sqlite",
          filename: path.join(home.host.root, "authority.sqlite"),
          namespace: "test",
        })
        return {
          handle: { store, artifactDirectory: path.join(home.host.root, "data") },
          needsValidation: false,
          async activate() {},
        }
      },
    },
    composition: {
      register() {},
      services: () => ({
        resident: {
          async start() {
            dispose = WorkbenchPresentation.init()
          },
          async stop() {
            dispose?.()
          },
        },
      }),
    },
  })
  const frames: WorkbenchView.ServerMessage[] = []
  let pending: Promise<WorkbenchView.Result> | undefined
  await runtime.run(async () => {
    const connection = WorkbenchPresentation.contribution().connect({
      clientId: "fixture",
      send(frame) {
        frames.push(WorkbenchView.ServerMessage.parse(frame.payload))
        return true
      },
    })
    connection.receive({ type: "client.workbench.ready", properties: { version: 1, targets: ["note"] } })
    connection.active({ scopeID: "home", sessionID: "ses_fixture", generation: 1 })
    pending = WorkbenchPresentation.request({ ...parameters, timeoutSeconds: 3_000_000 }, caller)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Bun.sleep(10)
    expect(settled).toBe(false)
    expect(frames.map((frame) => frame.type)).toEqual(["server.workbench.request"])
  })
  await runtime.close()
  expect((await pending!).status).toBe("unknown")
  expect(frames.map((frame) => frame.type)).toEqual(["server.workbench.request", "server.workbench.cancel"])
}, 20000)

test("broker unit: identical request identities in independent Runtimes share no clients or receipts", async () => {
  await using first = await testRuntime()
  await using second = await testRuntime()
  await first.run(async () => {
    const connection = WorkbenchPresentation.contribution().connect({ clientId: "fixture", send: () => true })
    connection.receive({ type: "client.workbench.ready", properties: { version: 1, targets: ["note"] } })
    connection.active({ scopeID: "home", sessionID: "ses_fixture", generation: 1 })
    const pending = WorkbenchPresentation.request(parameters, caller)
    connection.receive({
      type: "client.workbench.receipt",
      properties: {
        requestId: caller.requestId,
        outcome: {
          status: "applied",
          views: [
            {
              viewId: "note",
              target:
                parameters.input.action === "open" ? parameters.input.target : { kind: "note", id: "nte_fixture" },
              surface: "side",
              visible: true,
              contentState: "ready",
            },
          ],
        },
      },
    })
    expect((await pending).status).toBe("applied")
    const status: WorkbenchView.Parameters = { input: { action: "status", requestId: caller.requestId } }
    expect((await second.run(() => WorkbenchPresentation.request(status, caller))).status).toBe("unknown")
    expect((await second.run(() => WorkbenchPresentation.request(parameters, caller))).status).toBe("unavailable")
    expect((await WorkbenchPresentation.request(status, caller)).status).toBe("applied")
    connection.dispose()
    expect((await WorkbenchPresentation.request(status, caller)).status).toBe("unknown")
  })
}, 20000)
