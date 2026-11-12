import { z } from "zod"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationHandoffRecovery as Recovery,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { RuntimeIdentity, readRuntimeHome } from "./home"
import { readRuntimeRegistration } from "./registration"
import { readCredentials } from "./credentials"
import { OrganizationRuntimeError } from "./error"

interface Owner {
  identity: RuntimeIdentity
  runtimeID: string
  ca?: string | string[]
  target(input: { authorization: HandoffCleanupAuthorization; signal: AbortSignal }): Promise<Handoff.MachineExecution>
}
export interface HandoffCleanupAuthorization {
  readonly kind: "original-handoff-cleanup"
}
interface AuthorizationFrame {
  authorization: Recovery.SignedPermit
  signingIdentity: Recovery.Response["signingIdentity"]
  assert(): void
}
const authorizations = new WeakMap<HandoffCleanupAuthorization, AuthorizationFrame>()
export function readHandoffCleanupAuthorization(value: HandoffCleanupAuthorization) {
  const frame = authorizations.get(value)
  if (!frame) fail("Target cleanup requires its real enrolled HTTP authorization owner")
  frame.assert()
  return {
    authorization: Recovery.SignedPermit.parse(frame.authorization),
    signingIdentity: Recovery.Response.shape.signingIdentity.parse(frame.signingIdentity),
    assert: frame.assert,
  }
}
interface RegisteredOwner extends Owner {
  abort: AbortController
  calls: Set<Promise<unknown>>
}
const state = RuntimeContext.state(() => ({ owner: undefined as RegisteredOwner | undefined }))
function fail(message: string): never {
  throw new OrganizationRuntimeError({ code: "HANDOFF_BLOCKED", message, outcome: "not_dispatched", retryable: false })
}
export function registerHandoffCleanup(input: Owner) {
  const value = state()
  if (value.owner) fail("The original Runtime already owns its Handoff cleanup controller")
  const owner: RegisteredOwner = {
    ...input,
    identity: RuntimeIdentity.parse(input.identity),
    ca: Array.isArray(input.ca) ? [...input.ca] : input.ca,
    target: input.target.bind(input),
    abort: new AbortController(),
    calls: new Set(),
  }
  value.owner = owner
  return async () => {
    owner.abort.abort(new Error("Original Handoff cleanup owner closed"))
    await Promise.allSettled([...owner.calls])
    if (value.owner === owner) value.owner = undefined
  }
}
function withClient<T>(
  query: Recovery.Proof["query"],
  input: { signal?: AbortSignal },
  body: (
    response: Recovery.Response,
    client: ReturnType<typeof createOrganizationClient>,
    key: CryptoKey,
    signal: AbortSignal,
  ) => Promise<T>,
): Promise<T> {
  const selected = state().owner
  if (!selected) fail("This Runtime has no original Handoff cleanup controller")
  selected.abort.signal.throwIfAborted()
  const pending = withClientOwned(selected, query, input, body)
  selected.calls.add(pending)
  void pending.finally(() => selected.calls.delete(pending)).catch(() => {})
  return pending
}
async function withClientOwned<T>(
  selected: RegisteredOwner,
  query: Recovery.Proof["query"],
  input: { signal?: AbortSignal },
  body: (
    response: Recovery.Response,
    client: ReturnType<typeof createOrganizationClient>,
    key: CryptoKey,
    signal: AbortSignal,
  ) => Promise<T>,
) {
  const assertStore = WorkspaceContent.captureOwner(input.signal),
    signal = AbortSignal.any([
      selected.abort.signal,
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(30000),
    ])
  const assert = () => {
    assertStore()
    signal.throwIfAborted()
    if (state().owner !== selected) fail("Cleanup callback outlived its original controller")
  }
  const member = await readRuntimeHome(RuntimeContext.current().host.home, selected.identity)
  if (member.root !== RuntimeContext.current().host.root) fail("Cleanup belongs to another Runtime Home")
  const registration = await readRuntimeRegistration(member.home, selected.identity),
    credentials = await readCredentials(member.root)
  if (
    !registration ||
    registration.runtimeID !== selected.runtimeID ||
    registration.state === "pending" ||
    !credentials ||
    registration.publicKey !== credentials.publicKey ||
    member.publicKey !== credentials.publicKey
  )
    fail("Cleanup requires this Home's retained enrolled machine key")
  assert()
  signal.throwIfAborted()
  const transport = new Bun.FetchSession({ tls: { ca: selected.ca, rejectUnauthorized: true }, proxy: false })
  const client = createOrganizationClient({
    baseUrl: member.origin,
    credentials: "omit",
    redirect: "error",
    fetch: Object.assign(
      async (value: string | URL | Request, init?: RequestInit) => {
        const response = await transport.fetch(value, { ...init, credentials: "omit", redirect: "error" })
        const reader = response.body?.getReader()
        if (!reader) return response
        const chunks: Uint8Array[] = []
        let total = 0
        let aborting: Promise<void> | undefined
        const abort = () => {
          aborting ??= reader.cancel().catch(() => {})
        }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            total += next.value.byteLength
            if (total > 256 * 1024) fail("Cleanup response exceeds its bounded metadata format")
            chunks.push(Uint8Array.from(next.value))
          }
          return new Response(Buffer.concat(chunks, total), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        } catch (error) {
          await reader.cancel().catch(() => {})
          throw error
        } finally {
          signal.removeEventListener("abort", abort)
          await aborting
          reader.releaseLock()
        }
      },
      { preconnect() {} },
    ),
  })
  try {
    const issuedAt = Date.now(),
      proof = Recovery.Proof.parse({
        schemaVersion: 1,
        purpose: "handoff-cleanup-recovery",
        orgID: registration.orgID,
        deploymentIncarnation: registration.deploymentIncarnation,
        runtimeID: registration.runtimeID,
        requestID: crypto.randomUUID(),
        issuedAt,
        expiresAt: issuedAt + 30000,
        query,
      })
    const result = await client.orgHandoff.recovery(
      { orgHandoffRecoveryRequest: { proof, signature: await Recovery.sign(proof, credentials.privateKey) } },
      { signal },
    )
    if (!result.data) {
      const error = OrganizationProtocol.Error.safeParse(result.error)
      if (error.success) throw new OrganizationRuntimeError(error.data)
      fail("Cleanup service returned no verifiable metadata")
    }
    const response = Recovery.Response.parse(result.data),
      digest = await Recovery.requestHash(proof)
    assert()
    signal.throwIfAborted()
    if (
      response.requestID !== proof.requestID ||
      response.requestHash !== digest ||
      response.result.operation !== query.operation ||
      response.signingIdentity.orgID !== registration.orgID ||
      response.signingIdentity.deploymentIncarnation !== registration.deploymentIncarnation
    )
      fail("Cleanup response changed its original request or deployment")
    return await body(response, client, credentials.privateKey, signal)
  } finally {
    transport.close()
  }
}
export namespace OrganizationHandoffCleanup {
  export async function discover(
    input: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<Recovery.Page> {
    const { cursor, limit, signal } = input
    return withClient({ operation: "discover", page: { cursor, limit: limit ?? 50 } }, { signal }, async (response) => {
      if (response.result.operation !== "discover") fail("Cleanup discovery returned an action")
      return Recovery.Page.parse({ items: response.result.items, cursor: response.result.cursor })
    })
  }
  async function operation(
    action: "inspect-target" | "retire-target",
    value: z.infer<typeof Recovery.Descriptor>,
    signal?: AbortSignal,
  ) {
    const descriptor = Recovery.Descriptor.parse(value),
      binding = Handoff.Binding.strip().parse(descriptor)
    return withClient(
      { operation: action, binding, manifestHash: descriptor.manifestHash },
      { signal },
      async (response, client, key, work) => {
        if (response.result.operation === "discover") fail("Cleanup action returned discovery metadata")
        const authorization = response.result.authorization,
          plan = authorization.permit,
          owner = state().owner!
        if (
          plan.operation !== action ||
          plan.requestHash !== response.requestHash ||
          plan.requestID !== response.requestID ||
          plan.keyID !== response.signingIdentity.keyID ||
          plan.runtimeID !== owner.runtimeID ||
          plan.manifestHash !== descriptor.manifestHash ||
          (Object.keys(Handoff.Binding.shape) as (keyof z.infer<typeof Handoff.Binding>)[]).some(
            (field) => plan[field] !== binding[field],
          ) ||
          !(await Recovery.verifyPermit(plan, authorization.signature, response.signingIdentity.publicKey))
        )
          fail("Cleanup authorization changed its original participant or binding")
        const capability: HandoffCleanupAuthorization = Object.freeze({ kind: "original-handoff-cleanup" })
        let open = true
        const assert = WorkspaceContent.captureOwner(work)
        authorizations.set(capability, {
          authorization,
          signingIdentity: response.signingIdentity,
          assert() {
            assert()
            work.throwIfAborted()
            if (!open || state().owner !== owner || plan.expiresAt <= Date.now())
              fail("Cleanup authorization outlived its original HTTP callback")
          },
        })
        let execution: Handoff.MachineExecution
        try {
          execution = Handoff.MachineExecution.parse(await owner.target({ authorization: capability, signal: work }))
        } finally {
          open = false
          authorizations.delete(capability)
        }
        const result = Handoff.MachineResult.parse({
          ...execution,
          facts: await Promise.all(
            execution.facts.map(async (proof) => ({ proof, signature: await Handoff.signProof(proof, key) })),
          ),
        })
        if (
          result.operation !== action ||
          result.handoffID !== plan.handoffID ||
          result.runtimeID !== plan.runtimeID ||
          result.requestID !== plan.requestID ||
          result.object ||
          result.workspaceDifference ||
          result.differencePage ||
          result.requirements.length ||
          result.facts.some(
            ({ proof }) =>
              !["target-never-activate", "target-preview-released"].includes(proof.purpose) ||
              proof.manifestHash !== plan.manifestHash ||
              (Object.keys(Handoff.Binding.shape) as (keyof z.infer<typeof Handoff.Binding>)[]).some(
                (field) => proof[field] !== plan[field],
              ),
          )
        )
          fail("Cleanup controller returned more than its original inactive fact")
        for (const fact of result.facts) {
          const acknowledged = await client.orgHandoff.proof({ orgHandoffSignedProof: fact }, { signal: work })
          if (!acknowledged.data) {
            const error = OrganizationProtocol.Error.safeParse(acknowledged.error)
            if (error.success) throw new OrganizationRuntimeError(error.data)
            fail("Cleanup proof acknowledgement is unknown")
          }
          const receipt = Handoff.FactAcknowledgement.parse(acknowledged.data)
          if (
            receipt.purpose !== fact.proof.purpose ||
            receipt.factHash !== (await Handoff.proofHash(fact.proof)) ||
            (Object.keys(Handoff.Binding.shape) as (keyof z.infer<typeof Handoff.Binding>)[]).some(
              (field) => receipt[field] !== plan[field],
            )
          )
            fail("Cleanup acknowledgement belongs to another fact")
        }
        return result
      },
    )
  }
  export const inspect = (descriptor: z.infer<typeof Recovery.Descriptor>, input: { signal?: AbortSignal } = {}) =>
    operation("inspect-target", descriptor, input.signal)
  export const retire = (descriptor: z.infer<typeof Recovery.Descriptor>, input: { signal?: AbortSignal } = {}) =>
    operation("retire-target", descriptor, input.signal)
}
