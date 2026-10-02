import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { createServer } from "node:http"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { EnvironmentReleaseCommand, EnvironmentSelectCommand } from "../../src/cli/cmd/resources"

test("resource handlers preserve stale-allocation errors and reject unsafe attached URLs before sending", async () => {
  const received: Array<{ path: string; body: unknown; scope: string | null }> = []
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      received.push({ path: pathname, body: await request.json(), scope: request.headers.get("x-synergy-scope-id") })
      return pathname.endsWith("/release")
        ? Response.json({ name: "EnvironmentStale", data: { message: "Allocation changed" } }, { status: 409 })
        : Response.json({ environmentID: null })
    },
  })
  const output = spyOn(console, "log").mockImplementation(() => {})
  const exitCode = process.exitCode ?? 0
  const args = {
    _: [],
    $0: "synergy",
    attach: server.url.origin,
    scope: "research",
    tokenEnv: "SYNERGY_RESOURCE_FIXTURE_TOKEN",
  }
  try {
    await EnvironmentSelectCommand.handler({
      ...args,
      sessionID: "ses_one",
      environmentID: "none",
      expected: "env_old",
    })
    expect(received).toEqual([
      {
        path: "/session/ses_one/environment",
        body: { environmentID: null, expectedEnvironmentID: "env_old" },
        scope: "research",
      },
    ])
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual({ environmentID: null })
    await EnvironmentReleaseCommand.handler({ ...args, environmentID: "env_one", generation: 4 })
    expect(received.at(-1)).toMatchObject({ path: "/environment/env_one/release", body: { expectedGeneration: 4 } })
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual({
      error: { name: "EnvironmentStale", data: { message: "Allocation changed" } },
    })
    for (const attach of [
      `${server.url.origin}?secret=invalid`,
      server.url.href.replace("http://", "http://user:invalid@"),
      "file:///private",
    ]) {
      await expect(
        EnvironmentReleaseCommand.handler({ ...args, attach, environmentID: "env_one", generation: 4 }),
      ).rejects.toThrow("HTTP(S)")
    }
    expect(received).toHaveLength(2)
  } finally {
    output.mockRestore()
    process.exitCode = exitCode
  }
})

