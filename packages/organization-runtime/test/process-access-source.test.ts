import { expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecutionSource } from "@ericsanchezok/synergy-harness/environment/execution-source"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { AsyncLocalStorage } from "node:async_hooks"
import { OrganizationCloudExecutionProtocol as CloudExecution } from "@ericsanchezok/synergy-organization-protocol"
import { cloudExecutionFixture } from "./support/cloud-execution"
import { OrganizationRuntimeError } from "../src/error"

type Fixture = Awaited<ReturnType<typeof cloudExecutionFixture>>
type Member = Awaited<ReturnType<Fixture["member"]>>

function unknownOutcome(error: unknown): boolean {
  if (error instanceof OrganizationRuntimeError && error.data.outcome === "unknown") return true
  if (error instanceof AggregateError && error.errors.some(unknownOutcome)) return true
  return error instanceof Error && error.cause !== undefined && unknownOutcome(error.cause)
}

async function withFixture(body: (fixture: Fixture) => Promise<void>) {
  const fixture = await cloudExecutionFixture()
  const errors: unknown[] = []
  try {
    await body(fixture)
  } catch (error) {
    errors.push(error)
  }
  try {
    await fixture[Symbol.asyncDispose]()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, "Organization process access and native cleanup failed")
}

async function background(fixture: Fixture, member: Pick<Member, "bash">) {
  const program = [
    "const seed = new Uint8Array(await Bun.file('seed.bin').arrayBuffer());",
    "if (seed.join(',') !== '0,255,37,128,10') throw new Error('Another Workspace was selected');",
    "process.stdout.write('ACCEPTED_PROCESS_READY\\n');",
    "const input = await new Promise(resolve => process.stdin.once('data', resolve));",
    "if (Buffer.from(input).toString() !== 'finish\\n') throw new Error('Unexpected original process input');",
    "process.stdin.destroy();",
    "process.stdout.write('ACCEPTED_PROCESS_FINISHED\\n');",
  ].join("\n")
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const started = await member.bash(`${quote(process.execPath)} -e ${quote(program)}`)
  expect(started.result.metadata.background).toBe(true)
  const processId = started.result.metadata.processId
  if (!processId) throw new Error("Actual accepted Bash did not retain its process identity")
  await fixture.waitForOutput(started.executionID, "ACCEPTED_PROCESS_READY")
  expect((await fixture.physical(started.executionID)).execution.state).toBe("running")
  return { processId, executionID: started.executionID }
}

test.skipIf(process.platform === "win32")(
  "actual organization process controls reject another accepted root in the same Runtime",
  () =>
    withFixture(async (f) => {
      const original = await f.member("process-native-owner")
      const sibling = await original.sibling()
      expect(sibling.runtime === original.runtime).toBe(true)
      expect(sibling.registration.runtimeID).toBe(original.registration.runtimeID)
      expect(sibling.sessionID).not.toBe(original.sessionID)
      const started = await background(f, original)
      const list = await sibling.process({ action: "list" })
      const processes = z
        .object({ processes: z.array(z.object({ processId: z.string() })) })
        .parse(list.metadata).processes
      expect(processes.some((row) => row.processId === started.processId)).toBe(false)
      for (const action of ["log", "write", "kill"] as const)
        await expect(
          sibling.process({
            action,
            processId: started.processId,
            ...(action === "write" && { data: "unrelated accepted root\n" }),
          }),
        ).rejects.toThrow("unavailable to this caller")
      expect((await f.physical(started.executionID)).execution.state).toBe("running")
      expect((await original.process({ action: "poll", processId: started.processId })).metadata.status).toBe("running")
      expect(
        (await original.process({ action: "write", processId: started.processId, data: "finish\n" })).metadata.status,
      ).toBe("running")
      const completed = await original.process({
        action: "poll",
        processId: started.processId,
        block: true,
        timeoutSeconds: 5,
      })
      const physical = await f.observation(started.executionID)
      expect(physical?.stdin?.finishInput).toBe(true)
      expect(completed.metadata, JSON.stringify(physical)).toMatchObject({ status: "completed", exitCode: 0 })
    }),
  30000,
)

