import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { createUserMessage } from "../../src/session/input"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"

test("reopening an old Session upgrades its identity and preserves continuation model selection", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  let sessionID = ""
  const model = { providerID: "fixture-provider", modelID: "fixture-model" }
  await using first = await testRuntime({ home })
  await first.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({})
        sessionID = session.id
        await Storage.update<Record<string, unknown>>(
          StoragePath.sessionInfo(Identifier.asScopeID(Scope.home().id), Identifier.asSessionID(session.id)),
          (record) => {
            record.agentOverride = "synergy-max"
            record.modelOverride = model
          },
        )
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "synergy-max",
          model,
          isRoot: true,
        })
        await Storage.update<Record<string, number>>(StoragePath.metaMigrationLogDomain("session"), (log) => {
          delete log["20261002-session-primary-agent-identities"]
        })
      },
    }),
  )
  await first.close()
  await using restarted = await testRuntime({ home })
  await restarted.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        expect((await Session.get(sessionID)).agentOverride).toBe("forge")
        expect((await Session.messages({ sessionID }))[0]!.info.agent).toBe("forge")
        const message = await createUserMessage({
          sessionID,
          noReply: true,
          parts: [{ type: "text", text: "continue" }],
        })
        expect(message.info).toMatchObject({ agent: "forge", model })
      },
    }),
  )
})

test("project config discovered after startup reuses the same owner upgrade", async () => {
  await using runtime = await testRuntime()
  await using project = await tmpdir({ git: true })
  const filepath = path.join(project.path, ".synergy", "synergy.d", "60-agents.json")
  await Bun.write(
    filepath,
    JSON.stringify({ default_agent: "synergy-max", agent: { "synergy-max": { model: "fixture/model" } } }),
  )
  await runtime.run(async () =>
    ScopeContext.provide({
      scope: await project.scope(),
      async fn() {
        expect(await Agent.defaultAgent()).toBe("forge")
        expect((await Config.current()).agent?.forge?.model).toBe("fixture/model")
        expect(JSON.parse(await Bun.file(filepath).text())).toMatchObject({
          default_agent: "forge",
          agent: { forge: { model: "fixture/model" } },
        })
      },
    }),
  )
})
