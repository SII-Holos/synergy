import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { Session } from "@ericsanchezok/synergy-harness/session"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferWorkspaces as Files,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { registerWorkspace } from "../../src/register-workspace"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { NativeSessionTransferPhysical as Physical } from "../../src/session-transfer-physical"

test("native aggregate file capture requires its real physical callback and retains an immutable cold receipt", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  const rootPath = path.join(tmp.path, "files")
  await fs.mkdir(rootPath)
  await Bun.write(path.join(rootPath, "original"), "original current directory bytes")
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  let retained: { binding: Parameters<typeof Files.receipt>[0]; hash: string } | undefined
  {
    await using runtime = await testRuntime({
      home,
      register() {
        registerWorkspace(coordinator)
        Core.register()
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const workspace = await WorkspaceBinding.register("home", rootPath)
          const session = await Session.create({ workspaceID: workspace.id, environmentID: null })
          const binding = {
            sessionID: session.id,
            scopeID: "home",
            handoffID: "native-files-receipt",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          const signal = new AbortController().signal
          await expect(Files.capture({ binding, signal })).rejects.toThrow("capture")
          const values = new Map<string, Uint8Array>()
          let lease: Physical.Lease | undefined
          try {
            await Source.prepare({
              binding,
              signal,
              store: {
                async put(hash, bytes) {
                  values.set(hash, bytes.slice())
                },
                async get(hash) {
                  const bytes = values.get(hash)
                  if (!bytes) throw new Error("missing")
                  return bytes
                },
              },
              async verify() {},
              async beforeFreeze() {
                lease = await Physical.begin({ ...binding, rootSessionID: session.id })
                await Physical.withCapture(lease, async () => {
                  const capture = await Files.capture({ binding, signal })
                  expect(capture).toMatchObject({
                    members: 1,
                    workspaces: 1,
                    references: 1,
                    entries: 1,
                    bytes: Buffer.byteLength("original current directory bytes"),
                  })
                  expect(capture.hash).toMatch(/^[a-f0-9]{64}$/)
                  retained = { binding, hash: capture.hash }
                })
              },
            })
            expect((await Files.receipt(binding))?.hash).toBe(retained?.hash)
          } finally {
            if (lease) await Physical.release(lease)
          }
        },
      }),
    )
  }
  await fs.rm(rootPath, { recursive: true })
  await using reopened = await testRuntime({
    home,
    register() {
      registerWorkspace(coordinator)
      Core.register()
    },
  })
  await reopened.run(async () => {
    if (!retained) throw new Error("Expected actual retained file capture")
    expect((await Files.receipt(retained.binding))?.hash).toBe(retained.hash)
    await expect(Files.capture({ binding: retained.binding, signal: new AbortController().signal })).rejects.toThrow(
      "capture",
    )
  })
})
