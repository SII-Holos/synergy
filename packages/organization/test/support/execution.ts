import {
  OrganizationResourceProtocol as Resource,
  OrganizationExecutionProtocol as Execution,
  OrganizationCommandProtocol as Command,
  OrganizationGatewayProtocol as Gateway,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationResources as Resources } from "../../src/resources"
import { OrganizationSessionResources as SessionResources } from "../../src/session-resources"
import { commandFixture } from "./commands"

export async function executionFixture(input: {
  endpoint: string
  protocol?: "openai-compatible" | "anthropic-compatible"
  connectionEndpoint?: string
}) {
  const f = await commandFixture()
  try {
    await f.connect()
    const { grant, binding, connection } = await f.run(async () => {
      const resource = await Resources.create(
        f.credentials.admin,
        Resource.Create.parse({
          name: "Gateway model",
          scope: { kind: "organization" },
          configuration: {
            protocol: input.protocol ?? "openai-compatible",
            endpoint: input.endpoint,
            model: { id: "fixture-model", name: "Fixture", limit: { context: 32768, output: 4096 } },
          },
          credential:
            input.protocol === "anthropic-compatible"
              ? { kind: "header", name: "x-api-key", value: "private-upstream-key" }
              : { kind: "bearer", value: "private-upstream-key" },
        }),
      )
      await Resources.grant(
        f.credentials.admin,
        resource.resourceID,
        { kind: "account", id: "alice" },
        { expectedRevision: 0, enabled: true },
      )
      const connection = input.connectionEndpoint
        ? await Resources.create(
            f.credentials.admin,
            Resource.Create.parse({
              name: "Business connection",
              scope: { kind: "organization" },
              configuration: { protocol: "fixed-http", method: "POST", endpoint: input.connectionEndpoint },
              credential: { kind: "bearer", value: "private-connection-key" },
            }),
          )
        : undefined
      if (connection)
        await Resources.grant(
          f.credentials.admin,
          connection.resourceID,
          { kind: "account", id: "alice" },
          { expectedRevision: 0, enabled: true },
        )
      await SessionResources.set(f.credentials.alice, f.sessionID, {
        expectedRevision: 0,
        selection: {
          modelResourceID: resource.resourceID,
          connectionResourceIDs: connection ? [connection.resourceID] : [],
        },
      })
      const request = f.request()
      request.input.mode = "task"
      const admitted = await f.commands.input(f.credentials.alice, request)
      if (admitted.kind !== "admitted") throw new Error("Expected admitted task")
      const permit = admitted.delivery.authorization.permit
      const receipt = Command.InputResult.parse({
        attempt: {
          schemaVersion: 1,
          permit,
          receivedAt: Date.now(),
          status: "accepted",
          acceptedAttemptID: permit.attemptID,
        },
        accepted: {
          schemaVersion: 1,
          permit,
          acceptedAt: Date.now(),
          intakeSeq: 1,
          effect: { kind: "inbox", mode: "task", itemID: "inb_gateway", messageID: "msg_gateway" },
        },
      })
      const proof = Execution.BindingProof.parse({
        schemaVersion: 1,
        purpose: "execution-root-binding",
        orgID: "org",
        deploymentIncarnation: "deployment",
        runtimeID: "runtime-alice",
        connectionEpoch: 1,
        rootID: "msg_gateway",
        receipt,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 30_000,
      })
      const binding = { proof, signature: await Execution.signBinding(proof, f.machineKeys.privateKey) }
      return { grant: await f.execution.bind(binding), binding, connection }
    })
    return {
      ...f,
      grant,
      binding,
      connection,
      async proof(callID: string = crypto.randomUUID(), changes: Partial<Gateway.Proof> = {}) {
        const proof = Gateway.Proof.parse({
          schemaVersion: 1,
          purpose: "gateway-call",
          orgID: grant.orgID,
          deploymentIncarnation: grant.deploymentIncarnation,
          runtimeID: grant.runtimeID,
          connectionEpoch: 1,
          grantID: grant.grantID,
          sessionID: grant.sessionID,
          rootID: grant.rootID,
          bindingEpoch: grant.bindingEpoch,
          resourceID: grant.selection.modelResourceID,
          callID,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 30_000,
          ...changes,
        })
        return { proof, signature: await Gateway.signRequest(proof, f.machineKeys.privateKey) }
      },
    }
  } catch (error) {
    await f[Symbol.asyncDispose]()
    throw error
  }
}
