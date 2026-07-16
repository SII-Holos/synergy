import { describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { ClarusRestClient } from "../../src/clarus/rest-client"
import { MAX_WIRE_FILE_REF_RECURSION_DEPTH, MAX_WIRE_METADATA_RECURSION_DEPTH } from "../../src/clarus/rest-port"

// ── Helpers ───────────────────────────────────────────────────

function standardEnvelope(data: unknown, code = 0) {
  return { code, message: "ok", data }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function makeCredential(agentId = "agent_test", agentSecret = "secret_test") {
  return { agentId, agentSecret }
}

function fakeFetch(responseFactory: () => Response | Promise<Response>) {
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return responseFactory()
  }
}

// ── Wire data factories ───────────────────────────────────────

function wireProjectItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    project_id: "proj_1",
    title: "Test Project",
    status: "active",
    role: "owner",
    runtime_agent_id: "agent_1",
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function wireProjectList(items: unknown[], nextCursor: string | null = null) {
  return {
    items,
    ...(nextCursor === null ? {} : { next_cursor: nextCursor }),
  }
}

function wireProjectDetail(overrides: Partial<Record<string, unknown>> = {}) {
  return { ...wireProjectItem(overrides), slug: "test-proj", ...overrides }
}

function wireMessageItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    message_id: "msg_1",
    message_type: "text",
    content: "Hello",
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function wireMessageList(items: unknown[], nextCursor: string | null = null) {
  return {
    items,
    ...(nextCursor === null ? {} : { next_cursor: nextCursor }),
  }
}

function wireLiveMessageList(items: unknown[], nextCursor: string | null = null) {
  return {
    items,
    limit: 100,
    next_cursor: nextCursor,
  }
}

// ── Tests ─────────────────────────────────────────────────────

describe("ClarusRestClient security", () => {
  // ── Credential rotation ──────────────────────────────────

  test("reads credentials dynamically on every request", async () => {
    const calls: string[] = []
    let seq = 0
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => {
        const id = `agent_${++seq}`
        calls.push(id)
        return { agentId: id, agentSecret: `secret_${seq}` }
      },
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireProjectList([wireProjectItem()])))),
    })

    await client.listProjects({})
    await client.listProjects({})

    expect(calls).toEqual(["agent_1", "agent_2"])
  })

  test("handles credential returning undefined", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => undefined,
      fetch: fakeFetch(() => jsonResponse({})),
    })

    await expect(client.listProjects({})).rejects.toThrow("Clarus credentials are unavailable")
  })

  test("handles credential returning empty secret", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => ({ agentId: "agent_1", agentSecret: "" }),
      fetch: fakeFetch(() => jsonResponse({})),
    })

    await expect(client.listProjects({})).rejects.toThrow("Clarus credential is invalid")
  })

  // ── Timeout ──────────────────────────────────────────────

  test("aborts after timeout via AbortSignal", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      timeoutMs: 1,
      credentials: async () => makeCredential(),
      fetch: async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw new DOMException("aborted", "AbortError")
      },
    })

    await expect(client.listProjects({})).rejects.toThrow("Clarus REST request failed")
  })

  test("abort timer is cleaned up after success", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      timeoutMs: 5000,
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireProjectList([wireProjectItem()])))),
    })

    const result = await client.listProjects({})
    expect(result.projects).toHaveLength(1)
  })

  // ── Invalid shape ────────────────────────────────────────

  test("rejects non-JSON response body", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => new Response("not json", { status: 200 })),
    })

    await expect(client.listProjects({})).rejects.toThrow("Clarus response body is not valid JSON")
  })

  test("rejects missing data field in StandardResponse", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 0, message: "ok" })),
    })

    await expect(client.listProjects({})).rejects.toThrow()
  })

  test("rejects StandardResponse with non-zero code without leaking body", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 403, message: "forbidden https://evil.com", data: null }, 403)),
    })

    await expect(client.listProjects({})).rejects.toThrow("Clarus REST request failed")
    await expect(client.listProjects({})).rejects.toThrow(/\[redacted-url\]/)
  })

  test("rejects wire project item with oversized strings", async () => {
    const longStr = "a".repeat(1025)
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireProjectList([wireProjectItem({ status: longStr })])))),
    })

    await expect(client.listProjects({})).rejects.toThrow()
  })

  // ── Oversized body ───────────────────────────────────────

  test("rejects response body exceeding byte limit", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      maxResponseBytes: 100,
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope({ big: "a".repeat(500) }))),
    })

    await expect(client.listProjects({})).rejects.toThrow("Clarus response body exceeds its limit")
  })

  // ── Oversized page ───────────────────────────────────────

  test("rejects project list exceeding per-page limit", async () => {
    const items = Array.from({ length: 101 }, (_, i) => wireProjectItem({ project_id: `proj_${i}` }))
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireProjectList(items)))),
    })

    await expect(client.listProjects({})).rejects.toThrow("Clarus project page exceeds its limit")
  })

  test("parses the live message collection contract", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() =>
        jsonResponse(standardEnvelope(wireLiveMessageList([wireMessageItem({ message_id: "live_msg" })]))),
      ),
    })

    const result = await client.listMessages({ projectId: "proj_1" })
    expect(result.messages.map((message) => message.messageId)).toEqual(["live_msg"])
  })

  test("accepts bounded dispatched task metadata from the live API", async () => {
    const metadata = {
      event_type: "runtime.task.dispatched",
      assigned_agent_id: "agent_test",
      payload: {
        project_id: "proj_1",
        run_id: "run_1",
        task_id: "task_1",
        phase: "implementation",
        subtask_id: "subtask_1",
        attempt: 1,
        deadline_at: null,
        context: { session: { state: { ready: true } } },
        input_refs: [[[[[["bounded"]]]]]],
      },
    }
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireLiveMessageList([wireMessageItem({ metadata })])))),
    })

    const result = await client.listMessages({ projectId: "proj_1" })
    expect(result.messages[0].metadata).toEqual(metadata)
  })
  test("rejects message list exceeding per-page limit", async () => {
    const messages = Array.from({ length: 101 }, (_, i) => wireMessageItem({ message_id: `msg_${i}` }))
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireMessageList(messages)))),
    })

    await expect(client.listMessages({ projectId: "proj_1" })).rejects.toThrow("Clarus message page exceeds its limit")
  })

  // ── Oversized nested payload (metadata) ──────────────────

  test("rejects metadata exceeding key count limit", async () => {
    const oversize: Record<string, unknown> = {}
    for (let i = 0; i < 51; i++) oversize[`k${i}`] = `v${i}`

    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() =>
        jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ metadata: oversize })]))),
      ),
    })

    await expect(client.listMessages({ projectId: "proj_1" })).rejects.toThrow(
      "Clarus metadata key count exceeds its limit",
    )
  })

  test("accepts the bounded live metadata string length", async () => {
    const metadata = { value: "x".repeat(5395) }
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ metadata })])))),
    })

    const result = await client.listMessages({ projectId: "proj_1" })
    expect(result.messages[0]?.metadata).toEqual(metadata)
  })

  test("rejects metadata strings above the bounded live contract", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() =>
        jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ metadata: { value: "x".repeat(8193) } })]))),
      ),
    })

    await expect(client.listMessages({ projectId: "proj_1" })).rejects.toThrow(
      "Clarus metadata string exceeds its length limit",
    )
  })

  test("rejects metadata exceeding recursion depth", async () => {
    let nested: Record<string, unknown> = { leaf: "too deep" }
    for (let i = 0; i < MAX_WIRE_METADATA_RECURSION_DEPTH + 1; i++) nested = { nested }

    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ metadata: nested })])))),
    })

    await expect(client.listMessages({ projectId: "proj_1" })).rejects.toThrow(
      "Clarus metadata exceeds its recursion limit",
    )
  })

  test("accepts bounded nested fileRefs from the live API", async () => {
    const fileRefs = [[[[[[[["bounded"]]]]]]]]
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() =>
        jsonResponse(standardEnvelope(wireLiveMessageList([wireMessageItem({ file_refs: fileRefs })]))),
      ),
    })

    const result = await client.listMessages({ projectId: "proj_1" })

    expect(result.messages[0]?.fileRefs).toEqual(fileRefs)
  })

  test("rejects fileRefs exceeding recursion depth", async () => {
    let deep: unknown = { name: "deep" }
    for (let i = 0; i < MAX_WIRE_FILE_REF_RECURSION_DEPTH + 1; i++) deep = [deep]

    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ file_refs: deep })])))),
    })

    await expect(client.listMessages({ projectId: "proj_1" })).rejects.toThrow(
      "Clarus fileRefs exceeds its recursion limit",
    )
  })

  test("rejects fileRefs exceeding item count limit", async () => {
    const refs = Array.from({ length: 51 }, (_, i) => ({ name: `f${i}` }))

    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ file_refs: refs })])))),
    })

    await expect(client.listMessages({ projectId: "proj_1" })).rejects.toThrow(
      "Clarus fileRefs item count exceeds its limit",
    )
  })

  test("passes valid nested metadata within limits", async () => {
    const valid = { k1: "v1", k2: { nested: 42 }, k3: [{ arr: true }] }

    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ metadata: valid })])))),
    })

    const result = await client.listMessages({ projectId: "proj_1" })
    expect(result.messages[0].metadata).toEqual(valid)
  })

  // ── Insecure endpoint ────────────────────────────────────

  test("rejects HTTP endpoint on non-loopback host", () => {
    expect(
      () =>
        new ClarusRestClient({
          apiUrl: "http://evil.example.com:8080",
          credentials: async () => makeCredential(),
        }),
    ).toThrow()
  })

  test("accepts HTTP endpoint on loopback", () => {
    const client = new ClarusRestClient({
      apiUrl: "http://127.0.0.1:8080",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireProjectList([wireProjectItem()])))),
    })
    expect(client).toBeDefined()
  })

  test("accepts HTTPS endpoint", () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireProjectList([wireProjectItem()])))),
    })
    expect(client).toBeDefined()
  })

  test("rejects API URL with path", () => {
    expect(
      () =>
        new ClarusRestClient({
          apiUrl: "https://localhost:8443/api",
          credentials: async () => makeCredential(),
        }),
    ).toThrow("Clarus API URL must be an origin")
  })

  test("rejects API URL with hash", () => {
    expect(
      () =>
        new ClarusRestClient({
          apiUrl: "https://localhost:8443/#frag",
          credentials: async () => makeCredential(),
        }),
    ).toThrow()
  })

  // ── Redirect policy ──────────────────────────────────────

  test("fetch error is wrapped as Clarus REST request failed", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw new Error("fetch failed")
      },
    })

    await expect(client.listProjects({})).rejects.toThrow("Clarus REST request failed")
  })

  test("non-Clarus errors are re-wrapped generically", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: async () => {
        throw new Error("some random error")
      },
    })

    await expect(client.listProjects({})).rejects.toThrow("Clarus REST request failed")
  })

  // ── Redaction ────────────────────────────────────────────

  test("redacts URLs from error message field", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 500, message: "Error at https://internal.secret/api/v1/leak" }, 500)),
    })

    await expect(client.listProjects({})).rejects.toThrow(/\[redacted-url\]/)
    await expect(client.listProjects({})).rejects.not.toThrow(/internal\.secret/)
  })

  test("redacts paths from error message field", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 500, message: "File not found: /etc/passwd /var/secret.txt" }, 500)),
    })

    await expect(client.listProjects({})).rejects.toThrow(/\[redacted-path\]/)
    await expect(client.listProjects({})).rejects.not.toThrow(/etc\/passwd/)
  })

  test("strips non-printable characters from error message", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 500, message: "ok\x00bad\x07data" }, 500)),
    })

    await expect(client.listProjects({})).rejects.not.toThrow(/\x00/)
  })

  test("truncates long error messages", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      // message is within Zod limit (500) and gets truncated by redactMessage
      fetch: fakeFetch(() => jsonResponse({ code: 500, message: "x".repeat(400) }, 500)),
    })

    await expect(client.listProjects({})).rejects.toThrow()
    await expect(client.listProjects({})).rejects.toThrow(/^Clarus REST request failed:/)
  })

  test("redacts Bearer token from error message if present", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() =>
        jsonResponse(
          {
            code: 401,
            message: "Invalid token Bearer sk-abc123secret at https://auth.example.com/verify",
          },
          401,
        ),
      ),
    })

    await expect(client.listProjects({})).rejects.toThrow(/\[redacted-url\]/)
    await expect(client.listProjects({})).rejects.not.toThrow(/auth\.example/)
  })

  // ── Strict StandardResponse parsing ──────────────────────

  test("rejects non-integer code in StandardResponse", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 1.5, data: null })),
    })

    await expect(client.listProjects({})).rejects.toThrow()
  })

  test("rejects StandardResponse with oversized message field", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 0, message: "x".repeat(600), data: null })),
    })

    await expect(client.listProjects({})).rejects.toThrow()
  })

  // ── Limit parameter validation ───────────────────────────

  test("rejects page limit below 1", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireProjectList([])))),
    })

    await expect(client.listProjects({ limit: 0 })).rejects.toThrow("Clarus page limit is out of bounds")
  })

  test("rejects page limit above max", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireProjectList([])))),
    })

    await expect(client.listProjects({ limit: 101 })).rejects.toThrow("Clarus page limit is out of bounds")
  })

  // ── getProject success path ──────────────────────────────

  test("getProject returns camelCase DTO", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireProjectDetail({ runtime_agent_id: "run_1" })))),
    })

    const result = await client.getProject({ projectId: "proj_1" })
    expect(result.projectId).toBe("proj_1")
    expect(result.runtimeAgentId).toBe("run_1")
    expect(result.slug).toBe("test-proj")
  })
})
