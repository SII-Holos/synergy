import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import z from "zod"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolResolver } from "../../src/session/tool-resolver"
import { SandboxHost } from "../../src/sandbox/host"
import { buildExplanation } from "../../src/sandbox/explain"
import { EnforcementError } from "../../src/enforcement/errors"
import { tmpdir } from "../support/fixture"

// ---------------------------------------------------------------------------
// session/sandbox-denial-approval.test.ts
//
// P1 anchors for sandbox denials as the normal bash failure mode.
//
// A sandbox denial is an execution-time boundary: the command was authorized,
// then stopped while running. The model therefore needs the structured
// explanation (denied path, writable roots, partial-side-effect warning), not
// just the opaque backend message. Under `guarded` the denied path must be
// approvable for exactly that path, and the approval has to reach the next
// call's sandbox write roots so a retry of the same command succeeds.
// `autonomous` stays fail-closed (no prompt) and `full_access` stays
// permission-silent.
// ---------------------------------------------------------------------------

const WORKSPACE = "/tmp/synergy-p1-sandbox-denial-ws"
const DENIED_PATH = "/tmp/synergy-p1-sandbox-denial-out.txt"

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

function sandboxBlockedError() {
  const explanation = buildExplanation({
    kind: "filesystem",
    platform: "macos",
    backend: "sandbox-exec",
    command: `/bin/sh -c out=${DENIED_PATH}; { echo hi; } > "$out"`,
    access: "write",
    path: DENIED_PATH,
    denialSource: "os",
    rawMessage: `deny(1) file-write-data ${DENIED_PATH}`,
    profileMode: "workspace_write",
    networkMode: "restricted",
    allowedReadRoots: [WORKSPACE],
    allowedWriteRoots: [WORKSPACE],
    deniedPaths: [DENIED_PATH],
  })
  return new EnforcementError.SandboxBlocked(
    `Command blocked by macos sandbox (sandbox-exec).`,
    1,
    "seatbelt_file_write",
    "raw sandbox output",
    explanation,
  )
}

/**
 * Registry bash tool that behaves like a real sandboxed command: it prepares
 * the sandbox wrapper, then succeeds only when the denied path is inside the
 * sandbox write roots for this call and fails with SandboxBlocked otherwise.
 */
function bashRegistryTool(prepare: { mock: { calls: any[][] } }) {
  return {
    id: "bash",
    description: "Bash tool",
    parameters: z.object({ command: z.string(), description: z.string().optional() }),
    async execute(params: { command: string; description?: string }, ctx: any) {
      const wrapper = await ctx.extra?.sandboxPrepare?.({ command: params.command, extraReadRoots: [] })
      const lastInput = prepare.mock.calls[prepare.mock.calls.length - 1]?.[0]
      const writableRoots: string[] = lastInput?.extraWritableRoots ?? []
      if (wrapper?.sandboxed && writableRoots.includes(DENIED_PATH)) {
        return { title: "bash", metadata: { exit: 0 }, output: "retry-succeeded" }
      }
      throw sandboxBlockedError()
    },
  }
}

function minimalProcessor(executions: Map<string, Promise<any>>) {
  const callbacks = new Map<string, Promise<unknown>>()
  return {
    message: { id: "msg_p1_sandbox", rootID: "msg_p1_sandbox_root", parentID: "msg_p1_sandbox_root" },
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

async function waitForPermission(sessionID: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pending = (await PermissionNext.list()).filter((item) => item.sessionID === sessionID)
    if (pending.length > 0) return pending[0]
    await Bun.sleep(10)
  }
  return undefined
}

async function resolveBash(input: {
  controlProfile: string
  sessionID: string
  prepare: { mock: { calls: any[][] } }
}) {
  const executions = new Map<string, Promise<any>>()
  const originalRegistryTools = ToolRegistry.tools
  ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool(input.prepare)])
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

function sandboxHost(options: { sandboxed: boolean; skipReason?: string }) {
  return {
    prepareWrapper: (input: any) => ({
      command: input.command,
      args: input.args,
      sandboxed: options.sandboxed,
      ...(options.skipReason ? { skipReason: options.skipReason } : {}),
    }),
    cleanupWrapper: () => {},
  }
}

