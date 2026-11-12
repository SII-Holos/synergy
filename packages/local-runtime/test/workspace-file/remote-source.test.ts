import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { z } from "zod"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceFileSource } from "@ericsanchezok/synergy-harness/workspace/file-source"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { WorkspaceErrors } from "@ericsanchezok/synergy-harness/workspace/errors"
import { WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NativeWorkspaceFiles } from "../../src/workspace/file-host"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { WorkspaceFileService as Files } from "../../src/workspace-file/service"
import { FileView } from "../../src/file/view"
import { ViewFileTool } from "../../src/tools/view-file"
import { SaveFileTool } from "../../src/tools/save-file"
import { EditTool } from "../../src/tools/edit"
import { testRuntime } from "../support/runtime"

async function fixture() {
  const temporary = await tmpdir()
  const directory = path.join(temporary.path, "remote")
  await fs.mkdir(directory)
  await Bun.write(path.join(directory, "note.txt"), "remote original\n")
  await fs.symlink("note.txt", path.join(directory, "link.txt"))
  const host = new NativeWorkspaceFiles({
    directory: path.join(temporary.path, "receipts"),
    materializationRoot: path.join(temporary.path, "materialized"),
    coordinator: new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") }),
    allowedRoots: [directory],
  })
  const Binding = z.strictObject({ version: z.literal(1), workspaceID: z.string(), generation: z.number() })
  let origin: ReturnType<typeof EnvironmentOrigin.registerHost>
  let accesses = 0,
    inspections = 0
  function register() {
    origin = EnvironmentOrigin.registerHost("remote-file-fixture")
    WorkspaceFileSource.register("remote-fixture", {
      async open(input) {
        if (input.binding !== undefined) {
          const binding = Binding.parse(input.binding)
          expect(binding.workspaceID).toBe(input.workspace.id)
          expect(binding.generation).toBe(input.workspace.binding.generation)
          inspections++
        } else {
          input.origin!.assertCurrent()
          accesses++
        }
        const reference = {
          id: input.workspace.id,
          workspaceID: input.workspace.id,
          generation: input.workspace.binding.generation,
        }
        await host.mount({ ...reference, readOnly: false, source: { kind: "directory", path: directory } })
        let open = true
        return {
          files: host,
          reference,
          directory: "/workspace",
          binding: { version: 1, workspaceID: reference.workspaceID, generation: reference.generation },
          assert() {
            if (!open) throw new Error("Remote fixture lease ended")
          },
          async release() {
            open = false
          },
        }
      },
    })
  }
  return {
    temporary,
    directory,
    host,
    register,
    origin: () => origin.capture("file-invocation"),
    counts: () => ({ accesses, inspections }),
    async [Symbol.asyncDispose]() {
      await host.close()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

test("a remote file lease retains call-time inputs and bytes before deferred native work", async () => {
  await using f = await fixture()
  await using runtime = await testRuntime({ register: f.register })
  await runtime.run(async () => {
    const workspace = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "remote-fixture", spec: {} },
    })
    const lease = await WorkspaceFileSource.open({
      workspace,
      origin: EnvironmentOrigin.selected(f.origin()),
    })
    try {
      const write: WorkspaceProtocol.WriteInput = {
        id: "call-time-write",
        mount: { ...lease.reference },
        path: "original.txt",
        data: Buffer.from("original bytes").toString("base64"),
        expectedVersion: null,
      }
      const writing = lease.files.write(write)
      write.path = "changed.txt"
      write.data = Buffer.from("changed bytes").toString("base64")
      write.mount.generation++
      await writing
      expect(await Bun.file(path.join(f.directory, "original.txt")).text()).toBe("original bytes")
      expect(await Bun.file(path.join(f.directory, "changed.txt")).exists()).toBe(false)
      await lease.files.acknowledge("call-time-write")

      const read: WorkspaceProtocol.ReadInput = {
        mount: { ...lease.reference },
        path: "note.txt",
        offset: 0,
        maximumBytes: 6,
      }
      const reading = lease.files.read(read)
      read.path = "missing.txt"
      read.maximumBytes = 0
      read.mount.workspaceID = "another-workspace"
      expect(Buffer.from((await reading).data, "base64").toString()).toBe("remote")

      const entry = await lease.files.stat(lease.reference, "note.txt")
      const change: Extract<WorkspaceProtocol.Change, { kind: "copy" }> = {
        kind: "copy",
        from: "note.txt",
        to: "copied.txt",
        expectedVersion: entry!.entryVersion,
      }
      const mutation: WorkspaceProtocol.ChangeInput = {
        id: "call-time-copy",
        mount: { ...lease.reference },
        change,
      }
      const copying = lease.files.mutate(mutation)
      change.from = "missing.txt"
      change.to = "changed-copy.txt"
      change.expectedVersion = "changed-version"
      mutation.mount.generation++
      await copying
      expect(await Bun.file(path.join(f.directory, "copied.txt")).text()).toBe("remote original\n")
      expect(await Bun.file(path.join(f.directory, "note.txt")).text()).toBe("remote original\n")
      await lease.files.acknowledge("call-time-copy")

      const backing = new SharedArrayBuffer(16)
      const bytes = Buffer.from(backing).subarray(1, -1)
      bytes.write("call-time blob")
      const hash = createHash("sha256").update(bytes).digest("hex")
      const putting = lease.files.putBlob(hash, bytes)
      bytes.fill(0)
      await putting
      expect(Buffer.from(await lease.files.getBlob(hash, 100)).toString()).toBe("call-time blob")
    } finally {
      await lease.release()
    }
  })
}, 15000)

