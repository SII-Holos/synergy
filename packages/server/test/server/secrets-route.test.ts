import { expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SecretsRoute } from "../../src/server/secrets-route"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const app = new Hono()
  .route("/secrets", SecretsRoute())
  .onError((error, c) => c.json({ name: error.name }, error instanceof Storage.NotFoundError ? 404 : 500))
function rotate(id: string, value: string) {
  return app.request(`/secrets/${id}/rotate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  })
}

test("rotation distinguishes missing entries, value conflicts and storage failures", () =>
  runtime.run(async () => {
    expect((await rotate("missing", "replacement")).status).toBe(404)
    const source = await SecretVault.register(`source-${crypto.randomUUID()}`, { kind: "user" })
    const target = await SecretVault.register(`target-${crypto.randomUUID()}`, { kind: "user" })
    try {
      const conflict = await rotate(source.id, target.value)
      expect(conflict.status).toBe(409)
      expect(await conflict.text()).not.toContain(target.value)
      const fault = spyOn(SecretVault, "rotate").mockRejectedValue(new Error("disk unavailable"))
      try {
        expect((await rotate(source.id, "replacement")).status).toBe(500)
      } finally {
        fault.mockRestore()
      }
    } finally {
      await SecretVault.remove(source.id)
      await SecretVault.remove(target.id)
    }
  }))

afterRuntimeTests(() => runtime.close())
