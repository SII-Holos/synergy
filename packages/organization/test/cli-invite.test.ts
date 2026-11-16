import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { cert, key } from "@ericsanchezok/synergy-testing/organization-tls"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { openOrganizationService } from "../src/service"

async function fixture() {
  const installed = process.env.SYNERGY_TEST_ORGANIZATION_INSTALL
  const entry = installed
    ? path.join(installed, "node_modules/.bin/synergy-org")
    : path.resolve(import.meta.dir, "../src/entry.ts")
  const resources = testResources()
  try {
    const isolation = await createIsolatedTestEnv()
    resources.defer("isolated environment", () => isolation.dispose())
    const root = isolation.env.SYNERGY_TEST_ROOT!
    const ca = path.join(root, "ca.pem")
    await fs.writeFile(ca, cert, { mode: 0o600 })
    let service: Awaited<ReturnType<typeof openOrganizationService>> | undefined
    const requests: string[] = []
    let lostResponse = false
    let publicOutput = false
    let issuedToken: string | undefined
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        requests.push(pathname)
        if (!service) return new Response(null, { status: 503 })
        const response = await service.fetch(request)
        if (publicOutput && pathname === "/org/v1/invites" && request.method === "POST") {
          issuedToken = (await response.clone().json()).token
          await fs.chmod(output, 0o644)
        }
        if (lostResponse && pathname === "/org/v1/invites" && request.method === "POST") {
          lostResponse = false
          await response.body?.cancel()
          return Response.json(
            { code: "SERVICE_UNAVAILABLE", message: "Response unavailable", retryable: true, outcome: "unknown" },
            { status: 503 },
          )
        }
        return response
      },
    })
    resources.defer("organization service", () => service?.close())
    resources.defer("HTTPS listener", () => server.stop(true))
    const origin = server.url.origin
    service = await openOrganizationService({ home: path.join(root, "service"), publicOrigin: origin })
    const password = "invite-owner-password!"
    const bootstrap = await service.fetch(
      new Request(`${origin}/org/v1/setup/bootstrap`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          token: await service.bootstrapToken(),
          requestID: "invite-cli-bootstrap",
          organizationName: "Invitation CLI",
          loginName: "owner",
          displayName: "Owner",
          password,
        }),
      }),
    )
    expect(bootstrap.status).toBe(200)
    const passwordFile = path.join(root, "password")
    await fs.writeFile(passwordFile, password + "\n", { mode: 0o600 })
    const output = path.join(root, "invitation.json")
    return {
      service,
      requests,
      origin,
      password,
      loseResponse() {
        lostResponse = true
      },
      makeOutputPublic() {
        publicOutput = true
      },
      issuedToken() {
        return issuedToken
      },
      output,
      async invoke(loginName = "owner", outputFile = output, preload?: string) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "--no-bunfig",
            ...(preload ? ["--preload", preload] : []),
            entry,
            "invite",
            "--origin",
            origin,
            "--login-name",
            loginName,
            "--password-file",
            passwordFile,
            "--ca-file",
            ca,
            "--output",
            outputFile,
          ],
          {
            cwd: installed ?? root,
            env: {
              ...isolation.env,
              NODE_PATH: undefined,
              NODE_OPTIONS: undefined,
              SYNERGY_HOME: undefined,
              SYNERGY_RUNTIME_ROOT: undefined,
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10_000,
          },
        )
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        return { code, stdout, stderr }
      },
      [Symbol.asyncDispose]: resources.close,
    }
  } catch (error) {
    await resources.close()
    throw error
  }
}

