import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { NativeExecutor } from "../../src/environment/native-executor"
import { ExecutionHost } from "../../src/environment/host"
import { RemoteExecutor } from "../../src/environment/remote-executor"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { z } from "zod"
import { NativeFileMutation } from "../../src/file/mutation-core"

const Socket = WebSocket as unknown as { new (url: URL, options: Bun.WebSocketOptions): WebSocket }

test("authenticated execution transport uses the native handler and replays output by cursor", async () => {
  await using tmp = await tmpdir()
  const target = { environmentID: "environment", allocationID: "allocation", generation: 1 }
  await using executor = await NativeExecutor.open({
    target,
    directory: path.join(tmp.path, "receipts"),
    coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") }),
  })
  await using host = ExecutionHost.listen({
    executor,
    target,
    token: "test-token-with-at-least-thirty-two-bytes",
    listen: { hostname: "127.0.0.1", port: 0 },
  })
  const remote = new RemoteExecutor({ url: host.url, target, token: "test-token-with-at-least-thirty-two-bytes" })
  const description = await remote.describe()
  expect(description).toEqual(await executor.describe())
  expect(description.target).toEqual(target)
  expect(description.platform).toBe(process.platform)
  expect(description.env).not.toHaveProperty("SYNERGY_EXECUTION_TOKEN")
  const staged = await remote.prepareInputs({
    id: "operation",
    files: [{ name: "note.md", data: Buffer.from("A remote note").toString("base64") }],
  })
  expect(await Bun.file(staged.paths["note.md"]).text()).toBe("A remote note")
  await expect(
    remote.prepareInputs({ id: "operation", files: [{ name: "note.md", data: "b3RoZXI=" }] }),
  ).rejects.toThrow("different input")
  expect((await fetch(new URL("/v1/status", host.url))).status).toBe(401)
  const mount = await remote.files.mount({
    id: "files",
    workspaceID: "workspace",
    generation: 1,
    readOnly: false,
    source: { kind: "directory", path: tmp.path },
  })
  await remote.files.write({ id: "write-file", mount, path: "file", data: "b25jZQ==", expectedVersion: null })
  await remote.files.acknowledge("write-file")
  await expect(
    remote.files.write({ id: "conflicting-file", mount, path: "file", data: "dHdpY2U=", expectedVersion: null }),
  ).rejects.toBeInstanceOf(NativeFileMutation.ConflictError)
  const wrong = new RemoteExecutor({
    url: host.url,
    target: { ...target, generation: 2 },
    token: "test-token-with-at-least-thirty-two-bytes",
  })
  await expect(wrong.status("operation")).rejects.toThrow("409")
  const command = {
    command: process.execPath,
    args: ["-e", "process.stdout.write('remote'); process.stderr.write('error')"],
    cwd: tmp.path,
    env: {},
    writableRoots: [],
  }
  const request = { id: "operation", target, command, digest: ExecutionProtocol.digest(command) }
  await remote.start(request)
  await expect(remote.discardInputs(request.id)).rejects.toThrow("retained")
  let status = await remote.status(request.id)
  for (let attempt = 0; status && !ExecutionProtocol.terminal(status) && attempt < 400; attempt++) {
    await Bun.sleep(10)
    status = await remote.status(request.id)
  }
  expect(status?.state).toBe("exited")
  const chunks = await remote.output(request.id, 0, 128)
  expect(chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString()).sort()).toEqual(["error", "remote"])
  expect(await remote.output(request.id, chunks[0].cursor, 128)).toEqual(chunks.slice(1))
  const events = await fetch(new URL(`/v1/operations/${request.id}/events?after=${chunks[0].cursor}`, host.url), {
    headers: {
      authorization: "Bearer test-token-with-at-least-thirty-two-bytes",
      "x-synergy-target": JSON.stringify(target),
    },
  })
  const replay = await events.text()
  expect(replay).toContain("event: status")
  expect(replay).not.toContain(`id: ${chunks[0].cursor}\n`)
  await remote.release(request.id)
  expect(await Bun.file(staged.paths["note.md"]).exists()).toBe(false)
}, 30_000)

test.skipIf(process.platform === "win32")(
  "Unix transport follows the same protocol without a TCP listener",
  async () => {
    await using tmp = await tmpdir()
    const target = { environmentID: "environment", allocationID: "allocation", generation: 1 }
    await using executor = await NativeExecutor.open({
      target,
      directory: path.join(tmp.path, "receipts"),
      coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") }),
    })
    const unix = path.join(tmp.path, "socket")
    await using host = ExecutionHost.listen({
      executor,
      target,
      token: "test-token-with-at-least-thirty-two-bytes",
      listen: { unix },
    })
    const remote = new RemoteExecutor({
      url: "http://localhost",
      unix,
      target,
      token: "test-token-with-at-least-thirty-two-bytes",
    })
    expect((await remote.health()).target).toEqual(target)
  },
)

