import { afterEach, describe, expect, mock, test } from "bun:test"
import z from "zod"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolResolver } from "../../src/session/tool-resolver"
import { SandboxHost } from "../../src/sandbox/host"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
let implementation = containmentHost(true)
const runtime = await testRuntime({
  register: () =>
    SandboxHost.register({
      prepareWrapper: (options) => implementation.prepareWrapper(options),
      cleanupWrapper: () => implementation.cleanupWrapper(),
    }),
})

// ---------------------------------------------------------------------------
// session/shell-containment-authorization.test.ts
//
// P3 acceptance: bash authorization follows containment.
//
// `guarded` must not prompt for a read-only shell command the OS sandbox will
// contain — that is the highest-frequency interaction in the product, and the
// interim state after the ownership inversion prompted for all of them. The
// decision is therefore made against a prepared containment verdict, and a
// command the sandbox cannot wrap falls back to the ordinary capability flow
// rather than being allowed as if it were contained.
//
// Case matrix asserted here:
//   guarded    + contained     -> allow, no ask
//   guarded    + not contained -> ask (never a silent unsandboxed run)
//   autonomous + contained     -> allow, no ask
//   autonomous + not contained -> refuse, no ask
// ---------------------------------------------------------------------------

const READ_ONLY_CORPUS = ["ls -la", "cat README.md", "git status", "git log --oneline", "grep -rn foo src"]

const model = {
  id: "test-model",
  modelID: "test-model",
  providerID: "test-provider",
  api: { id: "test-model" },
  capabilities: { input: { image: false } },
} as any

function agentFor(controlProfile: string) {
  return {
    name: "synergy",
    permission: PermissionNext.fromConfig({ "*": "allow" }),
    controlProfile,
  } as any
}

/** Sandbox host whose containment verdict is fixed by the test. */
function containmentHost(contained: boolean) {
  return {
    prepareWrapper: (input: any) => ({
      command: input.command,
      args: input.args,
      sandboxed: contained,
      ...(contained ? {} : { skipReason: "test: sandbox helper unavailable" }),
    }),
    cleanupWrapper: () => {},
  }
}

/**
 * Registry bash tool mirroring the built-in one's authorization contract:
 * `shell` is neither non-bypassable nor opaque, so a `guarded` ask for a
 * shell command is owned here, gated on the resolver having already decided
 * (`shellAuthorizationResolved`). This is the flag split P3 introduced.
 */
function bashRegistryTool(executed: string[]) {
  return {
    id: "bash",
    description: "Bash tool",
    parameters: z.object({ command: z.string(), description: z.string().optional() }),
    async execute(params: { command: string }, ctx: any) {
      if (ctx.extra?.shellAuthorizationResolved !== true) {
        await ctx.ask({ permission: "bash", patterns: [params.command], metadata: {} })
      }
      executed.push(params.command)
      return { title: "bash", metadata: { exit: 0 }, output: `ran: ${params.command}` }
    },
  }
}

function minimalProcessor(executions: Map<string, Promise<any>>) {
  const callbacks = new Map<string, Promise<unknown>>()
  return {
    message: { id: "msg_p3_containment", rootID: "msg_p3_root", parentID: "msg_p3_root" },
    partFromToolCall: () => undefined,
    updateToolCallState: async () => {},
    executeOnce: <T>(id: string, execute: () => Promise<T>) => {
      const existing = callbacks.get(id)
      if (existing) return existing as Promise<T>
      const callback = Promise.resolve().then(execute)
      callbacks.set(id, callback)
      return callback
    },
    beginExecution: (id: string) => {
      let outcome: any
      let resolvePromise!: (value: any) => void
      const promise = new Promise<any>((resolve) => {
        resolvePromise = resolve
      })
      executions.set(id, promise)
      return {
        callID: id,
        promise,
        resolve(value: any) {
          if (outcome) return
          outcome = value
          resolvePromise(value)
        },
        complete(input: unknown, result: any) {
          this.resolve({ status: "completed", input, result })
        },
        fail(input: unknown, error: string, metadata?: Record<string, any>) {
          this.resolve({ status: "error", input, error, metadata })
        },
        get outcome() {
          return outcome
        },
        get status() {
          return outcome ? "resolved" : "pending"
        },
      }
    },
  } as any
}

async function waitForPermission(sessionID: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pending = (await PermissionNext.list()).filter((item) => item.sessionID === sessionID)
    if (pending.length > 0) return pending[0]
    await Bun.sleep(10)
  }
  return undefined
}

