import { expect, test } from "bun:test"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { createLocalHost } from "../src/host"
import path from "node:path"

test("local host captures source launch provenance independently of the working directory", () => {
  const env = {
    SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME,
    SYNERGY_RUNTIME_ENTRY: "dev-web",
    SYNERGY_CWD: "/unrelated/project",
    SYNERGY_SERVER_TOKEN: "private",
  }
  const host = createLocalHost({ env })
  const instance = RuntimeContext.create(host)
  try {
    expect(instance.host.launch).toMatchObject({ entry: "dev-web", distribution: "source", channel: "local" })
    expect(instance.host.launch?.sourceCheckout).toBe(path.resolve(import.meta.dir, "../../.."))
    expect(instance.host.launch?.revision).toMatch(/^[a-f0-9]{40}$/)
    expect(Object.isFrozen(instance.host.launch)).toBe(true)
    env.SYNERGY_RUNTIME_ENTRY = "dev-desktop-managed"
    expect(instance.host.launch?.entry).toBe("dev-web")
    expect(instance.host.launch?.sourceCheckout).not.toBe(env.SYNERGY_CWD)
    expect(JSON.stringify(instance.host.launch)).not.toContain("private")
  } finally {
    instance.dispose()
  }
})

test("installed launch selection wins over inherited development labels", () => {
  const host = createLocalHost({
    env: {
      SYNERGY_RUNTIME_ENTRY: "dev-web",
      SYNERGY_INSTALLATION_PIN: '{"id":"installed","sha256":"fixture"}',
      SYNERGY_DESKTOP_STARTUP_PROGRESS: "1",
      SYNERGY_DESKTOP_CHANNEL: "dev",
    },
  })
  expect(host.launch).toMatchObject({ entry: "desktop-managed", distribution: "installed" })
  expect(host.launch?.sourceCheckout).toBeUndefined()
  expect(host.launch?.revision).toBeUndefined()
})

test("an unrecognized launch entry stays an embedding instead of copying arbitrary prompt text", () => {
  const host = createLocalHost({ env: { SYNERGY_RUNTIME_ENTRY: "injected\nsecret=value" } })
  expect(host.launch?.entry).toBe("embedded")
  expect(JSON.stringify(host.launch)).not.toContain("injected")
  expect(JSON.stringify(host.launch)).not.toContain("secret=value")
})
