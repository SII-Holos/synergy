import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/provider/api-key"
import { ProviderConnection } from "../../src/provider/connection"
import { ProviderPluginAuth } from "../../src/provider/plugin-auth-source"
import { ProviderProfile } from "../../src/provider/profile"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Env } from "../../src/util/env"
import { withTimeout } from "../../src/util/timeout"
import { testRuntime } from "../support/runtime"

test("updates an unconfigured canonical catalog connection without taking ownership of environment credentials", async () => {
  await using runtime = await testRuntime({ env: { GROQ_API_KEY: "connection-environment-key" } })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        expect((await ProviderConnection.list()).groq).toMatchObject({ configured: false, removable: false })
        expect(ProviderProfile.get("groq")).toBeUndefined()
        const credentials = await Auth.entries()

        const { connection } = await ProviderConnection.update("groq", {
          name: "  Personal Groq  ",
          endpoint: "https://groq-account.invalid/v1",
          enabled: false,
        })

        expect(connection).toEqual({
          id: "groq",
          name: "Personal Groq",
          profileID: "groq",
          catalogProviderID: "groq",
          endpoint: "https://groq-account.invalid/v1",
          enabled: false,
          configured: true,
          removable: false,
          canCreateSibling: true,
        })
        expect((await Config.domainGet("providers")).provider?.groq).toEqual({
          name: "Personal Groq",
          api: "https://groq-account.invalid/v1",
        })
        expect((await ProviderConnection.update("groq", { enabled: true })).connection).toEqual({
          ...connection,
          enabled: true,
        })
        expect(Env.get("GROQ_API_KEY")).toBe("connection-environment-key")
        expect(await Auth.entries()).toEqual(credentials)
        await expect(ProviderConnection.remove("groq")).rejects.toBeInstanceOf(ProviderConnection.NotManaged)
        expect((await ProviderConnection.list()).groq).toEqual({ ...connection, enabled: true })
      },
    }),
  )
})