async function resolveBash(input: { controlProfile: string; sessionID: string; executed: string[] }) {
  const executions = new Map<string, Promise<any>>()
  const originalRegistryTools = ToolRegistry.tools
  ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool(input.executed)])
  try {
    const resolved = await ToolResolver.resolveWithAvailability({
      agent: agentFor(input.controlProfile),
      model,
      sessionID: input.sessionID,
      processor: minimalProcessor(executions),
      userTools: { bash: true },
      includeMCP: false,
    })
    return {
      bash: resolved.executionTools.bash as any,
      executions,
      restore: () => {
        ;(ToolRegistry.tools as any) = originalRegistryTools
      },
    }
  } catch (error) {
    ;(ToolRegistry.tools as any) = originalRegistryTools
    throw error
  }
}

afterEach(() =>
  runtime.run(async () => {
    implementation = containmentHost(true)
    try {
      for (const entry of await PermissionNext.list()) {
        await PermissionNext.reply({ requestID: entry.id, reply: "reject" }).catch(() => {})
      }
    } catch {
      // Pending asks are scope-scoped.
    }
  }),
)

describe("bash authorization follows containment", () => {
  test("guarded allows contained read-only commands without prompting", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          implementation = containmentHost(true)
          const executed: string[] = []
          const { bash, executions, restore } = await resolveBash({
            controlProfile: "guarded",
            sessionID: "ses_p3_guarded_contained",
            executed,
          })
          try {
            for (const command of READ_ONLY_CORPUS) {
              const callID = `call_p3_${command.replace(/\W+/g, "_")}`
              await bash.execute({ command, description: command }, { toolCallId: callID })
              const outcome = await executions.get(callID)
              expect({ command, status: outcome?.status }).toEqual({ command, status: "completed" })
              const pending = (await PermissionNext.list()).filter(
                (item) => item.sessionID === "ses_p3_guarded_contained",
              )
              expect({ command, asks: pending.length }).toEqual({ command, asks: 0 })
            }
            expect(executed).toEqual(READ_ONLY_CORPUS)
          } finally {
            restore()
          }
        },
      })
    }))

  test("guarded asks when the sandbox cannot contain the command", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          implementation = containmentHost(false)
          const executed: string[] = []
          const { bash, restore } = await resolveBash({
            controlProfile: "guarded",
            sessionID: "ses_p3_guarded_uncontained",
            executed,
          })
          try {
            const pending = waitForPermission("ses_p3_guarded_uncontained")
            const run = bash
              .execute({ command: "ls -la", description: "ls" }, { toolCallId: "call_p3_uncontained" })
              .catch((error: unknown) => error)
            const request = await pending
            expect(request).toBeDefined()
            expect(request!.permission).toBe("bash")
            await PermissionNext.reply({ requestID: request!.id, reply: "reject" })
            await run
            // Refused, not run silently outside the sandbox.
            expect(executed).toEqual([])
          } finally {
            restore()
          }
        },
      })
    }))

  test("autonomous allows contained commands and refuses uncontained ones", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          implementation = containmentHost(true)
          const containedRuns: string[] = []
          const contained = await resolveBash({
            controlProfile: "autonomous",
            sessionID: "ses_p3_auto_contained",
            executed: containedRuns,
          })
          try {
            await contained.bash.execute({ command: "ls -la", description: "ls" }, { toolCallId: "call_p3_auto_ok" })
            const outcome = await contained.executions.get("call_p3_auto_ok")
            expect(outcome?.status).toBe("completed")
            expect(containedRuns).toEqual(["ls -la"])
          } finally {
            contained.restore()
          }

          implementation = containmentHost(false)
          const uncontainedRuns: string[] = []
          const uncontained = await resolveBash({
            controlProfile: "autonomous",
            sessionID: "ses_p3_auto_uncontained",
            executed: uncontainedRuns,
          })
          try {
            await uncontained.bash
              .execute({ command: "ls -la", description: "ls" }, { toolCallId: "call_p3_auto_denied" })
              .catch((error: unknown) => error)
            const outcome = await uncontained.executions.get("call_p3_auto_denied")
            expect(outcome?.status).toBe("error")
            expect(outcome?.error).toMatch(/cannot contain/i)
            expect(uncontainedRuns).toEqual([])
            const pending = (await PermissionNext.list()).filter((item) => item.sessionID === "ses_p3_auto_uncontained")
            expect(pending).toHaveLength(0)
          } finally {
            uncontained.restore()
          }
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