test("ordinary file tools and the file service use a dormant remote owner without local content or compute", async () => {
  await using f = await fixture()
  await using runtime = await testRuntime({ register: f.register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({
          scopeID: "home",
          backend: { provider: "remote-fixture", spec: {} },
        })
        await using resources = await EnvironmentResources.resolve({
          scopeID: "home",
          workspaceID: workspace.id,
          origin: f.origin(),
          needs: { workspace: true },
        })
        expect(resources.kind).toBe("files")
        expect(resources.environment).toBeUndefined()
        expect(resources.executor).toBeUndefined()
        const context = {
          sessionID: "remote-fixture",
          messageID: "message",
          agent: "fixture",
          abort: AbortSignal.any([]),
          ask: async () => {},
          metadata() {},
          resources,
        }
        const read = await (await ViewFileTool.init()).execute({ filePath: "note.txt" }, { ...context, callID: "read" })
        expect(read.output).toContain("remote original")
        await (
          await EditTool.init()
        ).execute(
          { filePath: "note.txt", oldString: "remote original", newString: "remote edited" },
          { ...context, callID: "edit" },
        )
        await (
          await SaveFileTool.init()
        ).execute({ filePath: "new.txt", content: "new remote file\n" }, { ...context, callID: "create" })
        await EnvironmentResources.provide(resources, "browse", async () => {
          expect((await Files.children({ path: "" })).children.map((item) => item.name)).toEqual([
            "link.txt",
            "new.txt",
            "note.txt",
          ])
          expect((await FileView.stat("link.txt"))?.kind).toBe("symlink")
          expect(new TextDecoder().decode(await FileView.bytes("link.txt"))).toBe("remote edited\n")
          await expect(FileView.write(".env", Buffer.from("secret"), null, undefined, true)).rejects.toThrow()
          await expect(
            FileView.write("note.txt", Buffer.from("stale"), "sha256:" + "f".repeat(64), undefined, true, "conflict"),
          ).rejects.toThrow("changed")
          const recorded = await WorkspaceOperations.get("conflict", "home")
          expect(recorded.input).toMatchObject({ kind: "files-write", version: 1 })
          expect(() =>
            WorkspaceOperations.Info.parse({ ...recorded, input: { ...recorded.input, version: 2 } }),
          ).toThrow()
          using _rejected = spyOn(f.host, "write").mockImplementationOnce(async () => {
            throw new WorkspaceFileSource.Rejected(WorkspaceErrors.failure(new WorkspaceErrors.ConflictError()))
          })
          await expect(
            FileView.write("rejected.txt", Buffer.from("none"), null, undefined, true, "known-rejected"),
          ).rejects.toBeInstanceOf(WorkspaceErrors.ConflictError)
          expect((await WorkspaceOperations.get("known-rejected", "home")).state).toBe("failed")
          expect(await Bun.file(path.join(f.directory, "rejected.txt")).exists()).toBe(false)
        })
        expect(await Bun.file(path.join(f.directory, "note.txt")).text()).toBe("remote edited\n")
        expect(await Bun.file(path.join(f.directory, "new.txt")).text()).toBe("new remote file\n")
        const local = await WorkspaceCatalog.get(workspace.id, "home")
        expect(local.binding.path).toBeNull()
        expect(local.activeMount).toBeUndefined()
        expect(local.content?.manifest).toBeNull()
        expect(local.content?.revision).toBe(0)
        expect(await WorkspaceOperations.listActive("home")).toEqual([])
        const files = resources.files!
        const stat = f.host.stat.bind(f.host)
        const entered = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        using _held = spyOn(f.host, "stat").mockImplementationOnce(async (...args) => {
          entered.resolve()
          await resume.promise
          return stat(...args)
        })
        const reading = files.files.stat(files.reference, "note.txt")
        void reading.catch(() => {})
        await entered.promise
        let closed = false
        const closing = resources.release().then(() => {
          closed = true
        })
        await Promise.resolve()
        expect(closed).toBe(false)
        resume.resolve()
        await expect(reading).rejects.toThrow("ended")
        await closing
        await expect(files.files.stat(files.reference, "note.txt")).rejects.toThrow("ended")
      },
    }),
  )
}, 15000)

