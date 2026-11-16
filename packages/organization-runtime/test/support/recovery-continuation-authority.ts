import { expect } from "bun:test"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { readCredentials } from "../../src/credentials"
import { OrganizationRecord as Record } from "../../../organization/src/storage/records"
import { OrganizationStoragePath as Keys } from "../../../organization/src/storage/path"
import type { openOrganizationService } from "../../../organization/src/service"

export function recoveryContinuationAuthority(input: {
  service: Awaited<ReturnType<typeof openOrganizationService>>
  origin: string
  ca: string
  root: string
  publicKey: string
  sessionID: string
  rootID: string
  modelCalls(): number
}) {
  const transport = new Bun.FetchSession({ tls: { ca: input.ca, rejectUnauthorized: true }, proxy: false })
  const client = createOrganizationClient({
    baseUrl: input.origin,
    credentials: "omit",
    redirect: "error",
    fetch: Object.assign(transport.fetch, { preconnect() {} }),
  })
  const probing = new Set<string>()
  let work: Promise<void> | undefined
  let failed = false
  let failure: unknown
  let completed = false
  let denied = 0

  async function state(proof: Execution.DescriptionProof) {
    const control = proof.continuation!.receipt.accepted!
    return input.service.maintenance.run(() =>
      Storage.snapshot(async () => {
        const session = Record.SessionDirectory.parse(await Storage.read(Keys.session(input.sessionID)))
        const [pointer] = await Storage.readMany([
          Keys.rootGrant(input.sessionID, control.permit.bindingEpoch, input.rootID),
        ])
        const request = Record.CommandRequest.parse(
          await Storage.read(Keys.commandRequest(control.permit.actor.subjectID, control.permit.requestID)),
        )
        const grants = []
        for await (const row of Storage.records({ prefix: ["organization", "execution-grants"], limit: 128 })) {
          const grant = Record.ExecutionGrant.parse(row.value)
          if (grant.sessionID === input.sessionID) grants.push(grant)
        }
        const gateway = []
        for await (const row of Storage.records({ prefix: ["organization", "gateway-calls"], limit: 128 })) {
          const call = Record.GatewayCall.parse(row.value)
          if (call.authorization.permit.rootID === input.rootID) gateway.push(call)
        }
        return {
          pointer: pointer === undefined ? undefined : Record.RootGrant.parse(pointer),
          retained: session.retainedExecutionGrants,
          accepted: request.accepted,
          grants,
          gateway,
        }
      }),
    )
  }

  async function qualify(original: Execution.DescriptionRequest, signal: AbortSignal) {
    const proof = original.proof
    const continuation = proof.continuation
    const accepted = proof.receipt.accepted
    const control = continuation?.receipt.accepted
    if (!continuation?.recovery || !accepted || !control || control.effect.operation !== "continue")
      throw new Error("The actual machine request lacks its real restored-root Continue")
    expect(accepted.effect.messageID).toBe(input.rootID)
    expect(accepted.permit.sessionID).toBe(input.sessionID)
    expect(control.effect.rootID).toBe(input.rootID)
    expect(control.permit.deploymentIncarnation).toBe(proof.deploymentIncarnation)
    expect(accepted.permit.deploymentIncarnation).not.toBe(proof.deploymentIncarnation)
    const key = await readCredentials(input.root)
    if (!key) throw new Error("The actual restored machine key is unavailable")
    expect(key.publicKey).toBe(input.publicKey)
    expect(await Execution.verifyDescription(proof, original.signature, key.publicKey)).toBe(true)
    const before = await state(proof)
    const modelCalls = input.modelCalls()
    expect(before.retained).toBe(0)
    expect(before.accepted).toEqual(control)
    const hash = continuation.recovery.sourceReferenceHash
    const wrongHash = (hash[0] === "0" ? "1" : "0") + hash.slice(1)
    const wrongPublication = Execution.DescriptionProof.parse({
      ...proof,
      continuation: {
        ...continuation,
        recovery: { ...continuation.recovery, sourceReferenceHash: wrongHash },
      },
    })
    const { continuation: _continuation, ...withoutControl } = proof
    expect(withoutControl.deploymentIncarnation).toBe(proof.deploymentIncarnation)
    expect(Execution.DescriptionProof.safeParse(withoutControl).success).toBe(false)
    const noCurrentB = Execution.DescriptionProof.parse({
      ...withoutControl,
      deploymentIncarnation: accepted.permit.deploymentIncarnation,
    })
    const wrongKind = Execution.DescriptionProof.parse({
      ...proof,
      continuation: {
        handoffID: crypto.randomUUID(),
        receipt: continuation.receipt,
      },
    })
    for (const [changed, code] of [
      [wrongPublication, "PERMISSION_DENIED"],
      [noCurrentB, "PERMISSION_DENIED"],
      [wrongKind, "NOT_FOUND"],
    ] as const) {
      const signature = await Execution.signDescription(changed, key.privateKey)
      expect(await Execution.verifyDescription(changed, signature, key.publicKey)).toBe(true)
      probing.add(signature)
      try {
        const response = await client.orgExecution.resources(
          { orgExecutionDescriptionRequest: { proof: changed, signature } },
          { signal, throwOnError: false },
        )
        expect(response.response.status).not.toBe(200)
        expect(OrganizationProtocol.Error.parse(response.error).code).toBe(code)
        expect(response.data).toBeUndefined()
        expect(await state(proof)).toEqual(before)
        expect(input.modelCalls()).toBe(modelCalls)
        denied++
      } finally {
        probing.delete(signature)
      }
    }
    completed = true
  }

  return {
    async before(request: Request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/runtime/v1/execution/resources") return
      const value = Execution.DescriptionRequest.parse(await request.clone().json())
      if (probing.has(value.signature) || value.proof.receipt.accepted?.permit.sessionID !== input.sessionID) return
      work ??= qualify(value, request.signal).catch((error) => {
        failed = true
        failure = error
      })
      await work
    },
    async assertQualified() {
      await work
      if (failed) throw failure
      expect(completed).toBe(true)
      expect(denied).toBe(3)
    },
    async [Symbol.asyncDispose]() {
      try {
        await work
      } finally {
        transport.close()
      }
    },
  }
}