test("duplex transport preserves binary input and output, and disconnect does not cancel execution", async () => {
  await using tmp = await tmpdir()
  const target = { environmentID: "environment", allocationID: "allocation", generation: 1 }
  const token = "test-token-with-at-least-thirty-two-bytes"
  await using executor = await NativeExecutor.open({
    target,
    directory: path.join(tmp.path, "receipts"),
    coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") }),
  })
  await using host = ExecutionHost.listen({ executor, target, token, listen: { hostname: "127.0.0.1", port: 0 } })
  const remote = new RemoteExecutor({ url: host.url, target, token })
  const command = {
    command: process.execPath,
    args: ["-e", "for await (const chunk of Bun.stdin.stream()) process.stdout.write(chunk)"],
    cwd: tmp.path,
    env: {},
    writableRoots: [],
  }
  await remote.start({ id: "binary", target, command, digest: ExecutionProtocol.digest(command) })
  for (let i = 0; (await remote.status("binary"))?.state !== "running" && i < 300; i++) await Bun.sleep(10)
  const url = new URL("/v1/operations/binary/duplex", host.url)
  url.protocol = "ws:"
  const headers = { authorization: `Bearer ${token}`, "x-synergy-target": JSON.stringify(target) }
  const disconnected = new Socket(url, { headers })
  await new Promise<void>((resolve, reject) => {
    disconnected.onopen = () => {
      disconnected.close()
      resolve()
    }
    disconnected.onerror = reject
  })
  expect((await remote.status("binary"))?.state).toBe("running")
  const bytes = Buffer.alloc(32_768)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256
  const received: Buffer[] = []
  const done = Promise.withResolvers<void>()
  const socket = new Socket(url, { headers })
  socket.binaryType = "arraybuffer"
  socket.onopen = () => {
    socket.send(bytes)
    socket.send(JSON.stringify({ type: "end" }))
  }
  socket.onerror = done.reject
  socket.onclose = (event) => done.reject(new Error(`Socket closed: ${event.code} ${event.reason}`))
  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      expect(
        z.object({ type: z.literal("status"), status: ExecutionProtocol.Status }).parse(JSON.parse(event.data)).status
          .exitCode,
      ).toBe(0)
      done.resolve()
    } else received.push(Buffer.from(event.data).subarray(9))
  }
  try {
    await done.promise
    expect(Buffer.concat(received)).toEqual(bytes)
    await remote.release("binary")
    await host.stop()
    await executor.close()
  } finally {
    socket.close()
  }
}, 30_000)

test.skipIf(process.platform !== "darwin")(
  "sandbox preparation and release stay on the selected execution host",
  async () => {
    const { testRuntime } = await import("../support/runtime")
    const { SandboxBackend } = await import("../../src/sandbox/backend")
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir()
      await using outside = await tmpdir()
      const target = { environmentID: "sandbox", allocationID: "allocation", generation: 1 }
      await using executor = await NativeExecutor.open({
        target,
        directory: path.join(tmp.path, "receipts"),
        coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") }),
        sandbox: SandboxBackend,
      })
      await using host = ExecutionHost.listen({
        executor,
        target,
        token: "test-token-with-at-least-thirty-two-bytes",
        listen: { hostname: "127.0.0.1", port: 0 },
      })
      const remote = new RemoteExecutor({ url: host.url, target, token: "test-token-with-at-least-thirty-two-bytes" })
      const wrapper = await remote.prepareSandbox({
        command: "/bin/sh",
        args: ["-c", `printf allowed > allowed; printf refused > '${outside.path}/refused'`],
        workspace: tmp.path,
        sandboxMode: "workspace_write",
        networkMode: "restricted",
      })
      expect(wrapper.sandboxed).toBe(true)
      expect(wrapper).not.toHaveProperty("tempPath")
      const command = {
        command: wrapper.command,
        args: wrapper.args,
        cwd: tmp.path,
        env: {},
        writableRoots: wrapper.writeFootprint?.kind === "roots" ? wrapper.writeFootprint.roots : null,
      }
      await remote.start({ id: "sandboxed", target, command, digest: ExecutionProtocol.digest(command) })
      for (let i = 0; i < 400 && !ExecutionProtocol.terminal((await remote.status("sandboxed"))!); i++)
        await Bun.sleep(10)
      expect((await remote.status("sandboxed"))?.exitCode).not.toBe(0)
      expect(await Bun.file(path.join(tmp.path, "allowed")).text()).toBe("allowed")
      expect(await Bun.file(path.join(outside.path, "refused")).exists()).toBe(false)
      await remote.release("sandboxed")
      await remote.releaseSandbox(wrapper.id)
      await remote.releaseSandbox(wrapper.id)
    })
  },
  20_000,
)