test.skipIf(process.platform === "win32")(
  "organization process reads reauthorize the accepted actor rather than the still active machine account",
  () =>
    withFixture(async (f) => {
      const service = f.service
      const owner = { headers: service.headers, throwOnError: true as const }
      const invite = (await service.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, owner)).data
      const password = "separate process actor integration password"
      const actor = (
        await service.client.orgInvites.consume(
          {
            orgInviteConsume: {
              token: invite.token,
              requestID: "process-current-actor",
              loginName: "process-actor",
              displayName: "Process actor",
              password,
            },
          },
          { throwOnError: true },
        )
      ).data
      const login = await service.client.orgAuth.login(
        { orgLoginInput: { loginName: "process-actor", password } },
        { throwOnError: true },
      )
      const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
      if (!cookie) throw new Error("Actual process actor login did not establish a session")
      const actorHeaders = { cookie, "x-csrf-token": login.data.csrfToken }
      await service.client.orgProjects.member(
        {
          projectID: f.project.projectID,
          accountID: actor.accountID,
          orgProjectMemberChange: { expectedRevision: f.project.revision, role: "collaborator" },
        },
        owner,
      )
      for (const resourceID of f.resourceIDs)
        await service.client.orgResourceGrants.set(
          {
            resourceID,
            kind: "account",
            subjectID: actor.accountID,
            orgResourceGrantChange: { expectedRevision: 0, enabled: true },
          },
          owner,
        )
      const machine = await f.member("process-machine-owner")
      const accepted = await machine.sibling({ inputHeaders: actorHeaders })
      expect(accepted.runtime === machine.runtime).toBe(true)
      expect(accepted.accepted.permit.actor.subjectID).toBe(actor.accountID)
      expect(machine.home.identity.accountID).not.toBe(actor.accountID)
      const started = await background(f, accepted)
      expect((await accepted.process({ action: "log", processId: started.processId })).output).toContain(
        "ACCEPTED_PROCESS_READY",
      )
      const serviceRuntime = await service.service.maintenance.run(async () => RuntimeContext.current())
      const connected = Promise.withResolvers<void>(),
        resume = Promise.withResolvers<void>()
      const originalTarget = Environment.assertTarget
      const controlling = new AsyncLocalStorage<boolean>()
      service.interceptHTTP(async (request) => {
        if (new URL(request.url).pathname !== "/runtime/v1/environments/execution") return
        const signed = CloudExecution.Request.parse(await request.clone().json())
        const operation = signed.proof.operation
        if (operation.action !== "stdin" || operation.reference.sessionID !== accepted.sessionID) return
        return controlling.run(true, () => service.service.fetch(request))
      })
      let held = false
      const gate = spyOn(Environment, "assertTarget").mockImplementation(async (target, scopeID) => {
        const actual = await originalTarget(target, scopeID)
        if (
          !held &&
          controlling.getStore() &&
          RuntimeContext.current() === serviceRuntime &&
          target.environmentID === f.environment.environmentID
        ) {
          held = true
          connected.resolve()
          await resume.promise
        }
        return actual
      })
      const control = accepted.process({ action: "write", processId: started.processId, data: "finish\n" })
      const settled = control.then(
        () => undefined,
        () => undefined,
      )
      const deadline = setTimeout(
        () => connected.reject(new Error("The real process control did not reach its connect barrier")),
        5000,
      )
      try {
        await connected.promise
        clearTimeout(deadline)
        const currentProject = (await service.client.orgProjects.get({ projectID: f.project.projectID }, owner)).data
        await service.client.orgProjects.member(
          {
            projectID: f.project.projectID,
            accountID: actor.accountID,
            orgProjectMemberChange: { expectedRevision: currentProject.revision, role: null },
          },
          owner,
        )
        expect([403, 404]).toContain(
          (await service.client.orgSessions.get({ sessionID: accepted.sessionID }, { headers: actorHeaders })).response
            .status,
        )
        expect((await f.physical(started.executionID)).execution.state).toBe("running")
        resume.resolve()
        await expect(control).rejects.toThrow()
        await expect(accepted.process({ action: "log", processId: started.processId })).rejects.toThrow()
        expect((await f.physical(started.executionID)).execution.state).toBe("running")
      } finally {
        clearTimeout(deadline)
        resume.resolve()
        await settled
        gate.mockRestore()
        service.interceptHTTP(undefined)
      }
      let retirements = 0,
        inspections = 0
      let retirementReply: { status: number; code?: string; message?: string; outcome?: string } | undefined
      service.interceptHTTP(async (request) => {
        const pathname = new URL(request.url).pathname
        if (pathname === "/runtime/v1/environments/execution/retirement/inspection") {
          inspections++
          return
        }
        if (pathname !== "/runtime/v1/environments/execution/retirement") return
        const signed = CloudExecution.RetirementRequest.parse(await request.clone().json())
        if (signed.proof.kind !== "execution") return
        retirements++
        const response = await service.service.fetch(request)
        const body = z.object({ code: z.string(), message: z.string(), outcome: z.string() }).safeParse(
          await response
            .clone()
            .json()
            .catch(() => undefined),
        )
        retirementReply = { status: response.status, ...(body.success && body.data) }
        if (response.status !== 200) return response
        return Response.json(null)
      })
      try {
        let failure: unknown
        try {
          await machine.runtime.run(() => EnvironmentExecutionSource.close())
        } catch (error) {
          failure = error
        }
        expect(retirementReply, JSON.stringify(retirementReply)).toMatchObject({ status: 200 })
        expect(unknownOutcome(failure)).toBe(true)
        const original = await f.physical(started.executionID)
        expect(original.execution.state).toBe("completed")
        expect(original.uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution")).toBe(false)
        const before = inspections
        await machine.runtime.run(() => EnvironmentExecutionSource.close())
        expect(inspections).toBeGreaterThan(before)
        expect(retirements).toBe(1)
      } finally {
        service.interceptHTTP(undefined)
      }
    }),
  30000,
)
