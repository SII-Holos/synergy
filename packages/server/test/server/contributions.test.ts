import { describe, expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

async function runIsolated(source: string) {
  const isolated = await createIsolatedTestEnv()
  try {
    const child = Bun.spawn([process.execPath, "--eval", source + "\nprocess.exit(0);"], {
      cwd: new URL("../../", import.meta.url).pathname,
      env: isolated.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    return JSON.parse(stdout)
  } finally {
    await isolated.dispose()
  }
}

const setup = `
  import { Server } from "./src/server/server";
  import { Hono } from "hono";
  import { Global } from "@ericsanchezok/synergy-harness/global";
  import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context";
  await Global.initialize();
`

describe("server composition", () => {
  test("core application has core routes without product routes", async () => {
    const paths: string[] = await runIsolated(
      setup +
        `
      console.log(JSON.stringify(Server.App().routes.map(route => route.path)));
    `,
    )
    expect(paths).toContain("/scope/bootstrap")
    expect(paths).toContain("/global/health")
    expect(paths).not.toContain("/global/agenda")
    expect(paths.some((path) => path.startsWith("/browser"))).toBe(false)
    expect(paths.some((path) => path.startsWith("/library"))).toBe(false)
  })

  test("contributions preserve route ordering, Scope middleware, and construction boundary", async () => {
    const result = await runIsolated(
      setup +
        `
      Server.registerContributions({
        routes: {
          "global-tools": new Hono().get("/probe", c => c.json({ stage: "first", scopeID: ScopeContext.current.scope.id })),
          "scoped-integrations": new Hono().get("/probe", c => c.json({ stage: "last" })),
        },
        isScopeRequiredRoute: path => path === "/probe",
      });
      const app = Server.App();
      const missing = await app.request("/probe");
      const scoped = await app.request("/probe?scopeID=home");
      let lateRegistrationRejected = false;
      try { Server.registerContributions({}); } catch { lateRegistrationRejected = true; }
      console.log(JSON.stringify({
        missing: { status: missing.status, body: await missing.json() },
        scoped: { status: scoped.status, body: await scoped.json(), seq: scoped.headers.get("x-synergy-seq") },
        lateRegistrationRejected,
      }));
    `,
    )
    expect(result.missing.status).toBe(400)
    expect(result.missing.body.name).toBe("ScopeRequired")
    expect(result.scoped.status).toBe(200)
    expect(result.scoped.body).toEqual({ stage: "first", scopeID: "home" })
    expect(result.scoped.seq).not.toBeNull()
    expect(result.lateRegistrationRejected).toBe(true)
  })
})