test("the independent invitation command authenticates over TLS and retains one private token without an ambient Home", async () => {
  await using f = await fixture()
  const result = await f.invoke()
  expect(result.code, result.stderr).toBe(0)
  const saved = await Bun.file(f.output).json()
  expect(saved).toMatchObject({ state: "complete" })
  expect(saved.token).toMatch(/^[a-f0-9]{64}$/)
  if (process.platform !== "win32") expect((await fs.stat(f.output)).mode & 0o077).toBe(0)
  expect(result.stdout).not.toContain(saved.token)
  expect(result.stdout + result.stderr).not.toContain(f.password)
  expect(f.requests).toEqual(["/org/v1/auth/login", "/org/v1/invites", "/org/v1/auth/logout"])
  const logins = await f.service.maintenance.run(() =>
    Storage.query<{ revokedAt?: number }>({ prefix: ["organization", "logins"], limit: 10 }),
  )
  expect(logins).toHaveLength(1)
  expect(logins[0]!.value.revokedAt).toBeNumber()
  const before = f.requests.length
  expect((await f.invoke()).code).toBe(1)
  expect(f.requests.length).toBe(before)
  const consumed = await f.service.fetch(
    new Request(`${f.origin}/org/v1/invites/consume`, {
      method: "POST",
      headers: { origin: f.origin, "content-type": "application/json" },
      body: JSON.stringify({
        token: saved.token,
        requestID: "cli-member",
        loginName: "member",
        displayName: "Member",
        password: f.password,
      }),
    }),
  )
  expect(consumed.status).toBe(200)
  const deniedOutput = path.join(path.dirname(f.output), "denied.json")
  expect((await f.invoke("member", deniedOutput)).code).toBe(1)
  expect(await Bun.file(deniedOutput).json()).toMatchObject({ state: "failed", outcome: "not_dispatched" })
}, 15_000)

test("an unknown invitation response retains its marker and never resubmits the mutation", async () => {
  await using f = await fixture()
  f.loseResponse()
  const result = await f.invoke()
  expect(result.code).toBe(1)
  expect(await Bun.file(f.output).json()).toMatchObject({ state: "unknown", outcome: "unknown" })
  const issued = await f.service.maintenance.run(() =>
    Storage.queryKeys({ prefix: ["organization", "invites"], limit: 10 }),
  )
  expect(issued).toHaveLength(1)
  expect(f.requests.filter((pathname) => pathname === "/org/v1/invites")).toHaveLength(1)
  const before = f.requests.length
  expect((await f.invoke()).code).toBe(1)
  expect(f.requests.length).toBe(before)
  expect(result.stdout + result.stderr).not.toContain(f.password)
}, 15_000)

test.skipIf(process.platform === "win32")(
  "an invitation returned after its output permissions change never lands in the public file",
  async () => {
    await using f = await fixture()
    f.makeOutputPublic()
    const result = await f.invoke()
    expect(result.code).toBe(1)
    const token = f.issuedToken()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(await Bun.file(f.output).text()).not.toContain(token!)
    expect(result.stdout + result.stderr).not.toContain(token!)
    expect(f.requests.filter((pathname) => pathname === "/org/v1/invites")).toHaveLength(1)
  },
  15_000,
)

test("invitation creation waits for durable marker publication before contacting the service", async () => {
  await using f = await fixture()
  const preload = path.join(path.dirname(f.output), "reject-directory-sync.ts")
  await Bun.write(
    preload,
    "import { AtomicFile } from " +
      JSON.stringify(
        process.env.SYNERGY_TEST_ORGANIZATION_INSTALL
          ? Bun.resolveSync("@ericsanchezok/synergy-util/atomic-file", process.env.SYNERGY_TEST_ORGANIZATION_INSTALL)
          : import.meta.resolve("@ericsanchezok/synergy-util/atomic-file"),
      ) +
      "; AtomicFile.syncDirectories = async () => { throw new Error('directory sync unavailable') }\n",
  )
  const result = await f.invoke("owner", f.output, preload)
  expect(result.code).toBe(1)
  expect(f.requests).toEqual([])
  expect(await Bun.file(f.output).json()).toMatchObject({ state: "failed", outcome: "not_dispatched" })
}, 15_000)
