import { expect, test } from "bun:test"
import path from "node:path"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { PermissionRules } from "@ericsanchezok/synergy-harness/permission/rules"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { SessionProcessor, ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"

const env = {
  SYNERGY_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "fixture-key" } } } }),
}
const patterns = [
  "git init .permission-repo",
  "git -C .permission-repo switch -c reviewed",
  "git -C .permission-repo symbolic-ref --short HEAD",
]
const command = patterns.join(" && ")

async function task(controlProfile: "guarded" | "autonomous" = "guarded") {
  const session = await Session.create({ controlProfile })
  const model = await Provider.getModel("openai", "gpt-4o")
  const rootID = Identifier.ascending("message")
  const agent = Agent.Info.parse({
    name: "fixture",
    mode: "primary",
    options: {},
    controlProfile: "guarded",
    permission: PermissionNext.fromConfig({ "*": "allow" }),
  })
  await Session.updateMessage({
    id: rootID,
    rootID,
    isRoot: true,
    sessionID: session.id,
    role: "user",
    agent: agent.name,
    model: { providerID: model.providerID, modelID: model.id },
    time: { created: Date.now() },
  })
  const message = await Session.updateMessage({
    id: Identifier.ascending("message"),
    rootID,
    parentID: rootID,
    sessionID: session.id,
    role: "assistant",
    agent: agent.name,
    modelID: model.id,
    providerID: model.providerID,
    mode: "default",
    path: { cwd: session.workspace?.path ?? null, root: session.workspace?.path ?? null },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  })
  if (message.role !== "assistant") throw new Error("The original tool driver requires its assistant message")
  const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
  await RolloutLedger.beginRun(owner, rootID)
  const abort = new AbortController()
  const processor = SessionProcessor.create({
    assistantMessage: message,
    sessionID: session.id,
    model,
    abort: abort.signal,
  })
  const resolved = await ToolResolver.resolveWithAvailability({
    agent,
    model,
    session,
    sessionID: session.id,
    processor,
    includeMCP: false,
  })
  const tool = resolved.executionTools.bash
  if (!tool?.execute) throw new Error("The selected Local Runtime must expose its real Bash tool")
  const active = new Set<Promise<unknown>>()
  return {
    session,
    parts: () => MessageV2.parts({ sessionID: session.id, messageID: message.id }),
    execute(command: string) {
      const pending = processor.executeToolCall({
        callID: Identifier.ascending("part"),
        toolName: "bash",
        args: { command, yieldSeconds: 1 },
        tool,
        executor: resolved.executorKinds.bash,
        workBrief: "Verify native saved shell permission rules",
      })
      active.add(pending)
      void pending.finally(() => active.delete(pending)).catch(() => {})
      return pending
    },
    async [Symbol.asyncDispose]() {
      abort.abort(new DOMException("Fixture driver closed", "AbortError"))
      await Promise.allSettled(active)
      processor.dispose("saved shell rules fixture")
      const tools = await RolloutLedger.tools(owner, rootID)
      await RolloutLedger.finishRun(
        owner,
        rootID,
        tools.some((item) => item.status !== "completed") ? "failed" : "completed",
      )
      await Session.remove(session.id)
    },
  }
}

function observe(sessionID: string) {
  const next = Promise.withResolvers<PermissionNext.Request>()
  const requests: PermissionNext.Request[] = []
  const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
    if (event.properties.sessionID !== sessionID) return
    requests.push(event.properties)
    next.resolve(event.properties)
  })
  return { requests, next: next.promise, [Symbol.dispose]: unsubscribe }
}

