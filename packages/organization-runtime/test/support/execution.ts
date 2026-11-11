import { expect, spyOn } from "bun:test"
import path from "node:path"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { prepareMemberHome } from "../../src/home"
import { enrollMemberRuntime } from "../../src/enrollment"
import { openMemberConnection, type MemberConnection } from "../../src/connection"
import { createCommandIntake } from "../../src/command-intake"
import { registerSessionSchema } from "../../src/session-schema"
import { attachMemberExecution, registerMemberExecution } from "../../src/execution-source"
import { createMemberConnectionTool } from "../../src/connection-tool"
import { createMemberMcpTool } from "../../src/mcp-tool"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { fixture } from "./organization"
import { registerOrganizationKnowledge } from "../../src/knowledge-source"

export async function executionFixture(
  input: {
    protocol?: Gateway.ModelProtocol
    endpoint?: string
    connectionEndpoint?: string
    connectionProtocol?: "fixed-http" | "mcp-http" | "mcp-sse"
    execution?: boolean
    knowledge?: boolean
  } = {},
) {
  const resources = testResources()
  try {
    const f = await fixture()
    resources.defer("organization fixture", () => f[Symbol.asyncDispose]())
    const member = await prepareMemberHome({
      baseDirectory: path.join(f.root, "members"),
      identity: f.identity,
      origin: f.origin,
    })
    await enrollMemberRuntime({
      home: member.home,
      identity: member.identity,
      ca: f.ca,
      ticket: await f.ticket(member.identity.deviceID, member.publicKey),
    })
    const runtime = await testRuntime({
      home: path.join(f.root, "agent"),
      register() {
        registerSessionSchema({ orgID: f.identity.orgID })
        if (input.knowledge) registerOrganizationKnowledge(member.identity)
        if (input.execution) {
          registerMemberExecution(member.identity)
          ToolRegistry.registerToolProvider("organization-runtime", () => [
            createMemberConnectionTool(member.identity),
            createMemberMcpTool(member.identity),
          ])
        }
      },
    })
    resources.defer("native Runtime", () => runtime.close())
    const wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    resources.defer("native wake observation", () => wake.mockRestore())
    const context = await runtime.run(() => RuntimeContext.current())
    let intake: ReturnType<typeof createCommandIntake>
    let connection: MemberConnection
    let supplied: MemberConnection["resources"] | undefined
    async function connect() {
      connection = await openMemberConnection({
        home: member.home,
        identity: member.identity,
        ca: f.ca,
        buildVersion: "resource-client-fixture",
        commands(current, signal, client) {
          supplied = client
          intake = createCommandIntake({
            identity: current.signingIdentity,
            runtimeID: current.runtimeID,
            accountID: f.identity.accountID,
            connectionEpoch: current.connectionEpoch,
            signal,
          })
          if (input.execution)
            context.bind(() =>
              attachMemberExecution({
                connection: current,
                signal,
                resources: client,
                intake,
                origin: f.origin,
                ca: f.ca,
              }),
            )()
          return {
            create: context.bind(intake.create),
            input: context.bind(intake.input),
            decision: context.bind(intake.decision),
            control: context.bind(intake.control),
            query: context.bind(intake.query),
            skip: context.bind(intake.skip),
          }
        },
      })
      const established = connection
      resources.defer("member connection", () => established.close())
      expect(supplied).toBe(established.resources)
      return connection
    }
    await connect()
    const options = { headers: f.headers, throwOnError: true as const }
    const project = (
      await f.client.orgProjects.create({ orgProjectCreate: { name: "Resource calls", description: "" } }, options)
    ).data
    const model = (
      await f.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Selected model",
            scope: { kind: "organization" },
            configuration: {
              protocol: input.protocol ?? "openai-compatible",
              endpoint: input.endpoint ?? "https://provider.example/v1",
              model: { id: "fixture-model", name: "Fixture", limit: { context: 8192, output: 1024 } },
            },
            credential:
              input.protocol === "anthropic-compatible"
                ? { kind: "header", name: "x-api-key", value: "private-upstream-key" }
                : { kind: "bearer", value: "private-upstream-key" },
          },
        },
        options,
      )
    ).data
    await f.client.orgResourceGrants.set(
      {
        resourceID: model.resourceID,
        kind: "account",
        subjectID: f.identity.accountID,
        orgResourceGrantChange: { expectedRevision: 0, enabled: true },
      },
      options,
    )
    const connectionResource = input.connectionEndpoint
      ? (
          await f.client.orgResources.create(
            {
              orgResourceCreate: {
                name: "Selected business connection",
                scope: { kind: "organization" },
                configuration:
                  input.connectionProtocol === "mcp-http" || input.connectionProtocol === "mcp-sse"
                    ? { protocol: input.connectionProtocol, endpoint: input.connectionEndpoint }
                    : { protocol: "fixed-http", method: "POST", endpoint: input.connectionEndpoint },
                credential: { kind: "bearer", value: "private-connection-key" },
              },
            },
            options,
          )
        ).data
      : undefined
    if (connectionResource)
      await f.client.orgResourceGrants.set(
        {
          resourceID: connectionResource.resourceID,
          kind: "account",
          subjectID: f.identity.accountID,
          orgResourceGrantChange: { expectedRevision: 0, enabled: true },
        },
        options,
      )
    const created = (
      await f.client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            schemaVersion: 1,
            orgID: f.identity.orgID,
            requestID: "create-resource-session",
            projectID: project.projectID,
            runtimeID: connection!.connected.runtimeID,
            creation: { operation: "create" },
          },
        },
        options,
      )
    ).data
    const sessionID = created.effect.sessionID
    await f.client.orgSessionResources.set(
      {
        sessionID,
        orgSessionResourceChange: {
          expectedRevision: 0,
          selection: {
            modelResourceID: model.resourceID,
            connectionResourceIDs: connectionResource ? [connectionResource.resourceID] : [],
          },
        },
      },
      options,
    )
    const accepted = (
      await f.client.orgCommands.input(
        {
          sessionID,
          orgCommandInputRequest: {
            schemaVersion: 1,
            orgID: f.identity.orgID,
            requestID: "resource-task",
            sessionID,
            projectID: project.projectID,
            runtimeID: connection!.connected.runtimeID,
            input: { operation: "input", mode: "task", parts: [{ type: "text", text: "A private task" }] },
          },
        },
        options,
      )
    ).data
    const lookup = { subjectID: f.identity.accountID, requestID: accepted.permit.requestID }
    return {
      ...f,
      member,
      runtime,
      sessionID,
      model,
      connectionResource,
      get connection() {
        return connection!
      },
      async reconnect() {
        await connection!.close()
        return connect()
      },
      description: () => runtime.run(() => intake.descriptionProof(lookup)),
      async binding() {
        return runtime.run(async () => {
          const session = await Session.get(sessionID)
          return ScopeContext.provide({
            scope: session.scope,
            workspace: null,
            fn: async () => {
              await Session.update(sessionID, (draft) => {
                draft.modelOverride = { providerID: "test", modelID: "test" }
              })
              const item = (await SessionInbox.list(sessionID))[0]!
              expect((await SessionInbox.materializeNextTask(sessionID)).status).toBe("materialized")
              await RolloutLedger.beginRun(RolloutLifecycle.owner(session), item.messageID)
              return intake.bindingProof(lookup, item.messageID)
            },
          })
        })
      },
      proof(grant: Execution.BoundGrant, callID: string, resourceID = model.resourceID): Gateway.Proof {
        return Gateway.Proof.parse({
          schemaVersion: 1,
          purpose: "gateway-call",
          orgID: grant.orgID,
          deploymentIncarnation: grant.deploymentIncarnation,
          runtimeID: grant.runtimeID,
          connectionEpoch: connection!.connected.connectionEpoch,
          grantID: grant.grantID,
          sessionID,
          rootID: grant.rootID,
          bindingEpoch: grant.bindingEpoch,
          resourceID,
          callID,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 30_000,
        })
      },
      [Symbol.asyncDispose]: resources.close,
    }
  } catch (error) {
    await resources.close()
    throw error
  }
}
