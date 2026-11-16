import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fixture } from "./support/organization"

test("organization authorization serves only its built document and local assets with a first-party security policy", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-web-"))
  try {
    await Bun.write(path.join(directory, "organization.html"), '<!doctype html><script src="/assets/auth.js"></script>')
    await Bun.write(path.join(directory, "assets/auth.js"), "export const application = 'authorization'")
    await Bun.write(path.join(directory, "index.html"), "private personal shell")
    await Bun.write(path.join(directory, "secret.txt"), "operator secret")
    await fs.symlink(path.join(directory, "secret.txt"), path.join(directory, "assets/escape.js"))
    await using f = await fixture(undefined, { web: { directory } })
    const request = (route: string, headers?: Record<string, string>) =>
      f.service.fetch(new Request(`https://organization.example${route}`, { headers }))
    const document = await request("/organization.html", { accept: "text/html" })
    expect(document.status).toBe(200)
    expect(await document.text()).toContain("/assets/auth.js")
    expect(document.headers.get("cache-control")).toBe("no-store")
    const policy = document.headers.get("content-security-policy")!
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(document.headers.get("referrer-policy")).toBe("no-referrer")
    expect(document.headers.get("cross-origin-opener-policy")).toBe("unsafe-none")
    const asset = await request("/assets/auth.js")
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain("authorization")
    for (const route of [
      "/",
      "/index.html",
      "/secret.txt",
      "/assets/escape.js",
      "/assets/missing.js",
      "/org/v1/unknown",
    ]) {
      expect((await request(route, { accept: "text/html" })).status).toBe(404)
    }
    expect((await request("/org/v1/auth/session", { accept: "text/html" })).status).toBe(401)
    expect((await request("/org/v1/health")).status).toBe(200)
    expect(await f.service.capabilities()).toMatchObject({ executesAgents: false })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("the API-only organization service does not advertise an absent Web application", async () => {
  await using f = await fixture()
  expect((await f.service.fetch(new Request("https://organization.example/organization.html"))).status).toBe(404)
})