afterEach(async () => {
  const { SandboxSessionApproval } = await import("../../src/sandbox/session-approval")
  SandboxSessionApproval.clear()
  try {
    for (const entry of await PermissionNext.list()) {
      await PermissionNext.reply({ requestID: entry.id, reply: "reject" }).catch(() => {})
    }
  } catch {
    // Pending asks are scope-scoped; nothing to clean up outside a scope.
  }
})

useSandboxHost(sandboxHost({ sandboxed: true }))

function useSandboxHost(host: Parameters<typeof SandboxHost.register>[0]) {
  SandboxHost.register(host)
}

describe("sandbox denial is actionable for the model", () => {
  test("guarded denial text carries the structured explanation instead of the opaque backend message", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepare = spyOn(SandboxHost, "prepareWrapper")
        const { bash, executions, restore } = await resolveBash({
          controlProfile: "guarded",
          sessionID: "ses_p1_guarded_text",
          prepare,
        })
        try {
          const pending = waitForPermission("ses_p1_guarded_text")
          const execution = bash
            .execute(
              { command: `out=${DENIED_PATH}; { echo hi; } > "$out"`, description: "denied write" },
              { toolCallId: "call_p1_guarded_text" },
            )
            .catch((error: unknown) => error)
          const request = await pending
          if (request) await PermissionNext.reply({ requestID: request.id, reply: "once" })
          await execution

          const outcome = await executions.get("call_p1_guarded_text")
          expect(outcome.status).toBe("error")
          const text: string = outcome.error
          expect(text).toContain(DENIED_PATH)
          expect(text).toMatch(/execution-time boundary/i)
          expect(text).toMatch(/partial side effects/i)
          expect(text).toContain("workspace_write")
          expect(text).toContain(`deny(1) file-write-data ${DENIED_PATH}`)
          // The structured explanation is not a policy refusal.
          expect(text).not.toContain("Do not retry the same approach.")
        } finally {
          restore()
          prepare.mockRestore()
        }
      },
    })
  })

  test("guarded approves the exact denied path and the retry enters the sandbox write roots", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepare = spyOn(SandboxHost, "prepareWrapper")
        const { bash, executions, restore } = await resolveBash({
          controlProfile: "guarded",
          sessionID: "ses_p1_guarded_approve",
          prepare,
        })
        try {
          const command = `out=${DENIED_PATH}; { echo hi; } > "$out"`

          const pending = waitForPermission("ses_p1_guarded_approve")
          const first = bash
            .execute({ command, description: "denied write" }, { toolCallId: "call_p1_retry_first" })
            .catch((error: unknown) => error)
          const request = await pending
          expect(request).toBeDefined()
          // The ask is scoped to exactly the denied path, not a wildcard.
          expect(request!.permission).toBe("external_directory")
          expect(request!.patterns).toEqual([DENIED_PATH])
          await PermissionNext.reply({ requestID: request!.id, reply: "once" })
          await first

          const failed = await executions.get("call_p1_retry_first")
          expect(failed.status).toBe("error")

          // Retry of the same command: the approved path is now a sandbox write root.
          const second = await bash.execute(
            { command, description: "retry after approval" },
            { toolCallId: "call_p1_retry_second" },
          )
          expect(second.output).toContain("retry-succeeded")
          const retryInput = prepare.mock.calls[prepare.mock.calls.length - 1][0]
          expect(retryInput.extraWritableRoots).toContain(DENIED_PATH)
          expect(retryInput.extraReadRoots).toContain(DENIED_PATH)
        } finally {
          restore()
          prepare.mockRestore()
        }
      },
    })
  })

  test("guarded keeps the sandbox_blocked approval metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepare = spyOn(SandboxHost, "prepareWrapper")
        const { bash, executions, restore } = await resolveBash({
          controlProfile: "guarded",
          sessionID: "ses_p1_guarded_metadata",
          prepare,
        })
        try {
          const pending = waitForPermission("ses_p1_guarded_metadata")
          const execution = bash
            .execute(
              { command: `out=${DENIED_PATH}; { echo hi; } > "$out"`, description: "denied write" },
              { toolCallId: "call_p1_guarded_metadata" },
            )
            .catch((error: unknown) => error)
          const request = await pending
          if (request) await PermissionNext.reply({ requestID: request.id, reply: "once" })
          await execution

          const outcome = await executions.get("call_p1_guarded_metadata")
          expect(outcome.status).toBe("error")
          expect(outcome.metadata?.approval?.status).toBe("sandbox_blocked")
          expect(outcome.metadata?.approval?.source).toBe("sandbox")
        } finally {
          restore()
          prepare.mockRestore()
        }
      },
    })
  })

  test("autonomous never asks and reports that no approval is possible", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepare = spyOn(SandboxHost, "prepareWrapper")
        const { bash, executions, restore } = await resolveBash({
          controlProfile: "autonomous",
          sessionID: "ses_p1_autonomous",
          prepare,
        })
        try {
          await bash
            .execute(
              { command: `out=${DENIED_PATH}; { echo hi; } > "$out"`, description: "denied write" },
              { toolCallId: "call_p1_autonomous" },
            )
            .catch((error: unknown) => error)

          const pending = await PermissionNext.list()
          expect(pending.filter((item) => item.sessionID === "ses_p1_autonomous")).toHaveLength(0)

          const outcome = await executions.get("call_p1_autonomous")
          expect(outcome.status).toBe("error")
          expect(outcome.error).toMatch(/no approval is possible/i)
          expect(outcome.error).toMatch(/cannot be retried as-is/i)
        } finally {
          restore()
          prepare.mockRestore()
        }
      },
    })
  })

  test("full_access stays permission-silent on a sandbox denial", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepare = spyOn(SandboxHost, "prepareWrapper")
        const { bash, executions, restore } = await resolveBash({
          controlProfile: "full_access",
          sessionID: "ses_p1_full_access",
          prepare,
        })
        try {
          await bash
            .execute(
              { command: `out=${DENIED_PATH}; { echo hi; } > "$out"`, description: "denied write" },
              { toolCallId: "call_p1_full_access" },
            )
            .catch((error: unknown) => error)

          const pending = await PermissionNext.list()
          expect(pending.filter((item) => item.sessionID === "ses_p1_full_access")).toHaveLength(0)

          const outcome = await executions.get("call_p1_full_access")
          expect(outcome.status).toBe("error")
          expect(outcome.error).toContain(DENIED_PATH)
        } finally {
          restore()
          prepare.mockRestore()
        }
      },
    })
  })

  test("a denial without a parseable path still explains itself and does not ask", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepare = spyOn(SandboxHost, "prepareWrapper")
        const originalRegistryTools = ToolRegistry.tools
        const executions = new Map<string, Promise<any>>()
        ;(ToolRegistry.tools as any) = mock(async () => [
          {
            id: "bash",
            description: "Bash tool",
            parameters: z.object({ command: z.string(), description: z.string().optional() }),
            async execute() {
              const explanation = buildExplanation({
                kind: "unknown",
                platform: "linux",
                backend: "bwrap",
                command: "/bin/sh -c opaque",
                denialSource: "os",
                rawMessage: "Operation not permitted",
                profileMode: "workspace_write",
                networkMode: "restricted",
                allowedWriteRoots: [WORKSPACE],
              })
              throw new EnforcementError.SandboxBlocked(
                "Command blocked by linux sandbox (bwrap).",
                1,
                "seccomp_eperm",
                "raw output",
                explanation,
              )
            },
          },
        ])
        try {
          const resolved = await ToolResolver.resolveWithAvailability({
            agent: agentFor("guarded"),
            model,
            sessionID: "ses_p1_no_path",
            processor: minimalProcessor(executions),
            userTools: { bash: true },
            includeMCP: false,
          })
          await (resolved.executionTools.bash as any)
            .execute({ command: "opaque", description: "opaque" }, { toolCallId: "call_p1_no_path" })
            .catch((error: unknown) => error)

          const pending = await PermissionNext.list()
          expect(pending.filter((item) => item.sessionID === "ses_p1_no_path")).toHaveLength(0)

          const outcome = await executions.get("call_p1_no_path")
          expect(outcome.status).toBe("error")
          expect(outcome.error).toMatch(/partial side effects/i)
          expect(outcome.error).toMatch(/no specific path could be identified/i)
        } finally {
          ;(ToolRegistry.tools as any) = originalRegistryTools
          prepare.mockRestore()
        }
      },
    })
  })
})
