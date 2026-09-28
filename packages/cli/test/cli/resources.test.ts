import { expect, spyOn, test } from "bun:test"
import path from "node:path"
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
