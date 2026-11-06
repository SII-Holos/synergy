import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { assertNativeAcceptanceReady } from "../../script/acceptance/native-preflight"

test("acceptance rejects retained native writers without deleting another owner's recovery state", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "workspace-claims-v1.json")
  const bytes = JSON.stringify({ claims: [{ kind: "process", state: "active", durable: true, drained: true }] })
  await Bun.write(file, bytes)
  await expect(assertNativeAcceptanceReady(tmp.path)).rejects.toThrow("native writer reservations")
  expect(await Bun.file(file).text()).toBe(bytes)
  await Bun.write(file, JSON.stringify({ claims: [{ kind: "use", state: "active" }] }))
  await expect(assertNativeAcceptanceReady(tmp.path)).resolves.toEqual({ reservations: 0, readers: 1 })
})

test("acceptance cannot proceed through a corrupt native claim ledger", async () => {
  await using tmp = await tmpdir()
  await expect(assertNativeAcceptanceReady(tmp.path)).resolves.toEqual({ reservations: 0, readers: 0 })
  await Bun.write(path.join(tmp.path, "workspace-claims-v1.json"), "{broken")
  await expect(assertNativeAcceptanceReady(tmp.path)).rejects.toThrow()
})
