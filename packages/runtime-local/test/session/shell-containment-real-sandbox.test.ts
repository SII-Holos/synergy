import { expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import z from "zod"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionProcessor } from "@ericsanchezok/synergy-harness/test/support/internals"
import { ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { SandboxHost } from "@ericsanchezok/synergy-harness/sandbox/host"
import { SandboxSessionApproval } from "@ericsanchezok/synergy-harness/test/support/internals"
import { EnforcementError } from "@ericsanchezok/synergy-harness/enforcement/errors"
import { formatExplanationForModel } from "@ericsanchezok/synergy-harness/sandbox/explain"
import { LocalBashBackend } from "../../src/tools/bash/local"
import { SandboxBackend } from "../../src/sandbox/backend"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

// ---------------------------------------------------------------------------
// session/shell-containment-real-sandbox.test.ts
//
// P3 criterion 4 on the real OS sandbox, not a stubbed host.
//
// The guarded approve-then-retry cycle was previously evidenced only against a
// stub `SandboxHost` that threw a hand-built `SandboxBlocked`. That cannot show
// the cycle works end to end, because the stub never proves that the built-in
// bash tool turns a real Seatbelt denial into an actionable error, nor that the
// approved path really re-enters the sandbox write roots.
//
// This drives the REAL `LocalBashBackend` under the REAL Seatbelt wrapper on
// macOS: a write outside the workspace is denied by the kernel, the denial is
// surfaced with the denied path, `guarded` asks for exactly that path, and the
// approved retry succeeds.
//
// Linux has no equivalent audit channel, so the denial-to-explanation half is
// macOS-only and this test skips elsewhere rather than faking it.
// ---------------------------------------------------------------------------

const agent = {
  name: "synergy",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  controlProfile: "guarded",
} as any

const model = {
  id: "test-model",
  modelID: "test-model",
  providerID: "test-provider",
  api: { id: "test-model" },
  capabilities: { input: { image: false } },
} as any

function bashRegistryTool() {
  return {
    id: "bash",
    description: "Bash tool",
    parameters: z.object({ command: z.string(), description: z.string().optional() }),
    async execute(params: { command: string; description?: string }, ctx: any) {
      return LocalBashBackend.execute({ command: params.command, description: params.description ?? "bash" }, ctx)
    },
  }
}

async function resolveBash(sessionID: string) {
  const session = await Session.get(sessionID)
  const processor = SessionProcessor.create({
    assistantMessage: {
      id: "msg_p3_real_sandbox",
      sessionID,
      role: "assistant",
      parentID: "msg_user",
      modelID: "test-model",
      providerID: "test-provider",
      mode: "build",
      agent: "synergy",
      path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0 },
    },
    sessionID,
    model,
    abort: new AbortController().signal,
  })
  try {
    const resolved = await ToolResolver.resolveWithAvailability({
      agent,
      model,
      sessionID,
      session,
      processor,
      userTools: { bash: true },
      includeMCP: false,
    })
    return { processor, bash: resolved.executionTools.bash as any }
  } catch (error) {
    processor.dispose("test")
    throw error
  }
}

async function waitForPermission(sessionID: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pending = (await PermissionNext.list()).filter((item) => item.sessionID === sessionID)
    if (pending.length > 0) return pending[0]
    await Bun.sleep(10)
  }
  return undefined
}

test("real Seatbelt denial is actionable and the guarded approval makes the retry succeed", () =>
  runtime.run(async () => {
    // The denial explanation needs the kernel audit channel, which is macOS-only.
    if (process.platform !== "darwin") return
    const probe = SandboxBackend.prepareWrapper({
      command: "/usr/bin/true",
      args: [],
      workspace: process.cwd(),
      sandboxMode: "workspace_write",
    })
    if (probe.skipReason) return

    await using tmp = await tmpdir({ git: true, config: { controlProfile: "guarded" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const originalRegistryTools = ToolRegistry.tools
        ;(ToolRegistry.tools as any) = mock(async () => [bashRegistryTool()])
        const session = await Session.create({ controlProfile: "guarded" })
        // The kernel reports the resolved path, and macOS resolves `/var` to
        // `/private/var`, so the expectation has to start from the real tmpdir.
        const target = path.join(fs.realpathSync(os.tmpdir()), `synergy-p3-denied-${process.pid}-${Date.now()}.txt`)
        // The redirect failure must decide the child's exit status. A trailing
        // command that succeeds on its own would mask the refusal, and the bash
        // backend deliberately surfaces a denial only when the child failed —
        // otherwise a partially denied command that finished would be reported
        // to the model as blocked. `|| exit 1` is what makes the refusal the
        // command's outcome.
        const command = `{ echo hi; } > "${target}" 2>&1 || exit 1; echo done`
        try {
          const { processor, bash } = await resolveBash(session.id)
          try {
            // ── First attempt: the kernel refuses the write ──────────────
            const pending = waitForPermission(session.id)
            const first = bash.execute({ command, description: "denied write" }, { toolCallId: "call_p3_real_first" })
            const request = await pending
            expect(request).toBeDefined()
            // The ask names exactly the denied path, not a wildcard.
            expect(request!.permission).toBe("external_directory")
            expect(request!.patterns).toEqual([target])
            await PermissionNext.reply({ requestID: request!.id, reply: "once" })
            const firstError = await first.catch((error: unknown) => error)
            expect(firstError).toBeInstanceOf(EnforcementError.SandboxBlocked)
            const blocked = firstError as InstanceType<typeof EnforcementError.SandboxBlocked>
            // The backend's own message names the denied path, so a bare EPERM
            // never reaches the model. The access is what makes the denial
            // approvable, and it is only knowable from the kernel audit record —
            // the child's own error text names the path but never the operation.
            expect(blocked.message).toContain(target)
            expect(blocked.explanation?.path).toBe(target)
            expect(blocked.explanation?.access).toBe("write")
            // The resolver formats that explanation into the text the model sees.
            const text = formatExplanationForModel(blocked.explanation, { controlProfile: "guarded" })
            expect(text).toContain(target)
            expect(text).toMatch(/execution-time boundary/i)
            expect(text).toMatch(/partial side effects/i)
            expect(text).not.toMatch(/Do not retry the same approach/i)
            // The host file was never created.
            expect(fs.existsSync(target)).toBe(false)

            // ── Retry: the approved path is now a sandbox write root ─────
            const second = await bash.execute(
              { command, description: "retry after approval" },
              { toolCallId: "call_p3_real_retry" },
            )
            expect(second.output).toContain("done")
            expect(fs.existsSync(target)).toBe(true)
          } finally {
            processor.dispose("test")
          }
        } finally {
          SandboxSessionApproval.clear(session.id)
          await Session.remove(session.id)
          ;(ToolRegistry.tools as any) = originalRegistryTools
          try {
            fs.unlinkSync(target)
          } catch {}
        }
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
