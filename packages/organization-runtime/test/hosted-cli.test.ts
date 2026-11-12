import { expect, test } from "bun:test"
import path from "node:path"
import { prepareHostedHome } from "../src/home"
import { memberEnvironment } from "../src/environment"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { fixture } from "./support/organization"

test("hosted-runtime privately enrolls a machine and reuses managed CLI shutdown", async () => {
  await using service = await fixture()
  const hosted = await prepareHostedHome({
    baseDirectory: path.join(service.root, "hosted"),
    identity: { orgID: service.identity.orgID, hostID: "cli-server" },
    origin: service.origin,
  })
  const response = await service.service.fetch(
    new Request("https://organization.example/org/v1/runtimes/hosted", {
      method: "POST",
      headers: { ...service.headers, origin: "https://organization.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Hosted CLI", publicKey: hosted.publicKey }),
    }),
  )
  const ticket = Protocol.Ticket.parse(await response.json())
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  const token = "b".repeat(64)
  const input = {
    version: 1,
    identity: hosted.identity,
    deploymentIncarnation: ticket.runtime.deploymentIncarnation,
    port,
    token,
    ticket,
    ca: service.ca,
  }
  const installed = process.env.SYNERGY_TEST_ORGANIZATION_RUNTIME_INSTALL
  const entry = installed
    ? path.join(installed, "node_modules/.bin/synergy-org-runtime")
    : path.resolve(import.meta.dir, "../src/entry.ts")
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-bunfig", entry, "hosted-runtime"], {
    env: memberEnvironment(hosted, process.env),
    cwd: hosted.home,
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  try {
    const client = createSynergyClient({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: { authorization: `Bearer ${token}` },
    })
    let ready = false
    const deadline = Date.now() + 12_000
    while (!ready && child.exitCode === null && Date.now() < deadline) {
      const response = await client.global.capabilities({ signal: AbortSignal.timeout(250) }).catch(() => undefined)
      ready = !!response?.data?.runtimeID
      if (ready) expect(response?.data?.features).not.toContain("browser")
      else await Bun.sleep(25)
    }
    if (child.exitCode !== null) throw new Error((await output).join("\n"))
    expect(ready).toBe(true)
    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
    const printed = (await output).join("\n")
    expect(printed).not.toContain(token)
    expect(printed).not.toContain(ticket.token)
    expect(printed).toContain('"state":"ready"')
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await output
  }
}, 25_000)
