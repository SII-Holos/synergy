import { expect, test } from "bun:test"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { PermissionRules } from "@ericsanchezok/synergy-harness/permission/rules"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SessionDecisionReceipts } from "@ericsanchezok/synergy-harness/session/decision-receipts"
import { OrganizationCommandRecords } from "../src/command-records"
import { OrganizationExecutionLeases } from "../src/execution-leases"
import { OrganizationIntakePath } from "../src/storage/path"
import {
  OrganizationCommandProtocol as Command,
  OrganizationInteractionProtocol as Interaction,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { cloudExecutionFixture } from "./support/cloud-execution"
import { ModelRequest, modelResponse, runtimeContext, waitKnowledgeTask } from "./support/knowledge-task"

type Fixture = Awaited<ReturnType<typeof cloudExecutionFixture>>
type Pending = Extract<Interaction.Pending, { kind: "permission" }>

async function reviewedBash(runtime: { run<T>(body: () => Promise<T>): Promise<T> }, sessionID: string) {
  const part = await runtime.run(async () => {
    for await (const message of MessageV2.stream({ sessionID }))
      for (const part of message.parts) if (part.type === "tool" && part.tool === "bash") return part
    throw new Error("The actual temporary Workspace Git command was not retained")
  })
  if (part.state.status !== "completed") throw new Error("The actual temporary Workspace Git command did not complete")
  expect(z.object({ exit: z.number() }).parse(part.state.metadata).exit).toBe(0)
  expect(part.state.output).toContain("reviewed")
  return part
}

async function pending(
  f: Fixture,
  accepted: Command.InputAccepted,
  headers: Record<string, string>,
  observed: { runtime: { run<T>(body: () => Promise<T>): Promise<T> }; upstream: () => unknown },
): Promise<Pending> {
  const end = Date.now() + 10000
  for (;;) {
    const page = (
      await f.service.client.orgSessionInteractions.list(
        {
          sessionID: accepted.permit.sessionID,
          orgInteractionQuery: {
            operation: "pending",
            rootSessionID: accepted.permit.sessionID,
            limit: 32,
          },
        },
        { headers, throwOnError: true },
      )
    ).data
    if (page.operation !== "pending") throw new Error("Expected the original native permission page")
    const permission = page.items.find((item) => item.kind === "permission")
    if (permission) return permission
    if (Date.now() >= end) {
      const native = await observed.runtime.run(async () => {
        const session = await Session.get(accepted.permit.sessionID)
        return ScopeContext.provide({
          scope: session.scope,
          workspace: session.workspace,
          fn: async () => {
            const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
            const rootID = accepted.effect.messageID
            const run = await RolloutLedger.getRun(owner, rootID).catch((error) => {
              if (error instanceof Storage.NotFoundError) return
              throw error
            })
            const calls = await RolloutLedger.calls(owner, rootID)
            const tools = await RolloutLedger.tools(owner, rootID)
            const parts: Array<{ tool: string; status: string; approval?: unknown; diagnostic?: unknown }> = []
            const failures: unknown[] = []
            const failure = z.object({
              name: z.string(),
              data: z
                .object({
                  message: z.string().optional(),
                  code: z.string().optional(),
                  errorName: z.string().optional(),
                })
                .optional(),
            })
            let messages = 0
            const metadata = z.object({
              approval: z.object({ status: z.string(), source: z.string().optional() }).optional(),
              toolDiagnostic: z.object({ code: z.string() }).optional(),
            })
            for await (const message of MessageV2.stream({ scopeID: session.scope.id, sessionID: session.id })) {
              if (message.info.role === "assistant" && message.info.error) {
                const captured = failure.safeParse(message.info.error)
                if (captured.success) failures.push(captured.data)
              }
              for (const part of message.parts) {
                if (part.type !== "tool") continue
                const value = metadata.safeParse(part.state.metadata)
                parts.push({
                  tool: part.tool,
                  status: part.state.status,
                  ...(value.success ? { approval: value.data.approval, diagnostic: value.data.toolDiagnostic } : {}),
                })
              }
              if (++messages === 8) break
            }
            return {
              profile: session.controlProfile,
              paused: session.paused && {
                reason: session.paused.reason,
                description: session.paused.description?.slice(0, 2048),
              },
              run: run?.status ?? "missing",
              recording: run?.recording,
              execution: run?.execution,
              failures,
              calls: calls.map((call) => ({
                purpose: call.purpose,
                status: call.status,
                transportCaptured: call.transportCaptured,
              })),
              tools: tools.map((tool) => ({ tool: tool.tool, status: tool.status })),
              parts,
              pending: page.items.map((item) => ({
                kind: item.kind,
                ...(item.kind === "permission" ? { permission: item.permission, alwaysScope: item.alwaysScope } : {}),
              })),
            }
          },
        })
      })
      throw new Error(
        "The actual Hosted Bash did not enter its native permission wait: " +
          JSON.stringify({ upstream: observed.upstream(), native }),
      )
    }
    await Bun.sleep(10)
  }
}

async function reply(
  f: Fixture,
  accepted: Command.InputAccepted,
  permission: Pending,
  headers: Record<string, string>,
  response: "always" | "reject",
) {
  return (
    await f.service.client.orgSessionInteractions.reply(
      {
        sessionID: accepted.permit.sessionID,
        orgCommandDecisionRequest: {
          schemaVersion: 1,
          orgID: accepted.permit.orgID,
          sessionID: accepted.permit.sessionID,
          projectID: accepted.permit.projectID,
          runtimeID: accepted.permit.runtimeID,
          requestID: `${response}-${permission.requestID}`,
          decision: {
            operation: "decision",
            kind: "permission",
            requestID: permission.requestID,
            reply: response,
          },
        },
      },
      { headers, throwOnError: true },
    )
  ).data
}

test.skipIf(process.platform === "win32")(
  "an actual Hosted always winner applies to another Project on that Runtime and not another enrolled Home",
  async () => {
    const calls: Array<{
      project: string
      request: z.infer<typeof ModelRequest>
    }> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = ModelRequest.parse(await request.json())
        calls.push({
          project: new URL(request.url).pathname.split("/")[1] ?? "",
          request: input,
        })
        if (!runtimeContext(input) || input.messages.some((message) => message.role === "tool"))
          return modelResponse(calls.length)
        return modelResponse(calls.length, {
          name: "bash",
          input: {
            command:
              "git init .permission-repo && git -C .permission-repo switch -c reviewed && git -C .permission-repo symbolic-ref --short HEAD",
            yieldSeconds: 1,
          },
        })
      },
    })
    try {
      await using f = await cloudExecutionFixture({
        automatic: true,
        modelContext: 131072,
        modelEndpoint: new URL("/P/v1", upstream.url).href,
        controlProfile: "guarded",
      })
      const owner = { headers: f.service.headers, throwOnError: true as const }
      async function member(name: string) {
        const invite = (await f.service.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, owner)).data
        const password = `actual Hosted ${name} always integration password`
        const account = (
          await f.service.client.orgInvites.consume(
            {
              orgInviteConsume: {
                token: invite.token,
                requestID: `always-${name}`,
                loginName: name,
                displayName: name,
                password,
              },
            },
            { throwOnError: true },
          )
        ).data
        const login = await f.service.client.orgAuth.login(
          { orgLoginInput: { loginName: name, password } },
          { throwOnError: true },
        )
        const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
        if (!cookie) throw new Error("The actual Hosted participant has no authenticated login")
        return {
          account,
          headers: { cookie, "x-csrf-token": login.data.csrfToken },
        }
      }
      const p = await member("always-p")
      const q = await member("always-q")
      async function join(projectID: string, accountID: string) {
        const current = (await f.service.client.orgProjects.get({ projectID }, owner)).data
        await f.service.client.orgProjects.member(
          {
            projectID,
            accountID,
            orgProjectMemberChange: {
              expectedRevision: current.revision,
              role: "collaborator",
            },
          },
          owner,
        )
      }
      await join(f.project.projectID, p.account.accountID)
      for (const resourceID of f.resourceIDs)
        await f.service.client.orgResourceGrants.set(
          {
            resourceID,
            kind: "account",
            subjectID: p.account.accountID,
            orgResourceGrantChange: { expectedRevision: 0, enabled: true },
          },
          owner,
        )
      const hosted = await f.hosted("always-hosted-a", p.headers)
      expect(hosted.accepted.permit.actor.subjectID).toBe(p.account.accountID)
      const upstreamMetadata = () =>
        calls.map((call) => ({
          project: call.project,
          runtimeContext: runtimeContext(call.request) !== undefined,
          roles: call.request.messages.map((message) => message.role),
          hasToolReply: call.request.messages.some((message) => message.role === "tool"),
        }))
      const permission = await pending(f, hosted.accepted, p.headers, {
        runtime: hosted.runtime,
        upstream: upstreamMetadata,
      })
      expect(permission).toMatchObject({
        kind: "permission",
        permission: "bash",
        alwaysScope: "runtime",
      })
      expect(permission.tool).toBeDefined()
      const winner = await reply(f, hosted.accepted, permission, p.headers, "always")
      expect(winner.effect).toMatchObject({
        kind: "decision",
        decision: {
          status: "resolved",
          winner: {
            actor: { subjectID: p.account.accountID },
            outcome: { kind: "permission", reply: "always" },
          },
        },
      })
      await waitKnowledgeTask(
        hosted.runtime,
        hosted.accepted,
        () => calls.filter((item) => item.project === "P").length,
      )
      await reviewedBash(hosted.runtime, hosted.sessionID)
      const rules = await hosted.runtime.run(() => PermissionRules.userRuleset())
      for (const pattern of permission.patterns)
        expect(rules).toContainEqual({
          permission: permission.permission,
          pattern,
          action: "allow",
          scope: "user",
        })
      const receipt = await hosted.runtime.run(async () => {
        const session = await Session.get(hosted.sessionID)
        return ScopeContext.provide({
          scope: session.scope,
          workspace: session.workspace,
          fn: () =>
            SessionDecisionReceipts.read({
              sessionID: session.id,
              requestID: permission.requestID,
              kind: "permission",
            }),
        })
      })
      expect(receipt).toMatchObject({
        scopeID: f.project.projectID,
        sessionID: hosted.sessionID,
        actor: { subjectID: p.account.accountID },
        outcome: { kind: "permission", reply: "always" },
      })
      const project = (await f.service.client.orgProjects.create({ orgProjectCreate: { name: "Project Q" } }, owner))
        .data
      await join(project.projectID, q.account.accountID)
      async function resource(name: string, configuration: Resource.Configuration) {
        const item = (
          await f.service.client.orgResources.create(
            {
              orgResourceCreate: {
                name,
                scope: { kind: "project", projectID: project.projectID },
                configuration,
                credential: { kind: "none" },
              },
            },
            owner,
          )
        ).data
        for (const accountID of [f.service.identity.accountID, q.account.accountID])
          await f.service.client.orgResourceGrants.set(
            {
              resourceID: item.resourceID,
              kind: "account",
              subjectID: accountID,
              orgResourceGrantChange: { expectedRevision: 0, enabled: true },
            },
            owner,
          )
        return item
      }
      const model = await resource("Project Q model", {
        protocol: "openai-compatible",
        endpoint: new URL("/Q/v1", upstream.url).href,
        model: Resource.Model.parse({
          id: "controlled",
          name: "Controlled",
          limit: { context: 131072, output: 1024 },
        }),
      })
      const storage = await resource("Project Q files", {
        protocol: "workspace-storage",
        profile: "shared",
      })
      const compute = await resource("Project Q execution", {
        protocol: "environment",
        profile: "controlled",
      })
      const workspace = (
        await f.service.client.orgCloudWorkspaces.create(
          {
            orgCloudWorkspaceCreate: {
              projectID: project.projectID,
              resourceID: storage.resourceID,
              requestID: "always-q-workspace",
              name: "Project Q files",
            },
          },
          owner,
        )
      ).data
      const environment = (
        await f.service.client.orgCloudEnvironments.create(
          {
            orgCloudEnvironmentCreate: {
              projectID: project.projectID,
              resourceID: compute.resourceID,
              requestID: "always-q-environment",
              name: "Project Q execution",
            },
          },
          owner,
        )
      ).data
      const qOptions = { headers: q.headers, throwOnError: true as const }
      const target = {
        schemaVersion: 1 as const,
        orgID: f.service.identity.orgID,
        projectID: project.projectID,
        runtimeID: hosted.registration.runtimeID,
      }
      const created = (
        await f.service.client.orgSessions.create(
          {
            orgCommandCreateRequest: {
              ...target,
              requestID: "always-q-create",
              creation: { operation: "create" },
            },
          },
          qOptions,
        )
      ).data
      const sessionID = created.effect.sessionID
      await f.service.client.orgSessionResources.set(
        {
          sessionID,
          orgSessionResourceChange: {
            expectedRevision: 0,
            selection: {
              modelResourceID: model.resourceID,
              connectionResourceIDs: [],
              infrastructure: {
                workspace: {
                  resourceID: storage.resourceID,
                  workspaceID: workspace.workspaceID,
                },
                environment: {
                  resourceID: compute.resourceID,
                  environmentID: environment.environmentID,
                },
              },
            },
          },
        },
        qOptions,
      )
      await hosted.runtime.run(async () => {
        const session = await Session.get(sessionID)
        await ScopeContext.provide({
          scope: session.scope,
          workspace: session.workspace,
          fn: () => Session.updateControlProfile(sessionID, "guarded"),
        })
      })
      const accepted = (
        await f.service.client.orgCommands.input(
          {
            sessionID,
            orgCommandInputRequest: {
              ...target,
              sessionID,
              requestID: "always-q-input",
              input: {
                operation: "input",
                mode: "task",
                parts: [
                  {
                    type: "text",
                    text: "Run the same ordinary command on Project Q",
                  },
                ],
              },
            },
          },
          qOptions,
        )
      ).data
      expect(accepted.permit.actor.subjectID).toBe(q.account.accountID)
      await waitKnowledgeTask(hosted.runtime, accepted, () => calls.filter((item) => item.project === "Q").length)
      const allowed = await reviewedBash(hosted.runtime, sessionID)
      const approval = z
        .object({
          approval: z.object({
            source: z.string(),
            status: z.string(),
            audit: z.object({ visible: z.boolean() }),
          }),
        })
        .parse(allowed.state.metadata).approval
      expect(approval).toMatchObject({
        source: "user",
        status: "auto_allowed",
        audit: { visible: true },
      })
      expect(await hosted.runtime.run(() => PermissionRules.userRuleset())).toEqual(rules)
      const independent = await f.hosted("always-hosted-b", p.headers)
      expect(independent.home.home).not.toBe(hosted.home.home)
      expect(await independent.runtime.run(() => PermissionRules.userRuleset())).toEqual([])
      const otherPermission = await pending(f, independent.accepted, p.headers, {
        runtime: independent.runtime,
        upstream: upstreamMetadata,
      })
      expect(otherPermission.permission).toBe(permission.permission)
      expect(otherPermission.patterns).toEqual(permission.patterns)
      const beforeRejectedModelCalls = calls.filter(
        (item) => item.project === "P" && runtimeContext(item.request),
      ).length
      const beforeRejectedNativeStarts = f.nativeStarts()
      const denied = await reply(f, independent.accepted, otherPermission, p.headers, "reject")
      expect(denied.effect).toMatchObject({
        kind: "decision",
        decision: {
          status: "resolved",
          winner: {
            actor: { subjectID: p.account.accountID },
            outcome: { kind: "permission", reply: "reject" },
          },
        },
      })
      const deadline = Date.now() + 4000
      for (;;) {
        const retained = await independent.runtime.run(async () => {
          const session = await Session.get(independent.sessionID)
          return ScopeContext.provide({
            scope: session.scope,
            workspace: session.workspace,
            fn: async () => {
              const accepted = independent.accepted
              const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
              const rootID = accepted.effect.messageID
              const tools = await RolloutLedger.tools(owner, rootID)
              const bash = tools.filter((tool) => tool.tool === "bash")
              if (
                SessionManager.isRunning(session.id) ||
                bash.length === 0 ||
                bash.some((tool) => tool.status === "running")
              )
                return
              const run = await RolloutLedger.getRun(owner, rootID)
              const recorded = await RolloutLedger.calls(owner, rootID)
              const segments = await RolloutLedger.segments(owner, rootID)
              const messages = []
              for await (const message of MessageV2.stream({ scopeID: session.scope.id, sessionID: session.id }))
                messages.push(message)
              const [raw] = await Storage.readMany([
                OrganizationIntakePath.release(
                  accepted.permit.orgID,
                  accepted.permit.actor.subjectID,
                  accepted.permit.requestID,
                ),
              ])
              const release = OrganizationCommandRecords.Release.parse(raw)
              const leases = []
              let after: string | undefined
              do {
                const page = await OrganizationExecutionLeases.page(accepted.permit.runtimeID, {
                  after,
                  target: { sessionID: session.id, rootID },
                })
                leases.push(...page.items)
                after = page.cursor
              } while (after)
              return {
                run,
                recorded,
                segments,
                bash,
                messages,
                release,
                leases,
                pendingPermissions: (await PermissionNext.list()).filter((item) => item.sessionID === session.id),
                hasTerminalReply: SessionProgress.findTerminalReply(messages, rootID) !== undefined,
                needsModelCall: SessionProgress.needsModelCall(messages, rootID),
              }
            },
          })
        })
        if (Date.now() >= deadline)
          throw new Error("The rejected original Hosted Task did not drain its native callback")
        if (retained) {
          expect(retained.bash).toHaveLength(1)
          expect(retained.bash[0]).toMatchObject({
            status: "failed",
            error: new PermissionNext.RejectedError().message,
          })
          expect(retained.pendingPermissions).toEqual([])
          expect(retained.run).toMatchObject({
            status: "running",
            recording: "partial",
            execution: { status: "completed" },
          })
          expect(retained.segments.map((segment) => segment.status)).toEqual(["completed"])
          const atlas = retained.recorded.filter((call) => call.purpose === "atlas")
          expect(atlas).toHaveLength(1)
          expect(atlas[0]).toMatchObject({ status: "completed", transportCaptured: true })
          expect(retained.hasTerminalReply).toBe(false)
          expect(retained.needsModelCall).toBe(true)
          expect(retained.release).toMatchObject({
            sessionID: independent.sessionID,
            rootID: independent.accepted.effect.messageID,
            grantID: independent.accepted.permit.provisionalGrantID,
            actor: independent.accepted.permit.actor,
            state: "pending",
          })
          expect(retained.release.receipt).toBeUndefined()
          expect(retained.leases.length).toBeGreaterThan(0)
          expect(retained.leases.every((entry) => entry.state === "pending")).toBe(true)
          break
        }
        await Bun.sleep(5)
      }
      expect(calls.filter((item) => item.project === "P" && runtimeContext(item.request))).toHaveLength(
        beforeRejectedModelCalls,
      )
      expect(f.nativeStarts()).toBe(beforeRejectedNativeStarts)
      expect(await independent.runtime.run(() => PermissionRules.userRuleset())).toEqual([])
    } finally {
      await upstream.stop(true)
    }
  },
  45000,
)
