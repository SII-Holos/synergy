import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { prepareHostedHome, prepareMemberHome } from "../src/home"

test("new hosted Homes fence the previous strict Node startup reader while member Homes retain their existing format", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "hosted-reader-fence-"))
  try {
    const identity = { orgID: "org", hostID: "hosted" }
    const hosted = await prepareHostedHome({
      baseDirectory: path.join(directory, "homes"),
      identity,
      origin: "https://organization.example",
    })
    expect(JSON.parse(await fs.readFile(path.join(hosted.root, "home-ownership.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      owner: "organization-runtime",
      readerContract: "purpose-bound-maintenance-v1",
    })
    expect(JSON.parse(await fs.readFile(path.join(hosted.root, "organization.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      readerContract: "purpose-bound-maintenance-v1",
    })
    const member = await prepareMemberHome({
      baseDirectory: path.join(directory, "homes"),
      identity: { orgID: "org", accountID: "member", deviceID: "device" },
      origin: "https://organization.example",
    })
    expect(JSON.parse(await fs.readFile(path.join(member.root, "home-ownership.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
    })
    const bundle = await Bun.build({
      entrypoints: [new URL("./support/legacy-home-reader.ts", import.meta.url).pathname],
      target: "node",
    })
    if (!bundle.success) throw new Error("Legacy Home reader did not compile")
    const entry = path.join(directory, "legacy-reader.mjs")
    await fs.writeFile(entry, await bundle.outputs[0].text())
    const child = Bun.spawn(["node", entry, hosted.home, JSON.stringify(identity)], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    const [status, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status).not.toBe(0)
    expect(stdout).toBe("")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
