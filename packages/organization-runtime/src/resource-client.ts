import { z } from "zod"
import {
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationRuntimeError } from "./error"

export interface MemberResourceClient {
  describe(proof: Execution.DescriptionProof, signal?: AbortSignal): Promise<Execution.Description>
  bind(proof: Execution.BindingProof, signal?: AbortSignal): Promise<Execution.BoundGrant>
  release(proof: Execution.ReleaseProof, signal?: AbortSignal): Promise<Execution.ReleaseReceipt>
  reserve(proof: Gateway.Proof, signal?: AbortSignal): Promise<Gateway.SignedPermit>
  inspect(proof: Gateway.Proof, signal?: AbortSignal): Promise<Gateway.Receipt>
}

type Proof = Execution.DescriptionProof | Execution.BindingProof | Execution.ReleaseProof | Gateway.Proof

function failure(
  code: OrganizationProtocol.Error["code"],
  message: string,
  outcome: OrganizationProtocol.Error["outcome"] = "unknown",
) {
  return new OrganizationRuntimeError({ code, message, outcome, retryable: false })
}

export function createMemberResourceClient(options: {
  origin: string
  connection: z.infer<typeof Runtime.Connected>
  key: CryptoKey
  ca?: string | string[]
  signal: AbortSignal
}) {
  const connection = Runtime.Connected.parse(options.connection)
  const url = new URL(options.origin)
  if (url.protocol !== "https:" || url.origin !== options.origin)
    throw failure("PROTOCOL_MISMATCH", "Resource control requires the verified organization origin", "not_dispatched")
  const stop = new AbortController()
  const lifetime = AbortSignal.any([stop.signal, options.signal])
  const active = new Set<Promise<unknown>>()
  const waiters = new Set<() => void>()
  let occupied = 0
  let closing: Promise<void> | undefined
  // Provenance: https://bun.sh/docs/runtime/networking/fetch#fetch-sessions
  // Local adaptation: cancel and drain active bodies before closing this connection's private idle pool.
  const transport = new Bun.FetchSession({ tls: { ca: options.ca, rejectUnauthorized: true }, proxy: false })
  const client = createOrganizationClient({
    baseUrl: options.origin,
    credentials: "omit",
    redirect: "error",
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await transport.fetch(input, { ...init, credentials: "omit", redirect: "error" })
        const reader = response.body?.getReader()
        if (!reader) return response
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        let aborting: Promise<void> | undefined
        const abort = () => {
          aborting ??= reader.cancel().catch(() => {})
        }
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) abort()
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > 256 * 1024)
              throw failure("PROTOCOL_MISMATCH", "Organization resource control response exceeded its format limit")
            chunks.push(next.value)
          }
        } catch (error) {
          await reader.cancel().catch(() => {})
          throw error
        } finally {
          signal?.removeEventListener("abort", abort)
          await aborting
          reader.releaseLock()
        }
        return new Response(Buffer.concat(chunks, bytes), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      },
      { preconnect() {} },
    ),
  })
  function current(proof: Proof) {
    lifetime.throwIfAborted()
    if (
      proof.orgID !== connection.orgID ||
      proof.deploymentIncarnation !== connection.deploymentIncarnation ||
      proof.runtimeID !== connection.runtimeID ||
      proof.connectionEpoch !== connection.connectionEpoch
    )
      throw failure("STALE_CONNECTION", "Resource proof does not match this member connection", "not_dispatched")
    if (proof.issuedAt > Date.now() || proof.expiresAt <= Date.now())
      throw failure("PERMISSION_DENIED", "Resource proof is outside its validity window", "not_dispatched")
  }
  async function acquire(signal: AbortSignal) {
    while (occupied >= 8) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          waiters.delete(changed)
          signal.removeEventListener("abort", aborted)
          resolve()
        }
        const aborted = () => {
          waiters.delete(changed)
          signal.removeEventListener("abort", aborted)
          reject(signal.reason)
        }
        waiters.add(changed)
        signal.addEventListener("abort", aborted, { once: true })
        if (signal.aborted) aborted()
      })
    }
    signal.throwIfAborted()
    occupied++
  }
  function invoke<T>(
    proof: Proof,
    schema: z.ZodType<T>,
    request: (signal: AbortSignal) => Promise<{ data?: unknown; error?: unknown }>,
    verify: (result: T) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<T> {
    current(proof)
    const cancellation = AbortSignal.any([
      lifetime,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(Math.max(0, Math.min(15_000, proof.expiresAt - Date.now()))),
    ])
    const pending = (async () => {
      await acquire(cancellation)
      try {
        current(proof)
        const response = await request(cancellation)
        cancellation.throwIfAborted()
        if (!response.data) {
          if (response.error instanceof Error) throw response.error
          const error = OrganizationProtocol.Error.safeParse(response.error)
          throw error.success
            ? new OrganizationRuntimeError(error.data)
            : failure("PROTOCOL_MISMATCH", "Organization resource control returned an invalid response")
        }
        const parsed = schema.safeParse(response.data)
        if (!parsed.success)
          throw failure("PROTOCOL_MISMATCH", "Organization resource control returned an invalid response")
        await verify(parsed.data)
        cancellation.throwIfAborted()
        return parsed.data
      } catch (error) {
        cancellation.throwIfAborted()
        if (error instanceof OrganizationRuntimeError) throw error
        throw failure("SERVICE_UNAVAILABLE", "Organization resource control response is unavailable")
      } finally {
        occupied--
        for (const wake of [...waiters]) wake()
      }
    })()
    active.add(pending)
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    )
    return pending
  }
  function grant(proof: Execution.DescriptionProof | Execution.BindingProof, value: Execution.Grant) {
    const permit = proof.receipt.accepted!.permit
    if (
      value.grantID !== permit.provisionalGrantID ||
      value.orgID !== permit.orgID ||
      value.deploymentIncarnation !== permit.deploymentIncarnation ||
      value.runtimeID !== permit.runtimeID ||
      value.sessionID !== permit.sessionID ||
      value.projectID !== permit.projectID ||
      value.bindingEpoch !== permit.bindingEpoch ||
      value.admissionID !== permit.admissionID ||
      value.attemptID !== permit.attemptID ||
      JSON.stringify(value.actor) !== JSON.stringify(permit.actor) ||
      (value.state === "bound" && value.rootID !== proof.receipt.accepted!.effect.messageID)
    )
      throw failure("PROTOCOL_MISMATCH", "Organization execution grant does not match its accepted task")
  }
  function target(proof: Gateway.Proof, value: Gateway.Target) {
    if (
      value.connectionEpoch > proof.connectionEpoch ||
      (Object.keys(Gateway.Target.shape) as (keyof Gateway.Target)[]).some(
        (key) => key !== "connectionEpoch" && value[key] !== proof[key],
      )
    )
      throw failure("PROTOCOL_MISMATCH", "Organization resource call does not match its requested target")
  }
  const resources: MemberResourceClient = {
    async describe(value, signal) {
      const proof = Execution.DescriptionProof.parse(value)
      return invoke(
        proof,
        Execution.Description,
        async (signal) =>
          client.orgExecution.resources(
            {
              orgExecutionDescriptionRequest: { proof, signature: await Execution.signDescription(proof, options.key) },
            },
            { signal },
          ),
        (result) => grant(proof, result.grant),
        signal,
      )
    },
    async bind(value, signal) {
      const proof = Execution.BindingProof.parse(value)
      return invoke(
        proof,
        Execution.BoundGrant,
        async (signal) =>
          client.orgExecution.bind(
            { orgExecutionBindingRequest: { proof, signature: await Execution.signBinding(proof, options.key) } },
            { signal },
          ),
        (result) => {
          grant(proof, result)
          if (result.retention.state !== "held")
            throw failure("PROTOCOL_MISMATCH", "Execution binding did not retain its resources")
        },
        signal,
      )
    },
    async release(value, signal) {
      const proof = Execution.ReleaseProof.parse(value)
      return invoke(
        proof,
        Execution.ReleaseReceipt,
        async (signal) =>
          client.orgExecution.release(
            { orgExecutionReleaseRequest: { proof, signature: await Execution.signRelease(proof, options.key) } },
            { signal },
          ),
        (result) => {
          const permit = proof.receipt.accepted!.permit
          if (
            result.grantID !== permit.provisionalGrantID ||
            result.orgID !== permit.orgID ||
            result.deploymentIncarnation !== permit.deploymentIncarnation ||
            result.runtimeID !== permit.runtimeID ||
            result.sessionID !== permit.sessionID ||
            result.bindingEpoch !== permit.bindingEpoch ||
            result.rootID !== proof.rootID ||
            result.generation !== proof.generation ||
            result.outcome !== proof.outcome
          )
            throw failure(
              "PROTOCOL_MISMATCH",
              "Execution release receipt does not match its proven resource generation",
            )
        },
        signal,
      )
    },
    async reserve(value, signal) {
      const proof = Gateway.Proof.parse(value)
      return invoke(
        proof,
        Gateway.SignedPermit,
        async (signal) =>
          client.orgGateway.reserve(
            { orgGatewayRequest: { proof, signature: await Gateway.signRequest(proof, options.key) } },
            { signal },
          ),
        async (result) => {
          target(proof, result.permit)
          if (
            result.permit.keyID !== connection.signingIdentity.keyID ||
            !(await Gateway.verifyPermit(result.permit, result.signature, connection.signingIdentity.publicKey))
          )
            throw failure("PROTOCOL_MISMATCH", "Organization resource capability signature is invalid")
        },
        signal,
      )
    },
    async inspect(value, signal) {
      const proof = Gateway.Proof.parse(value)
      return invoke(
        proof,
        Gateway.Receipt,
        async (signal) =>
          client.orgGateway.inspect(
            { orgGatewayRequest: { proof, signature: await Gateway.signRequest(proof, options.key) } },
            { signal },
          ),
        (result) => target(proof, result),
        signal,
      )
    },
  }
  return {
    resources,
    close() {
      stop.abort()
      return (closing ??= Promise.allSettled([...active]).then(() => transport.close()))
    },
  }
}
