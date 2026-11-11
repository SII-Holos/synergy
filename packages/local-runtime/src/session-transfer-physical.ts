import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { initializeSqliteEngine } from "@ericsanchezok/synergy-harness/storage/sqlite-engine"
import { Session } from "@ericsanchezok/synergy-harness/session"
import {
  SessionTransferEpochs as Epochs,
  SessionTransferSource as Source,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { Global } from "@ericsanchezok/synergy-harness/global"
import type { WorkspaceCoordinator } from "./workspace/coordinator"
import { NativeProcessMaintenance } from "./process/maintenance"

export namespace NativeSessionTransferPhysical {
  const Input = z.strictObject({
    sessionID: z.string().min(1),
    rootSessionID: z.string().min(1),
    scopeID: z.string().min(1),
    handoffID: z.string().min(1),
    sourceID: z.string().min(1),
    fromEpoch: z.number().int().positive().safe(),
    targetID: z.string().min(1).optional(),
    toEpoch: z.number().int().positive().safe().optional(),
  })
  export type Input = z.infer<typeof Input>
  export interface Lease {
    readonly kind: "session-physical-source"
  }
  interface Held {
    runtime: RuntimeContext.Instance
    store: Storage.Handle["store"]
    binding: Epochs.Binding
    writer: ServerProcessLock.Ownership
    coordinator: WorkspaceCoordinator
    signal: AbortSignal
    phase: "pending" | "capturing" | "captured" | "releasing" | "released"
    claims: Map<string, WorkspaceAccess.Lease>
    database?: Database
    directory?: string
  }
  const state = RuntimeContext.state(() => ({ coordinator: undefined as WorkspaceCoordinator | undefined }))
  const held = new WeakMap<Lease, Held>()
  const context = RuntimeContext.createAsyncContext<{ owner: Held; open: boolean }>()
  function fail(message: string): never {
    throw new Error("Session physical transfer " + message)
  }
  function coveringRoot(roots: { has(root: string): boolean }, selected: string): string | undefined {
    for (let current = selected; ;) {
      if (roots.has(current)) return current
      const parent = path.dirname(current)
      if (parent === current) return
      current = parent
    }
  }
  function selected(lease: Lease) {
    const owner = held.get(lease)
    if (!owner) fail("requires its original opaque native lease")
    if (owner.runtime !== RuntimeContext.current() || owner.store !== Storage.current().store)
      fail("belongs to another Runtime or namespace")
    if (owner.phase === "released" || owner.phase === "releasing") fail("lease has been released")
    if (owner.coordinator !== state().coordinator) fail("native coordination owner changed")
    return owner
  }
  function same(actual: Epochs.Binding, expected: Epochs.Binding) {
    return Object.keys(Epochs.Binding.shape).every(
      (key) => actual[key as keyof Epochs.Binding] === expected[key as keyof Epochs.Binding],
    )
  }
  async function preparation(owner: Held) {
    owner.signal.throwIfAborted()
    const actual = await Epochs.ownerPreparationBinding({
      sessionID: owner.binding.sessionID,
      handoffID: owner.binding.handoffID,
    })
    if (!same(actual, owner.binding)) fail("binding changed")
    await ServerProcessLock.verifyOwnership(owner.writer)
  }
  export function register(coordinator: WorkspaceCoordinator) {
    RuntimeContext.assertCompositionOpen("Native Session physical transfer")
    if (state().coordinator) fail("is already registered")
    state().coordinator = coordinator
  }
  export async function begin(value: Input, options: { signal?: AbortSignal } = {}): Promise<Lease> {
    if (Storage.inTransaction()) fail("native preparation must run outside SQL transactions")
    const input = Input.parse(value)
    options.signal?.throwIfAborted()
    const coordinator = state().coordinator
    if (!coordinator) fail("has no native coordination owner")
    const binding = await Epochs.ownerPreparationBinding({ sessionID: input.sessionID, handoffID: input.handoffID })
    if (
      input.rootSessionID !== input.sessionID ||
      (binding.rootSessionID ?? binding.sessionID) !== input.rootSessionID ||
      ["scopeID", "sourceID", "fromEpoch", "targetID", "toEpoch"].some(
        (key) =>
          input[key as keyof Input] !== undefined && input[key as keyof Input] !== binding[key as keyof Epochs.Binding],
      )
    )
      fail("requires the exact canonical root source binding")
    const root = await Session.get(input.sessionID)
    if (root.scope.id !== input.scopeID) fail("root belongs to another Scope")
    const writer = await ServerProcessLock.currentOwnership()
    const lease = Object.freeze({ kind: "session-physical-source" as const })
    held.set(lease, {
      runtime: RuntimeContext.current(),
      store: Storage.current().store,
      binding,
      writer,
      coordinator,
      signal: options.signal ?? new AbortController().signal,
      phase: "pending",
      claims: new Map(),
    })
    return lease
  }
  async function clear(owner: Held) {
    const outcomes = await Promise.allSettled([...new Set(owner.claims.values())].map((claim) => claim.release()))
    const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Native Session physical claims could not be released")
    owner.claims.clear()
    owner.database?.close(true)
    owner.database = undefined
    if (owner.directory) await fs.rm(owner.directory, { recursive: true, force: true })
    owner.directory = undefined
  }
  async function inventory(owner: Held) {
    await initializeSqliteEngine()
    await fs.mkdir(Global.Path.data, { recursive: true })
    owner.directory = await fs.mkdtemp(path.join(Global.Path.data, "session-physical-"))
    const database = (owner.database = new Database(path.join(owner.directory, "cohort.sqlite"), { create: true }))
    database.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE members(id TEXT PRIMARY KEY,parent TEXT,workspace TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT NOT NULL,generation INTEGER NOT NULL)",
    )
    using insert = database.prepare("INSERT INTO members(id,parent,workspace) VALUES(?,?,?)")
    using workspace = database.prepare("INSERT OR IGNORE INTO workspaces(id,path,generation) VALUES(?,?,?)")
    let root = false
    for await (const member of Source.members(owner.binding, owner.signal)) {
      const source = await Epochs.ownerPreparationBinding({
        sessionID: member.binding.sessionID,
        handoffID: owner.binding.handoffID,
      })
      if (!same(source, member.binding)) fail("cohort has a different native source binding")
      const session = await Session.get(source.sessionID)
      if (session.scope.id !== owner.binding.scopeID) fail("cohort crosses its canonical Scope")
      root ||= session.id === owner.binding.sessionID
      insert.run(session.id, session.parentID ?? null, session.workspaceID ?? null)
      if (!session.workspaceID) {
        if (session.workspace) fail("Session Workspace has no canonical reference")
        continue
      }
      const info = await WorkspaceCatalog.get(session.workspaceID, source.scopeID)
      const binding = await WorkspaceBinding.validate(info.id, info.scopeID, info.binding.generation)
      workspace.run(info.id, await fs.realpath(binding.path), info.binding.generation)
    }
    if (!root) fail("requires the actual prepared source cohort")
    using parent = database.prepare<{ parent: string | null }, [string]>("SELECT parent FROM members WHERE id=?")
    using rows = database.prepare<{ id: string }, []>("SELECT id FROM members ORDER BY id")
    for (const row of rows.iterate()) {
      owner.signal.throwIfAborted()
      const visited = new Set<string>()
      let current = row.id
      while (current !== owner.binding.sessionID) {
        if (visited.has(current)) fail("cohort has cyclic native ancestry")
        visited.add(current)
        const next = parent.get(current)?.parent
        if (!next) fail("cohort has an unrelated native owner")
        current = next
      }
      for await (const child of Session.childIndexEntries(owner.binding.scopeID, row.id, owner.signal))
        if (!parent.get(child.id)) fail("cohort changed before physical capture")
    }
  }
  async function validateInventory(owner: Held) {
    const database = owner.database!
    using member = database.prepare<{ id: string }, [string]>("SELECT id FROM members WHERE id=?")
    await NativeProcessMaintenance.drainSessions((id) => !!member.get(id), owner.signal)
    using rows = database.prepare<{ id: string; parent: string | null; workspace: string | null }, []>(
      "SELECT id,parent,workspace FROM members ORDER BY id",
    )
    for (const row of rows.iterate()) {
      owner.signal.throwIfAborted()
      const session = await Session.get(row.id)
      if (
        session.scope.id !== owner.binding.scopeID ||
        (session.parentID ?? null) !== row.parent ||
        (session.workspaceID ?? null) !== row.workspace
      )
        fail("canonical Session ownership changed during physical drainage")
      for await (const child of Session.childIndexEntries(owner.binding.scopeID, row.id, owner.signal))
        if (!member.get(child.id)) fail("cohort changed during physical drainage")
    }
    using roots = database.prepare<{ id: string; path: string; generation: number }, []>(
      "SELECT id,path,generation FROM workspaces ORDER BY id",
    )
    for (const root of roots.iterate()) {
      const current = await WorkspaceBinding.validate(root.id, owner.binding.scopeID, root.generation)
      if ((await fs.realpath(current.path)) !== root.path) fail("Workspace physical binding changed during capture")
    }
  }
  async function drain(owner: Held) {
    const database = owner.database!
    using member = database.prepare<{ id: string }, [string]>("SELECT id FROM members WHERE id=?")
    await NativeProcessMaintenance.drainSessions((id) => !!member.get(id), owner.signal)
    await WorkspaceAccess.drainSessionClaims((id) => !!member.get(id), owner.signal)
    for (const claim of await owner.coordinator.inspect()) {
      owner.signal.throwIfAborted()
      if (claim.kind === "use") continue
      for (const value of [claim.owner, ...claim.ancestors]) {
        let parsed: unknown
        try {
          parsed = JSON.parse(value)
        } catch {
          continue
        }
        if (
          Array.isArray(parsed) &&
          parsed.length === 2 &&
          typeof parsed[1] === "string" &&
          !!member.get(parsed[1]) &&
          (await NativeProcessMaintenance.belongsToHome(value))
        )
          fail("found a retained native writer outside this installed Runtime's acknowledged claims")
      }
    }
  }
  export async function withCapture<T>(lease: Lease, body: () => Promise<T>): Promise<T> {
    if (Storage.inTransaction()) fail("physical drainage and capture must run outside SQL transactions")
    const owner = selected(lease)
    if (owner.phase === "capturing") fail("capture is already in progress")
    const reuse = owner.phase === "captured"
    owner.phase = "capturing"
    const frame = { owner, open: false }
    try {
      await preparation(owner)
      if (!reuse) {
        await inventory(owner)
        await drain(owner)
        await validateInventory(owner)
        using roots = owner.database!.prepare<{ path: string }, []>(
          "SELECT DISTINCT path FROM workspaces ORDER BY path",
        )
        const paths = new Set<string>()
        for (const root of roots.iterate()) {
          owner.signal.throwIfAborted()
          if (coveringRoot(paths, root.path)) continue
          paths.add(root.path)
        }
        if (paths.size) {
          const claim = await WorkspaceAccess.maintenance(
            () =>
              WorkspaceAccess.hostClaim({
                id: crypto.randomUUID(),
                kind: "exclusive",
                roots: [...paths],
                signal: owner.signal,
                timeoutMs: 1000,
              }),
            { signal: owner.signal },
          )
          for (const root of paths) owner.claims.set(root, claim)
        }
        await preparation(owner)
      } else {
        for (const claim of new Set(owner.claims.values()))
          if (await claim.isReleased!()) fail("native geometry was released")
      }
      await validateInventory(owner)
      frame.open = true
      const result = await context.run(frame, body)
      frame.open = false
      owner.signal.throwIfAborted()
      await validateInventory(owner)
      await preparation(owner)
      owner.phase = "captured"
      return result
    } catch (error) {
      owner.phase = "releasing"
      try {
        await clear(owner)
      } catch (failure) {
        throw new AggregateError([error, failure], "Native Session physical capture and cleanup failed")
      }
      owner.phase = "pending"
      throw error
    } finally {
      frame.open = false
    }
  }
  export async function withWorkspaceClaim<T>(workspaceID: string, body: () => Promise<T>): Promise<T> {
    const frame = context.getStore()
    if (!frame) return body()
    if (
      !frame.open ||
      frame.owner.runtime !== RuntimeContext.current() ||
      frame.owner.store !== Storage.current().store
    )
      fail("capture callback has ended or belongs to another Runtime or namespace")
    const owner = frame.owner
    using find = owner.database!.prepare<{ path: string; generation: number }, [string]>(
      "SELECT path,generation FROM workspaces WHERE id=?",
    )
    const root = find.get(workspaceID)
    if (!root) fail("Workspace is outside the selected native source cohort")
    const current = await WorkspaceBinding.validate(workspaceID, owner.binding.scopeID, root.generation)
    if ((await fs.realpath(current.path)) !== root.path) fail("Workspace physical binding changed")
    const covering = coveringRoot(owner.claims, root.path)
    const claim = covering ? owner.claims.get(covering) : undefined
    if (!claim) fail("has no retained native Workspace geometry")
    return WorkspaceAccess.withExclusiveClaim(
      claim,
      async () => {
        if (!frame.open || owner.phase !== "capturing") fail("capture callback has ended")
        return body()
      },
      owner.signal,
    )
  }
  export function assertCurrent(lease: Lease) {
    const owner = selected(lease)
    owner.signal.throwIfAborted()
    ServerProcessLock.assertCurrent(owner.writer)
    if (owner.phase !== "captured") fail("has not completed native drainage and capture")
  }
  export function describe(lease: Lease) {
    const owner = selected(lease)
    return Object.freeze({
      ...owner.binding,
      rootSessionID: owner.binding.sessionID,
      phase: owner.phase,
      workspaces: owner.claims.size,
    })
  }
  export async function release(lease: Lease) {
    const owner = held.get(lease)
    if (!owner) fail("requires its original opaque native lease")
    if (owner.runtime !== RuntimeContext.current() || owner.store !== Storage.current().store)
      fail("belongs to another Runtime or namespace")
    if (owner.phase === "released") return
    if (owner.phase === "capturing") fail("cannot release an active capture callback")
    owner.phase = "releasing"
    await clear(owner)
    owner.phase = "released"
  }
}
