import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionTransferCore as Core, SessionTransferSource as Source, SessionTransferWorkspaces as Files } from "@ericsanchezok/synergy-harness/session/transfer"
import { registerWorkspace } from "../../src/register-workspace"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { NativeSessionTransferPhysical as Physical } from "../../src/session-transfer-physical"

test("aborting native file capture exits a held artifact queue before its unrelated owner releases", async () => {
  await using tmp = await tmpdir()
  const rootPath = path.join(tmp.path, "files")
  await fs.mkdir(rootPath)
  await Bun.write(path.join(rootPath, "source.txt"), "immutable original source file")
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  await using runtime = await testRuntime({ register() { registerWorkspace(coordinator); Core.register() } })
  await runtime.run(() => ScopeContext.provide({ scope: Scope.home(), workspace: null, fn: async () => {
    const workspace = await WorkspaceBinding.register("home", rootPath)
    const session = await Session.create({ workspaceID: workspace.id, environmentID: null })
    const binding = { sessionID: session.id, scopeID: "home", handoffID: "cancel-native-files", sourceID: "source", targetID: "target", fromEpoch: 1, toEpoch: 2 }
    const acquired = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = Storage.withArtifactCheckpoint(async () => { acquired.resolve(); await release.promise })
    await acquired.promise
    const queued = Promise.withResolvers<void>()
    const abort = new AbortController()
    const reason = new Error("original native file capture cancelled")
    const values = new Map<string, Uint8Array>()
    let lease: Physical.Lease | undefined
    const prepare = Storage.prepareBinary
    const observed = spyOn(Storage, "prepareBinary").mockImplementation((...input) => { queued.resolve(); return prepare(...input) })
    const capture = Source.prepare({ binding, signal: abort.signal, store: { async put(hash, bytes) { values.set(hash, bytes.slice()) }, async get(hash) { const bytes = values.get(hash); if (!bytes) throw new Error("missing frame"); return bytes } }, async verify() {}, async beforeFreeze() { lease = await Physical.begin({ ...binding, rootSessionID: session.id }); await Physical.withCapture(lease, () => Files.capture({ binding, signal: abort.signal })) } })
    const finished = capture.then(() => ({ kind: "completed" as const }), error => ({ kind: "rejected" as const, error }))
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await queued.promise
      abort.abort(reason)
      const outcome = await Promise.race([finished, new Promise<{ kind: "blocked" }>(resolve => { timeout = setTimeout(() => resolve({ kind: "blocked" }), 1000) })])
      expect(outcome).toEqual({ kind: "rejected", error: reason })
      expect(await Files.receipt(binding)).toBeUndefined()
    } finally { if (timeout) clearTimeout(timeout); release.resolve(); await held; await finished; if (lease) await Physical.release(lease); observed.mockRestore() }
  } }))
})
