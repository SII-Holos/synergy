import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, test } from "bun:test"
import { ConfigImport } from "@ericsanchezok/synergy-harness/config/import"
import { ObservabilitySchema } from "@ericsanchezok/synergy-harness/observability/schema"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Server } from "../../src/server/server"

runtime.run(() => Log.init({ print: false }))

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])

/** Streams a body without a content-length header, which is the only way to
 *  reach the limiter's byte accounting instead of its header fast path. */
function bodyStream(payload: Uint8Array | string, chunkBytes = 64 * 1024) {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + chunkBytes))
      offset += chunkBytes
    },
  })
}

describe("GET /global/diagnostics", () => {
  test("returns a summary matching the documented diagnostics contract", () =>
    runtime.run(async () => {
      const response = await Server.App().request("/global/diagnostics")

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/json")
      const body = await response.json()
      // The route's OpenAPI response schema is this exact contract; a response it
      // cannot parse is a broken diagnostics surface regardless of contents.
      const parsed = ObservabilitySchema.DiagnosticsSummary.safeParse(body)
      expect(parsed.success).toBe(true)

      const summary = body as ObservabilitySchema.DiagnosticsSummary
      expect(Number.isNaN(Date.parse(summary.generatedAt))).toBe(false)
      expect(Array.isArray(summary.traces.files)).toBe(true)
      expect(Array.isArray(summary.issues)).toBe(true)
      expect(Array.isArray(summary.inflight)).toBe(true)
      expect(Array.isArray(summary.resources.samples)).toBe(true)
      expect(Array.isArray(summary.processes.active)).toBe(true)
      expect(Array.isArray(summary.processes.finished)).toBe(true)
      expect(Array.isArray(summary.sessions.paused)).toBe(true)
    }))
})

describe("GET /sandbox/readiness", () => {
  test("reports platform readiness with per-check diagnostics", () =>
    runtime.run(async () => {
      const response = await Server.App().request("/sandbox/readiness")

      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        platform: string
        backend: string | null
        ready: boolean
        summary: string
        checks: Array<{ id: string; label: string; status: string; detail: string }>
      }

      expect(["macos", "linux", "windows", "unsupported"]).toContain(body.platform)
      expect(typeof body.ready).toBe("boolean")
      expect(body.backend === null || typeof body.backend === "string").toBe(true)
      expect(Array.isArray(body.checks)).toBe(true)
      expect(typeof body.summary).toBe("string")

      for (const check of body.checks) {
        expect(check.id.length).toBeGreaterThan(0)
        expect(check.label.length).toBeGreaterThan(0)
        expect(["pass", "warn", "fail"]).toContain(check.status)
        expect(typeof check.detail).toBe("string")
      }
      expect(new Set(body.checks.map((check) => check.id)).size).toBe(body.checks.length)

      // Readiness is derived from the checks, and the summary explains the
      // verdict: reporting ready while a check failed would mislead `doctor`.
      expect(body.ready).toBe(!body.checks.some((check) => check.status === "fail"))
      if (body.platform === "unsupported") {
        expect(body.ready).toBe(false)
      } else {
        expect(body.checks.length).toBeGreaterThan(0)
        expect(body.summary).toContain(body.ready ? "Sandbox is operational" : "sandbox not ready")
      }
    }))
})

describe("asset route", () => {
  test("stores an uploaded file and serves the same bytes back with an immutable cache header", () =>
    runtime.run(async () => {
      const form = new FormData()
      form.append("file", new File([PNG_BYTES], "pixel.png", { type: "image/png" }))

      const uploaded = await Server.App().request("/asset", { method: "POST", body: form })
      expect(uploaded.status).toBe(200)
      const info = (await uploaded.json()) as { id: string; url: string; mime: string; size: number }
      expect(info.id).toMatch(/^[a-f0-9]{16}\.png$/)
      expect(info.url).toBe(`asset://${info.id}`)
      expect(info.mime).toBe("image/png")
      expect(info.size).toBe(PNG_BYTES.byteLength)

      const fetched = await Server.App().request(`/asset/${info.id}`)
      expect(fetched.status).toBe(200)
      expect(fetched.headers.get("content-type")).toBe("image/png")
      expect(fetched.headers.get("cache-control")).toBe("public, immutable, max-age=31536000")
      expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG_BYTES)
    }))

  test("rejects a form field that is not a file", () =>
    runtime.run(async () => {
      const form = new FormData()
      form.append("file", "not-a-file")

      const response = await Server.App().request("/asset", { method: "POST", body: form })

      expect(response.status).toBe(400)
      expect(((await response.json()) as { message: string }).message).toBe("Missing file field")
    }))

  test("distinguishes a malformed asset id from a missing asset", () =>
    runtime.run(async () => {
      const malformed = await Server.App().request("/asset/not-an-asset-id")
      expect(malformed.status).toBe(400)
      expect(((await malformed.json()) as { message: string }).message).toBe("Invalid asset ID")

      const absentID = "0123456789abcdef.png"
      const missing = await Server.App().request(`/asset/${absentID}`)
      expect(missing.status).toBe(404)
      expect(((await missing.json()) as { message: string }).message).toBe(`Asset not found: ${absentID}`)
    }))
})

describe("request body limit", () => {
  test("passes an in-limit streamed body through to the handler", () =>
    runtime.run(async () => {
      const response = await Server.App().request("/config/import/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyStream(JSON.stringify({ config: {} })),
      })

      // Reaching the handler at all proves the limiter measured the streamed
      // body and admitted it; its own JSON validation is a separate contract.
      expect(response.status).toBe(200)
      expect(typeof ((await response.json()) as { revision: string }).revision).toBe("string")
    }))

  test("rejects an oversized streamed body before the handler runs", () =>
    runtime.run(async () => {
      const response = await Server.App().request("/config/import/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyStream("a".repeat(ConfigImport.MAX_REQUEST_BYTES + 64 * 1024)),
      })
      expect(response.status).toBe(413)
      const body = (await response.json()) as { name: string; data: { message: string; maxBytes: number } }
      expect(body.name).toBe("ConfigImportSourceTooLargeError")
      expect(body.data.message).toContain("CONFIG_TOO_LARGE")
      expect(body.data.maxBytes).toBe(ConfigImport.MAX_REQUEST_BYTES)
    }))
})

afterRuntimeTests(() => runtime.close())
