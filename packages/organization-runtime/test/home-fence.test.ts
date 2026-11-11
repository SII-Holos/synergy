import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { prepareHostedHome, prepareMemberHome } from "../src/home"

for (const kind of ["member", "hosted"] as const)
  test(`new ${kind} Homes require the current native ownership reader and reject the previous strict Node startup reader`, async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "native-reader-fence-"))
    try {
      const input = { baseDirectory: path.join(directory, "homes"), origin: "https://organization.example" }
      const home =
        kind === "member"
          ? await prepareMemberHome({ ...input, identity: { orgID: "org", accountID: "member", deviceID: "device" } })
          : await prepareHostedHome({ ...input, identity: { orgID: "org", hostID: "hosted" } })
      const bundle = await Bun.build({
        entrypoints: [new URL("./support/legacy-home-reader.ts", import.meta.url).pathname],
        target: "node",
      })
      if (!bundle.success) throw new Error("Legacy Home reader did not compile")
      const entry = path.join(directory, "legacy-reader.mjs")
      await fs.writeFile(entry, await bundle.outputs[0].text())
      const child = Bun.spawn(["node", entry, home.home, JSON.stringify(home.identity)], {
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
      for (const filename of ["home-ownership.json", "organization.json"])
        expect(JSON.parse(await fs.readFile(path.join(home.root, filename), "utf8"))).toMatchObject({
          schemaVersion: 2,
          readerContract: "native-organization-ownership-v1",
        })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