test("a lost remote mutation acknowledgement reconciles the original receipt on cold Runtime without replay", async () => {
  await using f = await fixture()
  const home = path.join(f.temporary.path, "member")
  const first = await testRuntime({ home, register: f.register })
  let workspaceID = ""
  let dispatches = 0
  const write = f.host.write.bind(f.host)
  using lost = spyOn(f.host, "write").mockImplementation(async (input) => {
    dispatches++
    await write(input)
    throw new Error("Remote write response lost")
  })
  try {
    await first.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const workspace = await WorkspaceCatalog.create({
            scopeID: "home",
            backend: { provider: "remote-fixture", spec: {} },
          })
          workspaceID = workspace.id
          await using resources = await EnvironmentResources.resolve({
            scopeID: "home",
            workspaceID,
            origin: f.origin(),
            needs: { workspace: true },
          })
          await expect(
            EnvironmentResources.provide(resources, "lost", () =>
              FileView.write("one.txt", Buffer.from("once"), null, undefined, true, "fixed-operation"),
            ),
          ).rejects.toThrow("lost")
          expect((await WorkspaceOperations.get("fixed-operation", "home")).state).toBe("unknown")
        },
      }),
    )
  } finally {
    await first.close()
  }
  lost.mockRestore()
  await using cold = await testRuntime({ home, register: f.register })
  await cold.run(async () => {
    expect((await WorkspaceOperations.reconcile("fixed-operation", "home")).state).toBe("completed")
    expect(await WorkspaceOperations.listActive("home")).toEqual([])
    expect((await WorkspaceCatalog.get(workspaceID, "home")).content?.manifest).toBeNull()
    expect(dispatches).toBe(1)
    expect(f.counts().inspections).toBeGreaterThan(0)
    expect(await Bun.file(path.join(f.directory, "one.txt")).text()).toBe("once")
  })
}, 15000)

test("an absent remote receipt remains uncertain after cold inspection and never dispatches the original write again", async () => {
  await using f = await fixture()
  const home = path.join(f.temporary.path, "member")
  const first = await testRuntime({ home, register: f.register })
  let workspaceID = ""
  let dispatched = 0
  using _missing = spyOn(f.host, "write").mockImplementation(async () => {
    dispatched++
    throw new Error("Original remote delivery is uncertain")
  })
  try {
    await first.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const workspace = await WorkspaceCatalog.create({
            scopeID: "home",
            backend: { provider: "remote-fixture", spec: {} },
          })
          workspaceID = workspace.id
          await using resources = await EnvironmentResources.resolve({
            scopeID: "home",
            workspaceID,
            origin: f.origin(),
            needs: { workspace: true },
          })
          await expect(
            EnvironmentResources.provide(resources, "missing", () =>
              FileView.write("pending.txt", Buffer.from("same body"), null, undefined, true, "original-missing"),
            ),
          ).rejects.toThrow("uncertain")
          expect((await WorkspaceOperations.get("original-missing", "home")).state).toBe("unknown")
        },
      }),
    )
  } finally {
    await first.close()
  }
  await using cold = await testRuntime({ home, register: f.register })
  await cold.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        expect((await WorkspaceOperations.reconcile("original-missing", "home")).state).toBe("unknown")
        await using resources = await EnvironmentResources.resolve({
          scopeID: "home",
          workspaceID,
          origin: f.origin(),
          needs: { workspace: true },
        })
        await EnvironmentResources.provide(resources, "retry", async () => {
          await expect(
            FileView.write("pending.txt", Buffer.from("same body"), null, undefined, true, "original-missing"),
          ).rejects.toThrow("uncertain")
          await expect(
            FileView.write("pending.txt", Buffer.from("different"), null, undefined, true, "original-missing"),
          ).rejects.toThrow("different input")
        })
        expect(dispatched).toBe(1)
        expect(await Bun.file(path.join(f.directory, "pending.txt")).exists()).toBe(false)
        expect(await WorkspaceOperations.listActive("home")).toHaveLength(1)
        expect(f.counts().inspections).toBeGreaterThan(0)
      },
    }),
  )
}, 15000)
