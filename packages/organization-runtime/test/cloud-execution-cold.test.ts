import { expect, test } from "bun:test"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import {
  OrganizationCloudExecutionProtocol as CloudExecution,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { cloudExecutionFixture } from "./support/cloud-execution"
import { OrganizationRuntimeError } from "../src/error"
import { measurePhase } from "@ericsanchezok/synergy-harness/test/support/rollout"

function unknownOutcome(error: unknown): boolean {
  if (error instanceof OrganizationRuntimeError && error.data.outcome === "unknown") return true
  if (error instanceof AggregateError && error.errors.some(unknownOutcome)) return true
  return error instanceof Error && error.cause !== undefined && unknownOutcome(error.cause)
}

test.skipIf(process.platform === "win32")(
  "a cold original Runtime retires its accepted remote command before settling its retained root",
  async () => {
    const f = await cloudExecutionFixture()
    const errors: unknown[] = []
    try {
      const member = await f.member("original-cold-owner")
      const originalRuntime = member.runtime
      const program = [
        "await Bun.write('cold-live.txt', 'original unsaved cold bytes\\n');",
        "process.stdout.write('ORIGINAL_COLD_READY\\n');",
        "await new Promise(resolve => process.stdin.once('data', resolve));",
      ].join("\n")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const started = await member.bash(`${quote(process.execPath)} -e ${quote(program)}`)
      await f.waitForOutput(started.executionID, "ORIGINAL_COLD_READY")
      const original = await f.physical(started.executionID)
      const scopeID = await member.runtime.run(async () => (await Session.get(member.sessionID)).scope.id)
      expect(original.execution.state).toBe("running")
      expect(original.uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution")).toBe(true)
      const actual = () =>
        f.service.service.maintenance.run(async () => ({
          execution: await EnvironmentExecution.get(original.execution.id, original.execution.scopeID),
          uses: await Environment.uses(original.execution.target.environmentID),
        }))
      f.service.interceptHTTP(async (request) => {
        if (!new URL(request.url).pathname.startsWith("/runtime/v1/environments/execution")) return
        return Response.json(
          {
            code: "SERVICE_UNAVAILABLE",
            message: "Original receipt transport is unavailable",
            outcome: "unknown",
            retryable: false,
          },
          { status: 503 },
        )
      })
      try {
        await expect(member.close()).rejects.toThrow()
        expect(originalRuntime.status).toBe("closed")
        expect((await actual()).execution.state).toBe("running")
      } finally {
        f.service.interceptHTTP(undefined)
      }
      const reopened = await member.reopen()
      expect(reopened === originalRuntime).toBe(false)
      const signal = AbortSignal.timeout(5000)
      try {
        for (;;) {
          signal.throwIfAborted()
          const info = await reopened.run(() => EnvironmentExecution.get(started.executionID, scopeID))
          if (info.state === "completed") break
          await Bun.sleep(10)
        }
      } catch (error) {
        const local = await reopened.run(async () => {
          const session = await Session.get(member.sessionID),
            owner = RolloutLifecycle.owner(session)
          const run = await RolloutLedger.getRun(owner, member.accepted.effect.messageID)
          const processes = await RolloutLedger.processes(owner, run.id)
          const info = await EnvironmentExecution.get(started.executionID, scopeID)
          return {
            state: info.state,
            provider: info.source?.provider,
            run: { status: run.status, recording: run.recording },
            processes: processes.map((row) => ({ status: row.status, recording: row.stream.status })),
          }
        })
        const native = await actual()
        throw new Error(
          "Original cold cleanup predicate failed: " +
            JSON.stringify({
              originalRuntime: originalRuntime.status,
              reopened: reopened.status,
              heartbeatObserved: true,
              local,
              native: {
                state: native.execution.state,
                status: native.execution.status?.state,
                operationUse: native.uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution"),
              },
              allocations: f.allocations(),
            }),
          { cause: error },
        )
      }
      const completed = await actual()
      expect(completed.execution.state).toBe("completed")
      expect(completed.execution.status).toMatchObject({ treeDrained: true, streamsDrained: true })
      expect(completed.uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution")).toBe(false)
      expect(f.allocations()).toBe(1)
      expect((await f.head()).contentRevision).toBeGreaterThan(f.workspace.contentRevision)
    } catch (error) {
      errors.push(error)
    }
    try {
      await f[Symbol.asyncDispose]()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Cold original Runtime and native cleanup failed")
  },
  30000,
)

test.skipIf(process.platform === "win32")(
  "a cold original Runtime inspects a completed command after losing its retirement acknowledgement",
  async () => {
    const f = await cloudExecutionFixture()
    const errors: unknown[] = []
    try {
      const member = await f.member("completed-cold-owner")
      const originalRuntime = member.runtime
      const program = [
        "await Bun.write('cold-ack.txt', 'original acknowledgement bytes\\n');",
        "process.stdout.write('ORIGINAL_ACK_READY\\n');",
        "await new Promise(resolve => process.stdin.once('data', resolve));",
      ].join("\n")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const started = await member.bash(`${quote(process.execPath)} -e ${quote(program)}`)
      await f.waitForOutput(started.executionID, "ORIGINAL_ACK_READY")
      const native = await f.physical(started.executionID)
      const scopeID = await member.runtime.run(async () => (await Session.get(member.sessionID)).scope.id)
      expect(native.execution.state).toBe("running")
      let retirements = 0,
        inspections = 0,
        originalStatus: number | undefined,
        receiptsBlocked = false
      f.service.interceptHTTP(async (request) => {
        const pathname = new URL(request.url).pathname
        if (
          pathname === "/runtime/v1/environments/execution/retirement/inspection" ||
          pathname === "/runtime/v1/environments/execution/inspection"
        ) {
          inspections++
          const response = await f.service.service.fetch(request)
          return receiptsBlocked
            ? Response.json(
                {
                  code: "SERVICE_UNAVAILABLE",
                  message: "Original completion receipt transport is unavailable",
                  outcome: "unknown",
                  retryable: false,
                },
                { status: 503 },
              )
            : response
        }
        if (pathname !== "/runtime/v1/environments/execution/retirement") return
        const signed = CloudExecution.RetirementRequest.parse(await request.clone().json())
        if (signed.proof.kind !== "execution" || signed.proof.reference.sessionID !== member.sessionID) return
        retirements++
        receiptsBlocked = true
        const response = await f.service.service.fetch(request)
        originalStatus = response.status
        return response.status === 200 ? Response.json(null) : response
      })
      try {
        let failure: unknown
        try {
          await member.close()
        } catch (error) {
          failure = error
        }
        expect(originalStatus).toBe(200)
        expect(unknownOutcome(failure)).toBe(true)
        expect(originalRuntime.status).toBe("closed")
        const completed = await f.service.service.maintenance.run(async () => ({
          execution: await EnvironmentExecution.get(native.execution.id, native.execution.scopeID),
          uses: await Environment.uses(native.execution.target.environmentID),
        }))
        expect(completed.execution.state).toBe("completed")
        expect(completed.execution.status).toMatchObject({ treeDrained: true, streamsDrained: true })
        expect(completed.uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution")).toBe(false)
        const before = inspections,
          effects = f.nativeEffects(native.execution.id)
        expect(effects.cancel).toBeGreaterThan(0)
        expect(effects.release).toBeGreaterThan(0)
        receiptsBlocked = false
        const reopened = await member.reopen()
        expect(reopened === originalRuntime).toBe(false)
        const signal = AbortSignal.timeout(5000)
        for (;;) {
          signal.throwIfAborted()
          const info = await reopened.run(() => EnvironmentExecution.get(started.executionID, scopeID))
          if (info.state === "completed") break
          await Bun.sleep(10)
        }
        expect(inspections).toBeGreaterThan(before)
        expect(retirements).toBe(1)
        expect(f.nativeEffects(native.execution.id)).toEqual(effects)
        expect(f.nativeStarts()).toBe(1)
        expect(f.allocations()).toBe(1)
      } finally {
        f.service.interceptHTTP(undefined)
      }
    } catch (error) {
      errors.push(error)
    }
    try {
      await f[Symbol.asyncDispose]()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Cold original acknowledgement and native cleanup failed")
  },
  30000,
)

test.skipIf(process.platform === "win32")(
  "a cold original Runtime retires an unacknowledged native preparation without starting its command",
  async () => {
    const started = performance.now()
    let stage = "fixture"
    let lastCleanup:
      | {
          observedAt: number
          preparationState: string
          retainedSandboxes: number
          preparationUses: number
          executions: number
          nativeStarts: number
        }
      | undefined
    const f = await measurePhase("cold-preparation.fixture", cloudExecutionFixture)
    const failures: unknown[] = []
    const gate = f.holdSandboxOnce()
    const controller = new AbortController()
    let pending: Promise<void> | undefined
    try {
      stage = "member"
      const member = await measurePhase("cold-preparation.member", () => f.member("preparation-cold-owner"))
      const originalRuntime = member.runtime
      const originalResponse = Promise.withResolvers<void>()
      let blocking = false,
        blocked = 0,
        preparationReply: number | undefined
      let cleanupFailure:
        { path: string; status: number; code?: string; message?: string; outcome?: string } | undefined
      f.service.interceptHTTP(async (request) => {
        const pathname = new URL(request.url).pathname
        if (pathname.startsWith("/runtime/v1/environments/cleanups")) {
          const response = await f.service.service.fetch(request)
          if (response.status >= 400) {
            const error = OrganizationProtocol.Error.safeParse(
              await response
                .clone()
                .json()
                .catch(() => undefined),
            )
            cleanupFailure = {
              path: pathname,
              status: response.status,
              ...(error.success && {
                code: error.data.code,
                message: error.data.message,
                outcome: error.data.outcome,
              }),
            }
          }
          return response
        }
        if (!pathname.startsWith("/runtime/v1/environments/execution")) return
        const signed =
          pathname === "/runtime/v1/environments/execution"
            ? CloudExecution.Request.parse(await request.clone().json())
            : undefined
        if (!blocking && signed?.proof.operation.action === "prepare-sandbox") {
          try {
            const response = await f.service.service.fetch(request)
            preparationReply = response.status
            return response
          } finally {
            originalResponse.resolve()
          }
        }
        if (!blocking) return
        blocked++
        return Response.json(
          {
            code: "SERVICE_UNAVAILABLE",
            message: "Original preparation transport is unavailable",
            outcome: "unknown",
            retryable: false,
          },
          { status: 503 },
        )
      })
      let toolFailure: unknown
      pending = member.bash("touch cold-command-must-not-start.txt", controller.signal).then(
        () => {},
        (error) => {
          toolFailure = error
        },
      )
      stage = "await-native-preparation"
      const held = await Promise.race([
        gate.entered,
        pending.then(() => {
          throw new Error("Ordinary tool ended before its actual native preparation barrier", { cause: toolFailure })
        }),
      ])
      expect(held.sandboxed).toBe(true)
      const inventory = () =>
        f.service.service.maintenance.run(async () => {
          const executions: string[] = []
          for await (const info of EnvironmentExecution.entries()) executions.push(info.id)
          return { executions, uses: await Environment.uses(held.target.environmentID) }
        })
      const original = await inventory()
      expect(original.executions).toEqual([])
      expect(
        original.uses.some(
          (use) =>
            use.kind === "operation" &&
            use.ownership.kind === "execution-preparation" &&
            use.ownership.operationID === held.operationID,
        ),
      ).toBe(true)
      const receipt = await f.preparation(held.target, held.operationID)
      expect(receipt.state).toBe("prepared")
      expect(receipt.sandboxes.some((sandbox) => !sandbox.released)).toBe(true)
      expect(f.nativeStarts()).toBe(0)
      blocking = true
      stage = "abort-original-tool"
      controller.abort(new Error("Original preparation caller cancelled after its native effect"))
      await measurePhase("cold-preparation.abort-tool", () => pending!)
      expect(toolFailure).toBeDefined()
      let closeFailure: unknown
      try {
        stage = "close-original-runtime"
        await measurePhase("cold-preparation.close-original", () => member.close())
      } catch (error) {
        closeFailure = error
      }
      expect(originalRuntime.status).toBe("closed")
      expect(closeFailure).toBeDefined()
      expect(blocked).toBeGreaterThan(0)
      expect((await f.preparation(held.target, held.operationID)).state).toBe("prepared")
      stage = "original-preparation-response"
      gate.release()
      await measurePhase("cold-preparation.original-response", () => originalResponse.promise)
      expect(preparationReply).toBeDefined()
      blocking = false
      stage = "reopen-original-runtime"
      const reopened = await measurePhase("cold-preparation.reopen", () => member.reopen())
      expect(reopened === originalRuntime).toBe(false)
      const signal = AbortSignal.timeout(5000)
      try {
        stage = "cold-release-predicate"
        await measurePhase("cold-preparation.cold-release", async () => {
          for (;;) {
            signal.throwIfAborted()
            const actual = await inventory()
            const receipt = await f.preparation(held.target, held.operationID)
            lastCleanup = {
              observedAt: Date.now(),
              preparationState: receipt.state,
              retainedSandboxes: receipt.sandboxes.filter((sandbox) => !sandbox.released).length,
              preparationUses: actual.uses.filter((use) => use.ownership.kind === "execution-preparation").length,
              executions: actual.executions.length,
              nativeStarts: f.nativeStarts(),
            }
            if (
              receipt.state === "released" &&
              !actual.uses.some(
                (use) =>
                  use.ownership.kind === "execution-preparation" && use.ownership.operationID === held.operationID,
              )
            )
              break
            await Bun.sleep(10)
          }
        })
      } catch (error) {
        console.error(
          "COLD_PREPARATION_PREDICATE",
          JSON.stringify({ stage, elapsedMs: performance.now() - started, lastCleanup }),
        )
        const actual = await inventory(),
          receipt = await f.preparation(held.target, held.operationID)
        throw new Error(
          "Original cold preparation cleanup failed: " +
            JSON.stringify({
              originalRuntime: originalRuntime.status,
              reopened: reopened.status,
              preparationState: receipt.state,
              retainedSandboxes: receipt.sandboxes.filter((sandbox) => !sandbox.released).length,
              preparationUses: actual.uses.filter((use) => use.ownership.kind === "execution-preparation").length,
              executions: actual.executions.length,
              nativeStarts: f.nativeStarts(),
              cleanupFailure,
            }),
          { cause: error },
        )
      }
      stage = "final-native-assertions"
      expect((await inventory()).executions).toEqual([])
      expect(f.nativeStarts()).toBe(0)
      expect(f.allocations()).toBe(1)
    } catch (error) {
      console.error(
        "COLD_PREPARATION_FAILURE",
        JSON.stringify({ stage, elapsedMs: performance.now() - started, lastCleanup }),
      )
      failures.push(error)
    } finally {
      controller.abort(new Error("Original preparation fixture is closing"))
      gate.release()
      await pending
      f.service.interceptHTTP(undefined)
    }
    try {
      stage = "fixture-disposal"
      await measurePhase("cold-preparation.fixture-disposal", () => f[Symbol.asyncDispose]())
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, "Cold preparation and original native cleanup failed")
  },
  30000,
)
