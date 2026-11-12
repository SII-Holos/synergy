import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { prepareHostedHome, prepareMemberHome, readRuntimeHome } from "../src/home"
import { Binding, NativeHomeReaderContract } from "../src/home-schema"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { readCredentials } from "../src/credentials"

for (const kind of ["member", "hosted"] as const)
  for (const reader of ["legacy", "before-origin", "before-use"] as const)
    test(`new ${kind} Homes reject the ${reader} strict Node startup reader`, async () => {
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
        const child = Bun.spawn(["node", entry, home.home, JSON.stringify(home.identity), reader], {
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
            readerContract: NativeHomeReaderContract,
          })
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    })

for (const previous of ["native-organization-ownership-v1", "native-organization-ownership-v2"] as const)
  test.each(["member", "hosted"] as const)(
    `ordinary %s startup never upgrades the unpublished ${previous} reader`,
    async (kind) => {
      const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "native-origin-reader-"))
      try {
        const input = { baseDirectory: directory, origin: "https://organization.example" }
        const home =
          kind === "member"
            ? await prepareMemberHome({
                ...input,
                identity: { orgID: "org", accountID: "member", deviceID: "device" },
              })
            : await prepareHostedHome({ ...input, identity: { orgID: "org", hostID: "hosted" } })
        const ownerFile = path.join(home.root, "home-ownership.json")
        const bindingFile = path.join(home.root, "organization.json")
        const owner = HomeOwnershipFile.FencedInfo.parse(JSON.parse(await fs.readFile(ownerFile, "utf8")))
        const binding = Binding.parse(JSON.parse(await fs.readFile(bindingFile, "utf8")))
        const previousOwner = JSON.stringify({ ...owner, readerContract: previous })
        const previousBinding = JSON.stringify({ ...binding, readerContract: previous })
        await fs.writeFile(ownerFile, previousOwner)
        await fs.writeFile(bindingFile, previousBinding)
        await expect(readRuntimeHome(home.home, home.identity)).rejects.toThrow()
        const retry =
          kind === "member"
            ? prepareMemberHome({ ...input, identity: { orgID: "org", accountID: "member", deviceID: "device" } })
            : prepareHostedHome({ ...input, identity: { orgID: "org", hostID: "hosted" } })
        await expect(retry).rejects.toThrow()
        expect(await fs.readFile(ownerFile, "utf8")).toBe(previousOwner)
        expect(await fs.readFile(bindingFile, "utf8")).toBe(previousBinding)
        expect((await readCredentials(home.root))?.publicKey).toBe(home.publicKey)
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    },
  )
