import { expect, test, spyOn } from "bun:test"
import path from "node:path"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { PermissionRules } from "@ericsanchezok/synergy-harness/permission/rules"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { EnforcementError } from "@ericsanchezok/synergy-harness/enforcement/errors"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { SessionProcessor, ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { FileEntry } from "../../src/file/entry"
import { FileView } from "../../src/file/view"

async function prepare(
  permission: PermissionNext.Ruleset,
  profile: "guarded" | "autonomous" | "full_access" = "guarded",
  abort = new AbortController(),
) {
  const session = await Session.create({ controlProfile: profile })
  const model = await Provider.getModel("openai", "gpt-4o")
  const assistantMessage = {
    id: `msg_${crypto.randomUUID()}`,
    sessionID: session.id,
    role: "assistant" as const,
    parentID: "msg_user",
    modelID: model.id,
    providerID: model.providerID,
    mode: "build",
    agent: "fixture",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  }
  await Session.updateMessage(assistantMessage)
  const processor = SessionProcessor.create({
    assistantMessage,
    sessionID: session.id,
    model,
    abort: abort.signal,
  })
  const agent = Agent.Info.parse({ name: "fixture", mode: "primary", options: {}, controlProfile: profile, permission })
  const resolved = await ToolResolver.resolveWithAvailability({
    agent,
    model,
    session,
    sessionID: session.id,
    processor,
    includeMCP: false,
  })
  return {
    session,
    processor,
    runID: assistantMessage.parentID,
    execute(id: string, args: Record<string, unknown>) {
      const tool = resolved.executionTools[id]
      if (!tool?.execute) throw new Error(`Unavailable tool: ${id}`)
      return processor.executeToolCall({
        callID: `call_${crypto.randomUUID()}`,
        toolName: id,
        args,
        tool,
        executor: resolved.executorKinds[id],
        workBrief: "File interface regression",
      })
    },
    parts: () => MessageV2.parts({ sessionID: session.id, messageID: assistantMessage.id }),
    async [Symbol.asyncDispose]() {
      processor.dispose("test")
      await Session.remove(session.id)
    },
  }
}

for (const group of ["replace", "hashline", "patch"] as const)
  test(`real ${group} readers enforce path rules and saved precedence`, async () => {
    await using runtime = await testRuntime({
      env: {
        SYNERGY_CONFIG_CONTENT: JSON.stringify({
          fileToolGroup: group,
          provider: { openai: { options: { apiKey: "fixture-key" } } },
        }),
      },
    })
    await runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "private/secret.txt"), "private needle\n")
          await Bun.write(path.join(dir, "allowed.txt"), "allowed needle\n")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const secret = path.join(tmp.path, "private/secret.txt")
          await using denied = await prepare(
            PermissionNext.fromConfig({ "*": "allow", read: { [path.join(tmp.path, "private/*")]: "deny" } }),
          )
          await expect(
            denied.execute(group === "hashline" ? "view_file" : "read", { filePath: secret }),
          ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
          await expect(
            denied.execute("file_search", { mode: "content", query: "private needle" }),
          ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
          if (group === "hashline")
            await expect(denied.execute("scan_files", { pattern: "private needle" })).rejects.toBeInstanceOf(
              PermissionNext.DeniedError,
            )
          const allowedPath = path.join(tmp.path, "allowed.txt")
          await using allowed = await prepare(
            PermissionNext.fromConfig({ "*": "allow", read: { "*": "deny", [allowedPath]: "allow" } }),
          )
          expect(
            await allowed.execute("file_search", { mode: "content", query: "allowed needle", include: "allowed.txt" }),
          ).toMatchObject({ output: expect.stringContaining("allowed needle") })
          await PermissionRules.addUserRule({ permission: "read", pattern: allowedPath, action: "deny" })
          await expect(
            allowed.execute("file_search", { mode: "content", query: "allowed needle", include: "allowed.txt" }),
          ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
          PermissionRules.addSessionRule(allowed.session.id, {
            permission: "file_search",
            pattern: allowedPath,
            action: "allow",
          })
          expect(
            await allowed.execute("file_search", { mode: "content", query: "allowed needle", include: "allowed.txt" }),
          ).toMatchObject({ output: expect.stringContaining("allowed needle") })
        },
      })
    })
  }, 30_000)

test("boundary recovery does not recommend tools outside the selected interface", async () => {
  await using runtime = await testRuntime({
    env: { SYNERGY_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "fixture-key" } } } }) },
  })
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await using prepared = await prepare(PermissionNext.fromConfig({ "*": "allow" }))
        using blocked = spyOn(FileView, "file").mockImplementation(() => {
          throw new EnforcementError.BoundaryHit("outside selected Workspace", "/outside/file.txt")
        })
        await expect(prepared.execute("read", { filePath: "file.txt" })).rejects.toBeInstanceOf(
          EnforcementError.BoundaryHit,
        )
        const part = (await prepared.parts()).find((part) => part.type === "tool" && part.tool === "read")
        expect(part?.type === "tool" && part.state.status === "error" ? part.state.error : "").toMatch(
          /workspace-relative/,
        )
        expect(part?.type === "tool" && part.state.status === "error" ? part.state.error : "").not.toMatch(
          /view_file|scan_files/,
        )
      },
    })
  })
}, 30_000)

