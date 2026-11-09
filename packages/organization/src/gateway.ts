import { z } from "zod"
import { OrganizationGatewayProtocol as Gateway } from "@ericsanchezok/synergy-organization-protocol"
import { fail, OrganizationError } from "./error"
import type { GatewayCalls } from "./gateway-calls"

async function readBody(request: Request, maximum: number, signal: AbortSignal) {
  const reader = request.body?.getReader()
  if (!reader) fail("INVALID_REQUEST", "Model request body is required")
  const chunks: Uint8Array[] = []
  let bytes = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read()
      signal.throwIfAborted()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > maximum) fail("RESOURCE_UNAVAILABLE", "Gateway request exceeds its byte allowance")
      chunks.push(item.value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return body
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createModelGateway(options: { calls: GatewayCalls; run<T>(body: () => T | Promise<T>): Promise<T> }) {
  const transport = new Bun.FetchSession({ proxy: false, tls: { rejectUnauthorized: true } })
  const active = new Set<{ grantID: string; controller: AbortController; done: Promise<void> }>()
  let reservedBytes = 0
  let closed = false
  return {
    assertDrained(grantID: string) {
      if ([...active].some((entry) => entry.grantID === grantID))
        fail("RESOURCE_UNAVAILABLE", "Root model requests have not drained")
    },
    async invoke(request: Request, resourceID: string, protocol: Gateway.ModelProtocol): Promise<Response> {
      if (closed) fail("SERVICE_UNAVAILABLE", "Model gateway is closed")
      if (request.headers.has("origin") || request.headers.has("cookie"))
        fail("PERMISSION_DENIED", "Gateway capabilities cannot be used by browser sessions")
      if (new URL(request.url).search || request.headers.has("content-encoding"))
        fail("INVALID_REQUEST", "Gateway model requests cannot change transport routing")
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
        fail("INVALID_REQUEST", "Model requests require JSON")
      const beta =
        protocol === "anthropic-compatible"
          ? request.headers
              .get("anthropic-beta")
              ?.split(",")
              .map((name) => name.trim())
          : undefined
      if (beta && (beta.length > 16 || beta.some((name) => !/^[a-z][a-z0-9-]{0,95}$/.test(name))))
        fail("INVALID_REQUEST", "Invalid model protocol extension header")
      const bearer = request.headers.get("authorization")
      const key = request.headers.get("x-api-key")
      if (bearer && key) fail("PERMISSION_DENIED", "Use one gateway capability")
      const token = protocol === "anthropic-compatible" ? key : bearer?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1]
      let parsed: Gateway.SignedPermit
      try {
        parsed = Gateway.decode(token ?? "")
      } catch {
        fail("PERMISSION_DENIED", "Invalid gateway capability")
      }
      if (parsed.permit.resourceID !== resourceID || parsed.permit.protocol !== protocol)
        fail("PERMISSION_DENIED", "Gateway capability does not match this route")
      const authorization = await options.calls.authorize(parsed)
      const { permit } = authorization
      if (closed) fail("SERVICE_UNAVAILABLE", "Model gateway is closed")
      if (active.size >= 32 || reservedBytes + permit.requestBytes > 64 * 1024 * 1024)
        fail("RESOURCE_UNAVAILABLE", "Model gateway capacity is occupied")
      const controller = new AbortController()
      const completion = Promise.withResolvers<void>()
      const entry = { grantID: permit.grantID, controller, done: completion.promise }
      active.add(entry)
      reservedBytes += permit.requestBytes
      const signal = AbortSignal.any([request.signal, controller.signal])
      let timer = setTimeout(() => controller.abort(), Math.min(30_000, Math.max(1, permit.expiresAt - Date.now())))
      let started = false
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let responseBytes = 0
      let httpStatus: number | undefined
      let finishing: Promise<void> | undefined
      let abort: (() => void) | undefined
      function finish(state: "response_complete" | "unknown") {
        if (finishing) return finishing
        finishing = (async () => {
          clearTimeout(timer)
          if (abort) signal.removeEventListener("abort", abort)
          try {
            if (state === "unknown") controller.abort()
            if (reader) {
              if (state === "unknown") await reader.cancel().catch(() => {})
              reader.releaseLock()
            }
            if (started)
              await options.run(() => options.calls.finish(authorization, { state, responseBytes, httpStatus }))
          } finally {
            active.delete(entry)
            reservedBytes -= permit.requestBytes
            completion.resolve()
          }
        })()
        return finishing
      }
      try {
        const body = await readBody(request, permit.requestBytes, signal)
        let content: Record<string, unknown>
        try {
          content = z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)))
        } catch {
          fail("INVALID_REQUEST", "Invalid model request JSON")
        }
        if (content.model !== permit.modelID) fail("PERMISSION_DENIED", "Model is outside this call capability")
        const digest = Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("hex")
        const admitted = await options.calls.start(authorization, { hash: digest, bytes: body.byteLength, signal })
        started = true
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), permit.timeoutMs)
        signal.throwIfAborted()
        const headers = new Headers({
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        })
        // Provenance: https://ai-sdk.dev/providers/openai-compatible-providers and https://platform.claude.com/docs/en/api/versioning
        // Local adaptation: fixed protocol paths and server-owned authentication; caller headers never select upstream routing.
        if (permit.protocol === "anthropic-compatible") headers.set("anthropic-version", "2023-06-01")
        // Provenance: https://platform.claude.com/docs/en/api/beta-headers
        // Local adaptation: only bounded feature names may accompany the fixed Messages protocol.
        if (beta) headers.set("anthropic-beta", [...new Set(beta)].join(","))
        if (admitted.credential.kind === "bearer") headers.set("authorization", `Bearer ${admitted.credential.value}`)
        if (admitted.credential.kind === "header") headers.set(admitted.credential.name, admitted.credential.value)
        const suffix = permit.protocol === "openai-compatible" ? "/chat/completions" : "/messages"
        const response = await transport.fetch(admitted.configuration.endpoint.replace(/\/+$/, "") + suffix, {
          method: "POST",
          headers,
          body,
          signal,
          redirect: "manual",
          credentials: "omit",
        })
        httpStatus = response.status
        reader = response.body?.getReader()
        if (response.status >= 300 && response.status < 400) {
          await finish("unknown")
          throw new OrganizationError({
            code: "RESOURCE_UNAVAILABLE",
            message: "The configured model endpoint redirected the request",
            outcome: "unknown",
            retryable: false,
          })
        }
        const outgoing = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" })
        const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
        if (type !== "application/json" && type !== "text/event-stream") {
          await finish("unknown")
          throw new OrganizationError({
            code: "PROTOCOL_MISMATCH",
            message: "Model returned an unsupported response type",
            outcome: "unknown",
            retryable: false,
          })
        }
        outgoing.set("content-type", type)
        if (!response.ok) {
          outgoing.set("content-type", "application/json")
          const retryAfter = response.headers.get("retry-after")
          if (retryAfter && /^\d{1,6}$/.test(retryAfter)) outgoing.set("retry-after", retryAfter)
          await finish("unknown")
          return Response.json(
            { error: { type: "upstream_error", message: "The configured model rejected the request" } },
            { status: response.status, headers: outgoing },
          )
        }
        if (!reader) {
          await finish("unknown")
          throw new OrganizationError({
            code: "PROTOCOL_MISMATCH",
            message: "Model response body is missing",
            outcome: "unknown",
            retryable: false,
          })
        }
        const stream = new ReadableStream<Uint8Array>(
          {
            start(stream) {
              abort = () => {
                if (finishing) return
                stream.error(new Error("Organization model stream was interrupted"))
                void finish("unknown").catch(() => {})
              }
              signal.addEventListener("abort", abort, { once: true })
              if (signal.aborted) abort()
            },
            async pull(stream) {
              try {
                signal.throwIfAborted()
                const item = await reader!.read()
                signal.throwIfAborted()
                if (item.done) {
                  await finish("response_complete")
                  stream.close()
                  return
                }
                responseBytes += item.value.byteLength
                if (responseBytes > permit.responseBytes) throw new Error("Model response exceeds its byte allowance")
                stream.enqueue(item.value)
              } catch {
                await finish("unknown")
                stream.error(new Error("Organization model stream was interrupted"))
              }
            },
            async cancel() {
              await finish("unknown")
            },
          },
          { highWaterMark: 0 },
        )
        return new Response(stream, { status: response.status, headers: outgoing })
      } catch (error) {
        await finish("unknown")
        if (error instanceof OrganizationError) throw error
        throw new OrganizationError({
          code: "SERVICE_UNAVAILABLE",
          message: "The organization model request could not complete",
          outcome: started ? "unknown" : "not_dispatched",
          retryable: false,
        })
      }
    },
    async close() {
      closed = true
      for (const entry of active) entry.controller.abort()
      await Promise.allSettled([...active].map((entry) => entry.done))
      transport.close()
    },
  }
}
export type ModelGateway = ReturnType<typeof createModelGateway>
