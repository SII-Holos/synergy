import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { memberIdentityDigest, prepareMemberHome, readMemberHome } from "../src/home"

const roots: string[] = []
async function directory() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-runtime-home-"))
  roots.push(root)
  return root
}
afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

test("member Homes use organization, account and device identity, with stable private machine keys", async () => {
  const baseDirectory = await directory()
  const first = { orgID: "organization-a", accountID: "member-a", deviceID: "device" }
  const second = { ...first, orgID: "organization-b" }
  const third = { ...first, accountID: "member-b" }
  const origin = "https://organization.example"
  const [a, again, b, c] = await Promise.all([
    prepareMemberHome({ baseDirectory, identity: first, origin }),
    prepareMemberHome({ baseDirectory, identity: first, origin }),
    prepareMemberHome({ baseDirectory, identity: second, origin }),
    prepareMemberHome({ baseDirectory, identity: third, origin }),
  ])
  expect(again).toEqual(a)
  expect(new Set([a.home, b.home, c.home]).size).toBe(3)
  expect(new Set([a.publicKey, b.publicKey, c.publicKey]).size).toBe(3)
  expect(a.identity).toEqual(first)
  expect(await readMemberHome(a.home, first)).toEqual(a)
  const privateFile = path.join(a.home, ".synergy", "auth", "organization-runtime.json")
  if (process.platform !== "win32") expect((await fs.stat(privateFile)).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(a)).not.toContain("privateKey")
  expect(JSON.stringify(a)).not.toContain("pkcs8")
})

test("a member Home refuses another identity, a changed address and missing or malformed credentials", async () => {
  const baseDirectory = await directory()
  const identity = { orgID: "organization", accountID: "member", deviceID: "device" }
  const origin = "https://organization.example"
  const member = await prepareMemberHome({ baseDirectory, identity, origin })
  await expect(readMemberHome(member.home, { ...identity, accountID: "other" })).rejects.toThrow("identity")
  await expect(prepareMemberHome({ baseDirectory, identity, origin: "https://other.example" })).rejects.toThrow(
    "address",
  )
  const credentials = path.join(member.home, ".synergy", "auth", "organization-runtime.json")
  const original = await Bun.file(credentials).text()
  await fs.rm(credentials)
  await expect(prepareMemberHome({ baseDirectory, identity, origin })).rejects.toThrow("credentials")
  expect(await Bun.file(credentials).exists()).toBe(false)
  await Bun.write(credentials, "invalid-private-key")
  await expect(readMemberHome(member.home, identity)).rejects.toThrow("credentials")
  await Bun.write(credentials, original)
  expect(await readMemberHome(member.home, identity)).toEqual(member)
})

test("member Home provisioning rejects relative storage and non-TLS or credential-bearing origins before writes", async () => {
  const baseDirectory = await directory()
  const identity = { orgID: "organization", accountID: "member", deviceID: "device" }
  await expect(
    prepareMemberHome({ baseDirectory: "relative", identity, origin: "https://organization.example" }),
  ).rejects.toThrow("absolute")
  for (const origin of [
    "http://organization.example",
    "https://name:password@organization.example",
    "https://organization.example/path",
    "https://organization.example?token=private",
  ])
    await expect(prepareMemberHome({ baseDirectory, identity, origin })).rejects.toThrow("HTTPS origin")
  expect(await fs.readdir(baseDirectory)).toEqual([])
})

test("provisioning never adopts existing personal data or replaces a damaged established identity", async () => {
  const baseDirectory = await directory()
  const identity = { orgID: "organization", accountID: "member", deviceID: "device" }
  const origin = "https://organization.example"
  const home = path.join(baseDirectory, memberIdentityDigest(identity))
  const personal = path.join(home, ".synergy", "data", "personal.txt")
  await Bun.write(personal, "personal history")
  await expect(prepareMemberHome({ baseDirectory, identity, origin })).rejects.toThrow("dedicated Home")
  expect(await Bun.file(personal).text()).toBe("personal history")
  expect(await Bun.file(path.join(home, ".synergy", "home-ownership.json")).exists()).toBe(false)

  const member = await prepareMemberHome({ baseDirectory, identity: { ...identity, deviceID: "clean" }, origin })
  const binding = path.join(member.root, "organization.json")
  const original = await Bun.file(binding).json()
  await Bun.write(binding, JSON.stringify({ ...original, schemaVersion: 2 }))
  await expect(readMemberHome(member.home, member.identity)).rejects.toThrow("unsupported")
  await fs.rm(binding)
  await expect(prepareMemberHome({ baseDirectory, identity: member.identity, origin })).rejects.toThrow("identity")
  expect(await Bun.file(binding).exists()).toBe(false)
})

test("unfinished initial provisioning resumes without changing a published machine key", async () => {
  const baseDirectory = await directory()
  const identity = { orgID: "organization", accountID: "member", deviceID: "device" }
  const origin = "https://organization.example"
  const member = await prepareMemberHome({ baseDirectory, identity, origin })
  const pending = { schemaVersion: 1, state: "provisioning", identity, origin }
  const binding = path.join(member.root, "organization.json")
  await Bun.write(binding, JSON.stringify(pending))
  await expect(readMemberHome(member.home, identity)).rejects.toThrow("incomplete")
  expect(await prepareMemberHome({ baseDirectory, identity, origin })).toEqual(member)

  const other = await prepareMemberHome({ baseDirectory, identity: { ...identity, deviceID: "other" }, origin })
  const credentials = path.join(member.root, "auth", "organization-runtime.json")
  const original = await Bun.file(credentials).json()
  await Bun.write(credentials, JSON.stringify({ ...original, publicKey: other.publicKey }))
  await expect(readMemberHome(member.home, identity)).rejects.toThrow("credentials")
  await Bun.write(credentials, JSON.stringify({ ...original, pkcs8: "00" }))
  await expect(readMemberHome(member.home, identity)).rejects.toThrow("credentials")
})

test.skipIf(process.platform === "win32")(
  "a managed Home cannot be redirected into another directory by a symbolic link",
  async () => {
    const baseDirectory = await directory()
    const target = await directory()
    const identity = { orgID: "organization", accountID: "member", deviceID: "device" }
    await fs.symlink(target, path.join(baseDirectory, memberIdentityDigest(identity)), "dir")
    await expect(
      prepareMemberHome({ baseDirectory, identity, origin: "https://organization.example" }),
    ).rejects.toThrow("symbolic")
    expect(await fs.readdir(target)).toEqual([])
  },
)