test("production patch execution persists the destination write when source removal fails", async () => {
  await using runtime = await testRuntime({
    env: { SYNERGY_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "fixture-key" } } } }) },
  })
  await runtime.run(async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "source.txt"), "before\n")
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await using prepared = await prepare(PermissionNext.fromConfig({ "*": "allow" }))
        await prepared.execute("read", { filePath: "source.txt" })
        using failure = spyOn(FileEntry, "remove").mockRejectedValue(new Error("source removal rejected by filesystem"))
        await expect(
          prepared.execute("apply_patch", {
            patch:
              "*** Begin Patch\n*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-before\n+after\n*** Add File: unattempted.txt\n+x\n*** End Patch",
          }),
        ).rejects.toThrow("source removal rejected")
        expect(failure).toHaveBeenCalledTimes(1)
        const part = (await prepared.parts()).find((part) => part.type === "tool" && part.tool === "apply_patch")
        expect(part).toMatchObject({
          state: {
            status: "error",
            metadata: {
              outcome: "partial",
              files: [{ file: "destination.txt", beforeBytes: 0, afterBytes: 6 }],
              sections: [
                {
                  source: "source.txt",
                  observedPath: "destination.txt",
                  state: "failed",
                  operations: [
                    { phase: "write", path: "destination.txt", state: "committed" },
                    { phase: "delete", path: "source.txt", state: "failed" },
                  ],
                },
                { source: "unattempted.txt", state: "not_started" },
              ],
            },
          },
        })
        expect(await Bun.file(path.join(tmp.path, "source.txt")).text()).toBe("before\n")
        expect(await Bun.file(path.join(tmp.path, "destination.txt")).text()).toBe("after\n")
        expect(await Bun.file(path.join(tmp.path, "unattempted.txt")).exists()).toBe(false)
      },
    })
  })
}, 30_000)

for (const stage of ["metadata", "activity-mask", "result-mask"] as const)
  test(`cancellation during ${stage} after the final patch commit retains the applied ledger and interruption`, async () => {
    await using runtime = await testRuntime({
      env: { SYNERGY_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "fixture-key" } } } }) },
    })
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const abort = new AbortController()
          await using prepared = await prepare(PermissionNext.fromConfig({ "*": "allow" }), "guarded", abort)
          const original = prepared.processor.updateToolCallState.bind(prepared.processor)
          using update = spyOn(prepared.processor, "updateToolCallState").mockImplementation(async (...args) => {
            const result = await original(...args)
            if (stage === "metadata" && args[1]?.metadata?.outcome === "applied")
              abort.abort(new DOMException("cancel after commit", "AbortError"))
            return result
          })
          const originalMask = SecretMask.transformResult
          let resultMasks = 0
          using mask = spyOn(SecretMask, "transformResult").mockImplementation(async (value, signal) => {
            if (typeof value.output === "string" && value.output.startsWith("Patch applied.")) {
              if (value.metadata?.outcome === "applied") resultMasks++
              if ((stage === "activity-mask" && !value.metadata) || (stage === "result-mask" && resultMasks === 3))
                abort.abort(new DOMException("cancel after commit", "AbortError"))
            }
            return originalMask(value, signal)
          })
          await expect(
            prepared.execute("apply_patch", {
              patch: "*** Begin Patch\n*** Add File: last.txt\n+committed\n*** End Patch",
            }),
          ).rejects.toMatchObject({ name: "AbortError", message: expect.stringContaining("write: committed") })
          expect(await Bun.file(path.join(tmp.path, "last.txt")).text()).toBe("committed\n")
          const owner = {
            kind: "session" as const,
            scopeID: ScopeContext.current.scope.id,
            sessionID: prepared.session.id,
          }
          const [tool] = await RolloutLedger.tools(owner, prepared.runID)
          expect(tool.status).toBe("interrupted")
          expect(tool.rawResult).toBeDefined()
          const chunks: Uint8Array[] = []
          for await (const chunk of RolloutArtifact.read(owner, tool.rawResult!.id)) chunks.push(chunk)
          expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
            metadata: {
              outcome: "applied",
              sections: [
                { source: "last.txt", state: "committed", operations: [{ phase: "write", state: "committed" }] },
              ],
            },
          })
          expect(
            (await prepared.parts()).find((part) => part.type === "tool" && part.tool === "apply_patch"),
          ).toMatchObject({
            state: {
              status: "error",
              error: expect.stringContaining("write: committed"),
              metadata: { outcome: "applied", sections: [{ state: "committed" }] },
            },
          })
        },
      })
    })
  }, 30_000)

for (const action of ["deny", "ask"] as const)
  test(`a later exact file allow preserves saved ${action} and mandatory external approval`, async () => {
    await using runtime = await testRuntime({
      env: { SYNERGY_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "fixture-key" } } } }) },
    })
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const target = path.join(runtime.host.home, "external-patch.txt")
          await PermissionRules.addUserRule({ permission: "edit", pattern: "*", action })
          await PermissionRules.addUserRule({ permission: "apply_patch", pattern: target, action: "allow" })
          await using prepared = await prepare(PermissionNext.fromConfig({ "*": "allow" }))
          const requests: PermissionNext.Request[] = []
          const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, async (event) => {
            requests.push(event.properties)
            await PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
          })
          try {
            const execute = () =>
              prepared.execute("apply_patch", {
                patch: `*** Begin Patch\n*** Add File: ${target}\n+approved\n*** End Patch`,
              })
            if (action === "deny") {
              await expect(execute()).rejects.toBeInstanceOf(EnforcementError.PolicyDenied)
              expect(requests).toHaveLength(0)
              expect(await Bun.file(target).exists()).toBe(false)
              return
            }
            expect(await execute()).toMatchObject({ metadata: { outcome: "applied" } })
            expect(requests.some((request) => request.permission === "external_directory")).toBe(true)
            expect(await Bun.file(target).text()).toBe("approved\n")
          } finally {
            unsubscribe()
          }
        },
      })
    })
  }, 30_000)