function outcome(
  pending: ReturnType<Awaited<ReturnType<typeof task>>["execute"]>,
  asked: Promise<PermissionNext.Request>,
) {
  return Promise.race([
    pending.then(
      (value) => ({ kind: "result" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    asked.then((request) => ({ kind: "permission" as const, request })),
  ])
}

test("native always permission rules cover every exact Bash pattern in another Session and Scope", async () => {
  await using runtime = await testRuntime({ env })
  await runtime.run(async () => {
    await using p = await tmpdir({ git: true })
    await using q = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await p.scope(),
      fn: async () => {
        await using original = await task()
        using asked = observe(original.session.id)
        const pending = original.execute(command)
        const first = await outcome(pending, asked.next)
        if (first.kind === "error") throw first.error
        expect(first.kind).toBe("permission")
        if (first.kind !== "permission") return
        expect(first.request.patterns).toEqual(patterns)
        await PermissionNext.reply({ requestID: first.request.id, reply: "always" })
        expect((await pending).metadata.exit).toBe(0)
        expect(await PermissionRules.userRuleset()).toEqual(
          patterns.map((pattern) => ({ permission: "bash", pattern, action: "allow", scope: "user" })),
        )
      },
    })
    await ScopeContext.provide({
      scope: await q.scope(),
      fn: async () => {
        await using independent = await task()
        using asked = observe(independent.session.id)
        const result = await outcome(independent.execute(command), asked.next)
        expect(result.kind).toBe("result")
        if (result.kind !== "result") return
        expect(result.value.metadata.exit).toBe(0)
        expect(result.value.output).toContain("reviewed")
        expect(asked.requests).toEqual([])
        expect(await Bun.file(path.join(q.path, ".permission-repo", ".git", "HEAD")).text()).toBe(
          "ref: refs/heads/reviewed\n",
        )
      },
    })
  })
}, 20000)

for (const denial of [false, true])
  test(
    "native Bash requires complete saved coverage and preserves a later denial (deny=" + denial + ")",
    async () => {
      await using runtime = await testRuntime({ env })
      await runtime.run(async () => {
        await using directory = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await directory.scope(),
          fn: async () => {
            await PermissionRules.addUserRules(
              patterns.slice(0, 2).map((pattern) => ({ permission: "bash", pattern, action: "allow" })),
            )
            if (denial) {
              await PermissionRules.addUserRule({ permission: "bash", pattern: patterns[2], action: "deny" })
              await PermissionRules.addUserRule({ permission: "bash", pattern: patterns[2], action: "allow" })
            }
            await using original = await task()
            using asked = observe(original.session.id)
            const result = await outcome(original.execute(command), asked.next)
            if (denial) {
              expect(result.kind).toBe("error")
              if (result.kind === "error") expect(result.error).toBeInstanceOf(PermissionNext.DeniedError)
              expect(asked.requests).toEqual([])
            } else {
              expect(result.kind).toBe("permission")
              if (result.kind === "permission") expect(result.request.patterns).toEqual(patterns)
              expect(
                (await PermissionNext.list()).filter((item) => item.sessionID === original.session.id),
              ).toHaveLength(1)
            }
            expect(await Bun.file(path.join(directory.path, ".permission-repo", ".git", "HEAD")).exists()).toBe(false)
          },
        })
      })
    },
    15000,
  )

test("a saved exact Bash allow does not remove mandatory native destructive confirmation", async () => {
  await using runtime = await testRuntime({ env })
  await runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const destructive = "git reset --hard"
        await PermissionRules.addUserRule({ permission: "bash", pattern: destructive, action: "allow" })
        await using original = await task()
        using asked = observe(original.session.id)
        const result = await outcome(original.execute(destructive), asked.next)
        expect(result.kind).toBe("permission")
        if (result.kind !== "permission") return
        expect(result.request.metadata.nonBypassable).toBe(true)
        expect((await PermissionNext.list()).filter((item) => item.sessionID === original.session.id)).toHaveLength(1)
      },
    })
  })
}, 15000)

test("profile-auto-allowed Bash still checks native exact denies and records user denial", async () => {
  await using runtime = await testRuntime({ env })
  await runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const ordinary = "printf native-denied"
        await PermissionRules.addUserRule({ permission: "bash", pattern: ordinary, action: "deny" })
        await using original = await task("autonomous")
        using asked = observe(original.session.id)
        const result = await outcome(original.execute(ordinary), asked.next)
        expect(result.kind).toBe("error")
        if (result.kind === "error") expect(result.error).toBeInstanceOf(PermissionNext.DeniedError)
        expect(asked.requests).toEqual([])
        const part = (await original.parts()).find((part) => part.type === "tool" && part.tool === "bash")
        expect(part).toMatchObject({ state: { metadata: { approval: { source: "user", status: "auto_denied" } } } })
        const executions = []
        for await (const execution of EnvironmentExecution.sessionEntries({
          scopeID: original.session.scope.id,
          sessionID: original.session.id,
        }))
          executions.push(execution)
        expect(executions).toEqual([])
      },
    })
  })
}, 15000)