test("attached resource commands preserve Scope, preconditions and auth without acquiring the Home writer", async () => {
  const isolation = await createIsolatedTestEnv()
  const home = path.join(isolation.env.SYNERGY_TEST_HOME!, "resources-home")
  const lock = await ServerProcessLock.acquire(
    path.join(home, ".synergy", "state", "daemon", "runtime-lock.json"),
    "server",
  )
  const received: Array<{ path: string; scope: string | null; auth: string | null; body: unknown }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      received.push({
        path: new URL(request.url).pathname,
        scope: request.headers.get("x-synergy-scope-id"),
        auth: request.headers.get("authorization"),
        body:
          pathname === "/workspace/import"
            ? Array.from(new Uint8Array(await ((await request.formData()).get("file") as File).arrayBuffer()))
            : request.method === "POST"
              ? await request.json().catch(() => null)
              : null,
      })
      if (pathname.endsWith("/export"))
        return new Response(new Uint8Array([0, 255, 1]), { headers: { "content-type": "application/octet-stream" } })
      return request.url.endsWith("env_stale/release")
        ? Response.json({ name: "EnvironmentStale", data: { message: "Allocation changed" } }, { status: 409 })
        : Response.json({ accepted: true })
    },
  })
  async function invoke(argv: string[]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        path.resolve(import.meta.dir, "../../src/index.ts"),
        ...argv,
        "--attach",
        server.url.origin,
        "--scope",
        "research",
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...isolation.env, SYNERGY_HOME: home, SYNERGY_SERVER_TOKEN: "fixture-token" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  }
  try {
    for (const argv of [
      ["environment", "list"],
      ["environment", "create", "worker", "--request-id", "request-1"],
      ["environment", "select", "ses_one", "none", "--expected", "env_old"],
      ["environment", "release", "env_one", "--generation", "3"],
      ["workspace", "create", "files", "--name", "Research"],
      ["workspace", "select", "ses_one", "wsp_one", "--generation", "2"],
      ["workspace", "detach", "wsp_one", "--revision", "5"],
    ]) {
      const result = await invoke(argv)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ accepted: true })
      expect(result.stderr).not.toContain("fixture-token")
    }
    expect(received.map((value) => [value.path, value.body])).toEqual([
      ["/environment", null],
      ["/environment", { profile: "worker", requestID: "request-1" }],
      ["/session/ses_one/environment", { environmentID: null, expectedEnvironmentID: "env_old" }],
      ["/environment/env_one/release", { expectedGeneration: 3 }],
      ["/workspace/objects", { profile: "files", name: "Research" }],
      ["/session/ses_one/workspace", { mode: "workspace", workspaceID: "wsp_one", workspaceGeneration: 2 }],
      ["/workspace/wsp_one/detach", { expectedRevision: 5 }],
    ])
    expect(received.every((value) => value.scope === "research" && value.auth === "Bearer fixture-token")).toBe(true)
    const invalid = await invoke(["environment", "release", "env_one", "--generation", "-1"])
    expect(invalid.code).toBe(1)
    expect(received).toHaveLength(7)
    const stale = await invoke(["environment", "release", "env_stale", "--generation", "1"])
    expect(stale.code).toBe(1)
    expect(JSON.parse(stale.stdout)).toEqual({
      error: { name: "EnvironmentStale", data: { message: "Allocation changed" } },
    })
    const archive = path.join(home, "saved.ndjson")
    const exported = await invoke(["workspace", "export", "wsp_one", archive, "--revision", "5"])
    expect(exported.code, exported.stderr).toBe(0)
    expect(new Uint8Array(await Bun.file(archive).arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]))
    expect((await invoke(["workspace", "export", "wsp_one", archive, "--revision", "5"])).code).toBe(1)
    expect((await invoke(["workspace", "import", archive, "files"])).code).toBe(0)
    expect(received.at(-1)).toMatchObject({ path: "/workspace/import", body: [0, 255, 1] })
  } finally {
    server.stop(true)
    await lock.release()
    await isolation.dispose()
  }
}, 30000)