test("updates an unconfigured plugin profile without invoking its credential hooks", async () => {
  const providerID = "connection-plugin"
  let credentialHookReads = 0
  await using runtime = await testRuntime({
    register() {
      ProviderPluginAuth.register({
        async authProviderProfiles() {
          return [{ id: providerID, name: "Plugin account", authKind: "oauth" }]
        },
        async authProviderHooks() {
          credentialHookReads++
          return []
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const credentials = await Auth.entries()
        const { connection } = await ProviderConnection.update(providerID, {
          name: "Plugin remark",
          endpoint: "https://plugin-account.invalid/v1",
          enabled: false,
        })

        expect(connection).toMatchObject({
          id: providerID,
          profileID: providerID,
          name: "Plugin remark",
          endpoint: "https://plugin-account.invalid/v1",
          enabled: false,
          configured: true,
          removable: false,
        })
        expect(ProviderProfile.get(providerID)).toMatchObject({ name: "Plugin account", origin: "plugin" })
        expect(credentialHookReads).toBe(0)
        expect(await Auth.entries()).toEqual(credentials)
        await expect(ProviderConnection.remove(providerID)).rejects.toBeInstanceOf(ProviderConnection.NotManaged)
      },
    }),
  )
})

test("allows providers writes during cold profile enumeration and merges the latest config", async () => {
  const providerID = "configured-during-enumeration"
  const enumerationStarted = Promise.withResolvers<void>()
  const releaseEnumeration = Promise.withResolvers<void>()
  await using runtime = await testRuntime({
    register() {
      ProviderPluginAuth.register({
        async authProviderProfiles() {
          enumerationStarted.resolve()
          await releaseEnumeration.promise
          return []
        },
        async authProviderHooks() {
          return []
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const concurrent = {
          provider: {
            [providerID]: {
              profile: "deepseek",
              modelsDevProviderID: "deepseek",
              name: "Concurrent account",
              api: "https://concurrent-account.invalid/v1",
              options: { timeout: 4321 },
              models: { "chat-alias": { id: "deepseek-chat", options: {}, temperature: false } },
              whitelist: ["chat-alias"],
            },
            deepseek: { name: "Unrelated account" },
          },
          enabled_providers: ["deepseek"],
          disabled_providers: [providerID, "unrelated-disabled"],
        }
        const updating = ProviderConnection.update(providerID, { name: "Updated account", enabled: true })
        let writing: ReturnType<typeof Config.domainUpdate> | undefined
        try {
          await withTimeout(enumerationStarted.promise, 5000)
          writing = Config.domainUpdate("providers", concurrent, { mode: "replace-domain" })
          await withTimeout(writing, 5000, {
            message: "Providers write remained blocked while plugin profile enumeration was pending",
          })
          expect(await Config.domainGet("providers")).toEqual(concurrent)
          releaseEnumeration.resolve()
          const { connection, change } = await updating

          const expected = {
            ...concurrent,
            provider: {
              ...concurrent.provider,
              [providerID]: { ...concurrent.provider[providerID], name: "Updated account" },
            },
            enabled_providers: ["deepseek", providerID],
            disabled_providers: ["unrelated-disabled"],
          }
          expect(await Config.domainGet("providers")).toEqual(expected)
          expect(change.oldConfig).toMatchObject(concurrent)
          expect(change.config).toMatchObject(expected)
          expect(connection).toMatchObject({
            id: providerID,
            profileID: "deepseek",
            name: "Updated account",
            endpoint: concurrent.provider[providerID].api,
            enabled: true,
          })
        } finally {
          releaseEnumeration.resolve()
          await Promise.allSettled([updating, writing])
        }
      },
    }),
  )
}, 15000)

test("does not resurrect a configured catalog alias removed during cold profile enumeration", async () => {
  const providerID = "deepseek-retired"
  const enumerationStarted = Promise.withResolvers<void>()
  const releaseEnumeration = Promise.withResolvers<void>()
  await using runtime = await testRuntime({
    register() {
      ProviderPluginAuth.register({
        async authProviderProfiles() {
          enumerationStarted.resolve()
          await releaseEnumeration.promise
          return []
        },
        async authProviderHooks() {
          return []
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Config.domainUpdate("providers", {
          provider: { [providerID]: { profile: "deepseek", modelsDevProviderID: "deepseek", name: "Retired account" } },
        })
        const updating = ProviderConnection.update(providerID, { name: "Updated account" })
        let removing: ReturnType<typeof Config.domainUpdate> | undefined
        try {
          await withTimeout(enumerationStarted.promise, 5000)
          removing = Config.domainUpdate("providers", { provider: {} }, { mode: "replace-domain" })
          await withTimeout(removing, 5000)
          releaseEnumeration.resolve()

          await expect(updating).rejects.toBeInstanceOf(ProviderConnection.NotFound)
          expect((await Config.domainGet("providers")).provider).toEqual({})
        } finally {
          releaseEnumeration.resolve()
          await Promise.allSettled([updating, removing])
        }
      },
    }),
  )
}, 15000)

test.each(["deepseek", "deepseek-team", "standalone"])(
  "updates configured %s metadata while preserving identity, siblings, references and credentials",
  async (providerID) => {
    await using runtime = await testRuntime()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await ProviderConnection.create({ id: "deepseek-team", profileID: "deepseek", name: "Team" })
          const created = await Config.domainGet("providers")
          await Config.domainUpdate(
            "providers",
            {
              provider: {
                deepseek: { profile: "deepseek", modelsDevProviderID: "deepseek" },
                ...created.provider,
                standalone: { npm: "@ai-sdk/openai-compatible", env: [] },
                [providerID]: {
                  ...(providerID === "deepseek"
                    ? { profile: "deepseek", modelsDevProviderID: "deepseek" }
                    : providerID === "deepseek-team"
                      ? created.provider?.[providerID]
                      : { npm: "@ai-sdk/openai-compatible", env: [] }),
                  name: "Existing account",
                  api: "https://previous-account.invalid/v1",
                  options: {
                    baseURL: "https://stale-account.invalid/v1",
                    apiKey: "inline-connection-key",
                    timeout: 1234,
                  },
                  models: { "chat-alias": { id: "deepseek-chat", name: "Chat alias" } },
                  whitelist: ["chat-alias"],
                  blacklist: ["deepseek-reasoner"],
                },
              },
              enabled_providers: ["deepseek-team"],
              disabled_providers: ["deepseek", "unrelated-disabled"],
            },
            { mode: "replace-domain" },
          )
          await Config.updateGlobal({
            model: `${providerID}/chat-alias`,
            nano_model: "deepseek/deepseek-chat",
            agent: { "connection-agent": { model: "deepseek-team/deepseek-chat" } },
            command: { "connection-command": { template: "test", model: `${providerID}/chat-alias` } },
          })
          await Auth.set("deepseek", { type: "api", key: "canonical-connection-key" })
          await Auth.addToPool("deepseek", "backup", { type: "api", key: "backup-connection-key" })
          await Auth.set("deepseek-team", {
            type: "oauth",
            access: "connection-access",
            refresh: "connection-refresh",
            expires: 9999999999,
          })
          const credentials = await Auth.entries()
          const before = await Config.globalResolved()
          const { baseURL, ...options } = before.provider![providerID].options!
          const { api, ...preserved } = before.provider![providerID]
          const endpoint = providerID === "deepseek-team" ? null : "https://updated-account.invalid/v1"
          const { connection } = await ProviderConnection.update(providerID, {
            name: "  Updated account  ",
            endpoint,
            enabled: true,
          })

          expect(connection).toMatchObject({
            id: providerID,
            name: "Updated account",
            enabled: true,
            configured: true,
            removable: providerID === "deepseek-team",
          })
          expect(connection.endpoint).toBe(endpoint ?? undefined)
          const expected = {
            ...before,
            provider: {
              ...before.provider,
              [providerID]: {
                ...preserved,
                name: "Updated account",
                options,
                ...(endpoint ? { api: endpoint } : {}),
              },
            },
            enabled_providers: [...new Set([...before.enabled_providers!, providerID])],
            disabled_providers: before.disabled_providers!.filter((id) => id !== providerID),
          }
          expect(await Config.globalResolved()).toEqual(expected)
          expect(await Auth.entries()).toEqual(credentials)
          await expect(ProviderConnection.remove(providerID)).rejects.toBeInstanceOf(
            providerID === "deepseek-team" ? ProviderConnection.InUse : ProviderConnection.NotManaged,
          )
          expect(await Config.globalResolved()).toEqual(expected)
          expect(await Auth.entries()).toEqual(credentials)
        },
      }),
    )
  },
)

test("rejects unknown connections without allocating configuration or changing credentials", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Config.domainUpdate("providers", { provider: { deepseek: { name: "Existing" } } })
        await Auth.set("unknown-provider", { type: "api", key: "unknown-connection-key" })
        const before = await Config.globalResolved()
        const credentials = await Auth.entries()

        for (const providerID of ["unknown-provider", "deepseek-not-created", "constructor", "__proto__"]) {
          await expect(ProviderConnection.update(providerID, { name: "Unknown" })).rejects.toBeInstanceOf(
            ProviderConnection.NotFound,
          )
          expect(await Config.globalResolved()).toEqual(before)
          expect(await Auth.entries()).toEqual(credentials)
        }
      },
    }),
  )
})

test("keeps the existing metadata-only update schema and nonempty trimmed name contract", () => {
  expect(ProviderConnection.UpdateInput.parse({ name: ` ${"a".repeat(80)} ` })).toEqual({ name: "a".repeat(80) })
  for (const patch of [
    {},
    { name: " " },
    { name: "a".repeat(81) },
    { name: "Valid", notes: "Remark" },
    { name: "Valid", id: "new-provider-id" },
    { name: "Valid", apiKey: "replacement-key" },
  ]) {
    expect(ProviderConnection.UpdateInput.safeParse(patch).success).toBe(false)
  }
})
