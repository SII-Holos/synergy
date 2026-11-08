import { expect, test } from "bun:test"
import path from "node:path"
import { memberEnvironment } from "../src/environment"

const home = path.resolve(process.env.SYNERGY_TEST_HOME!, "member")
const member = {
  home,
  root: path.join(home, ".synergy"),
  identity: { orgID: "organization", accountID: "account", deviceID: "device" },
  origin: "https://organization.example",
  publicKey: "public-metadata",
}
const pin = JSON.stringify({ id: crypto.randomUUID(), sha256: "a".repeat(64) })

test("member launch environments exclude private configuration and loader inputs before code is loaded", () => {
  const selected = memberEnvironment(member, {
    PATH: "/bin",
    LANG: "en_US.UTF-8",
    HOME: "/personal",
    USERPROFILE: "/personal",
    SYNERGY_HOME: "/personal",
    SYNERGY_RUNTIME_ROOT: "/personal/runtime",
    SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME,
    OPENAI_API_KEY: "private",
    HTTP_PROXY: "private",
    NODE_OPTIONS: "private",
    BUN_OPTIONS: "private",
    SYNERGY_SERVER_TOKEN: "private",
    SYNERGY_COMPONENTS: "private",
    SYNERGY_MEMBER_IDENTITY: "private",
    SYNERGY_INSTALLATION_ROOT: "/personal/runtime",
    SYNERGY_INSTALLATION_PIN: pin,
    SYNERGY_LAUNCHER_COMMAND: JSON.stringify(["personal-launcher"]),
  })
  expect(selected.PATH).toBe("/bin")
  expect(selected.LANG).toBe("en_US.UTF-8")
  expect(selected.HOME).toBe(home)
  expect(selected.SYNERGY_HOME).toBe(home)
  expect(selected.SYNERGY_TEST_HOME).toBe(home)
  expect(selected.SYNERGY_RUNTIME_ROOT).toBe(member.root)
  expect(JSON.parse(selected.SYNERGY_MEMBER_IDENTITY!)).toEqual(member.identity)
  expect(JSON.stringify(selected)).not.toContain("private")
  expect(JSON.stringify(selected)).not.toContain("personal")
  expect(selected.SYNERGY_INSTALLATION_PIN).toBeUndefined()
})

test("installed member workers retain only their own complete launcher identity", () => {
  const input = {
    SYNERGY_INSTALLATION_ROOT: member.root,
    SYNERGY_INSTALLATION_PIN: pin,
    SYNERGY_LAUNCHER_COMMAND: JSON.stringify(["verified-launcher"]),
    SYNERGY_LAUNCHER_CONTROL_VERSION: "1",
  }
  const selected = memberEnvironment(member, input)
  expect(selected.SYNERGY_INSTALLATION_PIN).toBe(pin)
  expect(selected.SYNERGY_LAUNCHER_COMMAND).toBe(input.SYNERGY_LAUNCHER_COMMAND)
  expect(selected.SYNERGY_INSTALLATION_ROOT).toBe(member.root)
  expect(selected.SYNERGY_LAUNCHER_CONTROL_VERSION).toBe("1")
  for (const invalid of [
    { ...input, SYNERGY_INSTALLATION_PIN: "private-invalid-pin" },
    { ...input, SYNERGY_LAUNCHER_COMMAND: undefined },
  ]) {
    expect(() => memberEnvironment(member, invalid)).toThrow("installation")
    try {
      memberEnvironment(member, invalid)
    } catch (error) {
      expect(String(error)).not.toContain("private-invalid-pin")
    }
  }
})
