import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "./support/runtime"

test("editing a redacted Email account preserves both transport credentials", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({
      config: {
        email: {
          from: { address: "sender@example.test", name: "Before" },
          smtp: { password: "smtp-fixture-secret" },
          imap: { password: "imap-fixture-secret" },
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const config = await Config.current()
        const visible = Config.redactForClient(config)
        expect(visible.email?.smtp?.password).toBe(Config.REDACTED_SENTINEL)
        expect(visible.email?.imap?.password).toBe(Config.REDACTED_SENTINEL)
        expect(config.email?.smtp?.password).toBe("smtp-fixture-secret")
        expect(config.email?.imap?.password).toBe("imap-fixture-secret")
        const updated = await Config.domainUpdate(
          "email",
          { email: { ...visible.email, from: { address: "sender@example.test", name: "After" } } },
          { root: path.join(tmp.path, ".synergy"), mode: "replace-domain" },
        )
        expect(updated.email?.smtp?.password).toBe(Config.REDACTED_SENTINEL)
        expect(updated.email?.imap?.password).toBe(Config.REDACTED_SENTINEL)
        expect((await Config.current()).email).toEqual({
          ...config.email,
          from: { address: "sender@example.test", name: "After" },
        })
        const stored = await Bun.file(path.join(tmp.path, ".synergy/synergy.d/110-email.jsonc")).text()
        expect(stored).not.toContain(Config.REDACTED_SENTINEL)
        expect(stored).toContain("smtp-fixture-secret")
        expect(stored).toContain("imap-fixture-secret")
      },
    })
  })
})