test("the public parser preserves recovery identities and publishes complete archives without overwriting files", async () => {
  const { runCli } = await import("../../src/main")
  const isolation = await createIsolatedTestEnv()
  const archive = path.join(isolation.env.SYNERGY_TEST_HOME!, "saved.ndjson")
  const bytes = new Uint8Array([0, 255, 1, 128])
  const received: Array<{ method: string; path: string; body: unknown }> = []
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      received.push({
        method: request.method,
        path: pathname,
        body:
          pathname === "/workspace/import"
            ? Array.from(new Uint8Array(await ((await request.formData()).get("file") as File).arrayBuffer()))
            : request.method === "POST"
              ? await request.json().catch(() => null)
              : null,
      })
      if (pathname.endsWith("/export"))
        return new Response(bytes, { headers: { "content-type": "application/octet-stream" } })
      return Response.json({ accepted: true })
    },
  })
  const interrupted = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length + 1),
    })
    response.write(bytes, () => response.destroy())
  })
  await new Promise<void>((resolve) => interrupted.listen(0, "127.0.0.1", resolve))
  const address = interrupted.address()
  if (!address || typeof address === "string") throw new Error("Archive fixture has no TCP port")
  const output = spyOn(console, "log").mockImplementation(() => {})
  const errors = spyOn(console, "error").mockImplementation(() => {})
  const exitCode = process.exitCode ?? 0
  let openedRuntime = false
  async function invoke(argv: string[], attach = server.url.origin) {
    process.exitCode = 0
    output.mockClear()
    await runCli({
      argv: [...argv, "--attach", attach, "--scope", "research", "--token-env", "SYNERGY_RESOURCE_FIXTURE_TOKEN"],
      runtimeFactory: async () => {
        openedRuntime = true
        throw new Error("Attached commands must not open a runtime")
      },
    })
    return { code: process.exitCode, output: output.mock.calls.map((args) => args.join(" ")).join("\n") }
  }
  try {
    for (const argv of [
      ["environment", "profiles"],
      ["environment", "list"],
      ["environment", "inspect", "env_one"],
      ["environment", "create", "worker", "--request-id", "allocation-request"],
      ["environment", "reconcile", "env_one"],
      ["environment", "recover", "env_one", "execution-one"],
      ["environment", "recover", "env_one", "file-one", "--file"],
      ["environment", "cancel", "env_one", "execution-one"],
      ["workspace", "list"],
      ["workspace", "create", "files", "--name", "Research"],
      ["workspace", "register", "/workspace/research"],
      ["workspace", "select", "ses_one", "none"],
      ["workspace", "select", "ses_one", "wsp_one", "--generation", "2"],
      ["workspace", "detach", "wsp_one", "--revision", "5"],
      ["workspace", "operations", "wsp_one"],
      ["workspace", "recover", "wsp_one", "file-one"],
      ["workspace", "recover-saved", "wsp_one", "files", "--revision", "5"],
    ]) {
      const result = await invoke(argv)
      expect(result.code, result.output).toBe(0)
      expect(JSON.parse(result.output)).toEqual({ accepted: true })
    }
    expect(received.filter((request) => /\/(recover|cancel|operations)$/.test(request.path))).toEqual([
      { method: "POST", path: "/environment/env_one/execution/execution-one/recover", body: null },
      { method: "POST", path: "/environment/env_one/file/file-one/recover", body: null },
      { method: "POST", path: "/environment/env_one/execution/execution-one/cancel", body: null },
      { method: "GET", path: "/workspace/wsp_one/operations", body: null },
      { method: "POST", path: "/workspace/wsp_one/operations/file-one/recover", body: null },
    ])
    expect(received.at(-1)).toMatchObject({
      path: "/workspace/wsp_one/recover-saved",
      body: { expectedRevision: 5, profile: "files" },
    })
    const requests = received.length
    expect((await invoke(["workspace", "select", "ses_one", "wsp_one"])).code).toBe(1)
    expect(received).toHaveLength(requests)
    const exported = await invoke(["workspace", "export", "wsp_one", archive, "--revision", "5"])
    expect(exported.code, exported.output).toBe(0)
    expect(new Uint8Array(await Bun.file(archive).arrayBuffer())).toEqual(bytes)
    expect((await invoke(["workspace", "export", "wsp_one", archive, "--revision", "5"])).code).toBe(1)
    expect(new Uint8Array(await Bun.file(archive).arrayBuffer())).toEqual(bytes)
    expect((await invoke(["workspace", "import", archive, "files"])).code).toBe(0)
    expect(received.at(-1)).toMatchObject({ path: "/workspace/import", body: Array.from(bytes) })
    const incomplete = archive + ".incomplete"
    expect(
      (
        await invoke(
          ["workspace", "export", "wsp_one", incomplete, "--revision", "5"],
          `http://127.0.0.1:${address.port}`,
        )
      ).code,
    ).toBe(1)
    expect(await Bun.file(incomplete).exists()).toBe(false)
    expect(await Array.fromAsync(new Bun.Glob("*.partial").scan(isolation.env.SYNERGY_TEST_HOME!))).toEqual([])
    expect(openedRuntime).toBe(false)
  } finally {
    output.mockRestore()
    errors.mockRestore()
    process.exitCode = exitCode
    await new Promise<void>((resolve, reject) => interrupted.close((error) => (error ? reject(error) : resolve())))
    await isolation.dispose()
  }
}, 30000)
