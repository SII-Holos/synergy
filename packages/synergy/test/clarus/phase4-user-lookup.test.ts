import { describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { ClarusRestClient } from "../../src/clarus/rest-client"
import { MAX_WIRE_STRING_USER_QUERY, MAX_USER_CANDIDATES, MAX_WIRE_PAGE_SIZE } from "../../src/clarus/rest-port"

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

function wireAgentItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agent_id: "agent_1",
    owner_id: "user_1",
    owner_name: "Alice",
    is_active: true,
    ...overrides,
  }
}

function wireAgentList(items: unknown[], total?: number) {
  return {
    items,
    total: total ?? items.length,
  }
}

function makeClient(fetchOverride?: () => Response | Promise<Response>) {
  return new ClarusRestClient({
    apiUrl: "https://localhost:8443",
    credentials: async () => makeCredential(),
    fetch: fakeFetch(fetchOverride ?? (() => jsonResponse(standardEnvelope(wireAgentList([wireAgentItem()]))))),
  })
}

// ── Tests ─────────────────────────────────────────────────────

describe("ClarusRestClient listUsers", () => {
  // ── Valid mapping ────────────────────────────────────────

  test("maps wire agent to user DTO (snake_case → camelCase)", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(wireAgentList([wireAgentItem({ agent_id: "ag_x", owner_id: "usr_x", owner_name: "Xander" })])),
      ),
    )

    const result = await client.listUsers({ query: "xan" })
    expect(result.users).toHaveLength(1)
    expect(result.users[0]).toEqual({ userId: "usr_x", userName: "Xander", agentId: "ag_x" })
  })

  test("returns empty users when no match", async () => {
    const client = makeClient(() =>
      jsonResponse(standardEnvelope(wireAgentList([wireAgentItem({ agent_id: "ag_a", owner_name: "Zoe" })]))),
    )

    const result = await client.listUsers({ query: "nonexistent" })
    expect(result.users).toEqual([])
  })

  test("maps multiple wire agents to distinct user DTOs", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: "ag_a", owner_id: "usr_a", owner_name: "Alice" }),
            wireAgentItem({ agent_id: "ag_b", owner_id: "usr_b", owner_name: "Bob" }),
          ]),
        ),
      ),
    )

    // Query "a" matches: ag_a (agent_id substring), ag_b (agent_id substring), Alice (owner_name substring)
    const result = await client.listUsers({ query: "a" })
    expect(result.users).toHaveLength(2)
    const names = result.users.map((u) => u.userName).sort()
    expect(names).toEqual(["Alice", "Bob"])
  })

  // ── Max-five cap ─────────────────────────────────────────

  test("caps results at MAX_USER_CANDIDATES (5)", async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      wireAgentItem({
        agent_id: `ag_${i}`,
        owner_id: `usr_${i}`,
        owner_name: `User${i}`,
      }),
    )
    const client = makeClient(() => jsonResponse(standardEnvelope(wireAgentList(items))))

    const result = await client.listUsers({ query: "user" })
    expect(result.users.length).toBeLessThanOrEqual(MAX_USER_CANDIDATES)
  })

  test("cap does not truncate when results are fewer than max", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: "ag_1", owner_id: "usr_1", owner_name: "Alice" }),
            wireAgentItem({ agent_id: "ag_2", owner_id: "usr_2", owner_name: "Bob" }),
          ]),
        ),
      ),
    )

    const result = await client.listUsers({ query: "o" })
    expect(result.users).toHaveLength(1) // only Bob
  })

  // ── Search: case-insensitive matching ────────────────────

  test("case-insensitive match on owner_name", async () => {
    const client = makeClient(() =>
      jsonResponse(standardEnvelope(wireAgentList([wireAgentItem({ owner_name: "ALICE" })]))),
    )

    const result = await client.listUsers({ query: "alice" })
    expect(result.users).toHaveLength(1)
    expect(result.users[0].userName).toBe("ALICE")
  })

  test("case-insensitive match on agent_id", async () => {
    const client = makeClient(() =>
      jsonResponse(standardEnvelope(wireAgentList([wireAgentItem({ agent_id: "AGENT_X" })]))),
    )

    const result = await client.listUsers({ query: "agent_x" })
    expect(result.users).toHaveLength(1)
    expect(result.users[0].agentId).toBe("AGENT_X")
  })

  test("matches substring within owner_name", async () => {
    const client = makeClient(() =>
      jsonResponse(standardEnvelope(wireAgentList([wireAgentItem({ owner_name: "Alexandra" })]))),
    )

    const result = await client.listUsers({ query: "lex" })
    expect(result.users).toHaveLength(1)
  })

  test("matches substring within agent_id", async () => {
    const client = makeClient(() =>
      jsonResponse(standardEnvelope(wireAgentList([wireAgentItem({ agent_id: "synergy_agent_42" })]))),
    )

    const result = await client.listUsers({ query: "agent_42" })
    expect(result.users).toHaveLength(1)
  })

  // ── Exact ID inclusion ───────────────────────────────────

  test("exact agent_id match is prioritized in results", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: "ag_other", owner_id: "usr_other", owner_name: "Other" }),
            wireAgentItem({ agent_id: "ag_target", owner_id: "usr_target", owner_name: "Target" }),
          ]),
        ),
      ),
    )

    const result = await client.listUsers({ query: "ag_target" })
    expect(result.users).toHaveLength(1)
    expect(result.users[0].agentId).toBe("ag_target")
  })

  test("exact agent_id match appears before substring matches", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({
              agent_id: "ag_partial_match",
              owner_id: "usr_p",
              owner_name: "Partial",
            }),
            wireAgentItem({
              agent_id: "ag_exact",
              owner_id: "usr_e",
              owner_name: "Exact",
            }),
          ]),
        ),
      ),
    )

    const result = await client.listUsers({ query: "ag_exact" })
    expect(result.users).toHaveLength(1)
    expect(result.users[0].agentId).toBe("ag_exact")
  })

  // ── Deduplication by owner_id ────────────────────────────

  test("deduplicates by owner_id — same user with multiple agents", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: "ag_1", owner_id: "usr_x", owner_name: "Xander" }),
            wireAgentItem({ agent_id: "ag_2", owner_id: "usr_x", owner_name: "Xander" }),
            wireAgentItem({ agent_id: "ag_3", owner_id: "usr_x", owner_name: "Xander" }),
          ]),
        ),
      ),
    )

    const result = await client.listUsers({ query: "xan" })
    expect(result.users).toHaveLength(1)
    expect(result.users[0].userId).toBe("usr_x")
  })

  test("dedup favors exact agent_id match over other agents of same user", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: "ag_a", owner_id: "usr_x", owner_name: "Xander" }),
            wireAgentItem({ agent_id: "ag_b", owner_id: "usr_x", owner_name: "Xander" }),
          ]),
        ),
      ),
    )

    const result = await client.listUsers({ query: "ag_b" })
    expect(result.users).toHaveLength(1)
    expect(result.users[0].agentId).toBe("ag_b")
  })

  // ── Deterministic ordering ───────────────────────────────

  test("results sorted by userName then agentId", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: "zz_c", owner_id: "usr_c", owner_name: "Charlie" }),
            wireAgentItem({ agent_id: "zz_a", owner_id: "usr_a", owner_name: "Alice" }),
            wireAgentItem({ agent_id: "zz_b", owner_id: "usr_b", owner_name: "Bob" }),
          ]),
        ),
      ),
    )

    // All match via "zz_" in agent_id
    const result = await client.listUsers({ query: "zz_" })
    const names = result.users.map((u) => u.userName)
    expect(names).toEqual(["Alice", "Bob", "Charlie"])
  })

  test("same name ordered by agentId", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: "ag_z", owner_id: "usr_1", owner_name: "Alice" }),
            wireAgentItem({ agent_id: "ag_a", owner_id: "usr_2", owner_name: "Alice" }),
          ]),
        ),
      ),
    )

    const result = await client.listUsers({ query: "ali" })
    const agentIds = result.users.map((u) => u.agentId)
    expect(agentIds).toEqual(["ag_a", "ag_z"])
  })

  // ── Query validation ─────────────────────────────────────

  test("rejects empty query", async () => {
    const client = makeClient()
    await expect(client.listUsers({ query: "" })).rejects.toThrow("Clarus user query must not be empty")
  })

  test("rejects query exceeding max length", async () => {
    const client = makeClient()
    const longQuery = "x".repeat(MAX_WIRE_STRING_USER_QUERY + 1)
    await expect(client.listUsers({ query: longQuery })).rejects.toThrow("Clarus user query exceeds its limit")
  })

  test("accepts query at max length", async () => {
    const client = makeClient()
    const maxQuery = "x".repeat(MAX_WIRE_STRING_USER_QUERY)
    const result = await client.listUsers({ query: maxQuery })
    expect(result.users).toEqual([])
  })

  // ── Limit validation ─────────────────────────────────────

  test("rejects limit below 1", async () => {
    const client = makeClient()
    await expect(client.listUsers({ query: "test", limit: 0 })).rejects.toThrow(
      "Clarus user lookup limit is out of bounds",
    )
  })

  test("rejects limit above MAX_USER_CANDIDATES", async () => {
    const client = makeClient()
    await expect(client.listUsers({ query: "test", limit: MAX_USER_CANDIDATES + 1 })).rejects.toThrow(
      "Clarus user lookup limit is out of bounds",
    )
  })

  test("accepts limit at MAX_USER_CANDIDATES", async () => {
    const client = makeClient(() => jsonResponse(standardEnvelope(wireAgentList([]))))
    const result = await client.listUsers({ query: "test", limit: MAX_USER_CANDIDATES })
    expect(result.users).toEqual([])
  })

  // ── Malformed / oversized response ───────────────────────

  test("rejects non-JSON response", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(
        () =>
          new Response("not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow("Clarus response body is not valid JSON")
  })

  test("rejects oversized response body", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      maxResponseBytes: 10,
      fetch: fakeFetch(() =>
        jsonResponse(standardEnvelope(wireAgentList([wireAgentItem(), wireAgentItem(), wireAgentItem()]))),
      ),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow("Clarus response body exceeds its limit")
  })

  test("rejects response with missing data", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 0, message: "ok" })),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow("Clarus agent list response is malformed")
  })

  test("rejects response with null data", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 0, message: "ok", data: null })),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow("Clarus agent list response is malformed")
  })

  test("rejects response with items exceeding page size", async () => {
    const oversized = Array.from({ length: MAX_WIRE_PAGE_SIZE + 5 }, (_, i) =>
      wireAgentItem({ agent_id: `ag_${i}`, owner_id: `usr_${i}` }),
    )
    const client = makeClient(() => jsonResponse(standardEnvelope(wireAgentList(oversized, oversized.length))))

    await expect(client.listUsers({ query: "test" })).rejects.toThrow("Clarus agent list response is malformed")
  })

  test("skips entries missing agent_id", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: undefined, owner_id: "usr_x", owner_name: "Xander" }),
            wireAgentItem({ agent_id: "ag_valid", owner_id: "usr_y", owner_name: "Yara" }),
          ]),
        ),
      ),
    )

    const result = await client.listUsers({ query: "yara" })
    expect(result.users).toHaveLength(1)
    expect(result.users[0].agentId).toBe("ag_valid")
  })

  test("rejects response with entries missing owner_id", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: "ag_x", owner_id: undefined, owner_name: "Ghost" }),
            wireAgentItem({ agent_id: "ag_y", owner_id: "usr_y", owner_name: "Yara" }),
          ]),
        ),
      ),
    )

    await expect(client.listUsers({ query: "yara" })).rejects.toThrow("Clarus agent list response is malformed")
  })

  test("rejects when all items missing owner_id", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({ agent_id: "ag_a", owner_id: undefined, owner_name: "Ghost" }),
            wireAgentItem({ agent_id: "ag_b", owner_id: undefined, owner_name: "Phantom" }),
          ]),
        ),
      ),
    )

    await expect(client.listUsers({ query: "ghost" })).rejects.toThrow("Clarus agent list response is malformed")
  })

  test("remote request URL uses limit capped at MAX_USER_CANDIDATES", async () => {
    const capturedUrls: string[] = []
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: async (input, _init) => {
        capturedUrls.push(input instanceof Request ? input.url : String(input))
        return jsonResponse(standardEnvelope(wireAgentList([wireAgentItem({ agent_id: "a" })])))
      },
    })

    await client.listUsers({ query: "a" })
    expect(capturedUrls).toHaveLength(1)
    expect(capturedUrls[0]).toContain(`limit=${MAX_USER_CANDIDATES}`)
  })

  // ── Timeout / abort ──────────────────────────────────────

  test("normal fetch completes within timeout", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() =>
        jsonResponse(
          standardEnvelope(
            wireAgentList([
              wireAgentItem({
                agent_id: "match_me",
                owner_id: "usr_1",
                owner_name: "Target",
              }),
            ]),
          ),
        ),
      ),
    })

    const result = await client.listUsers({ query: "match" })
    expect(result.users.length).toBeGreaterThanOrEqual(1)
    expect(result.users[0].agentId).toBe("match_me")
  })

  // ── 401 / 403 / 5xx redaction ────────────────────────────

  test("redacts 401 response", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 1, message: "unauthorized" }, 401)),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow(
      "Clarus REST request failed: status=401 code=1 unauthorized",
    )
  })

  test("redacts 403 response", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 2, message: "forbidden" }, 403)),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow(
      "Clarus REST request failed: status=403 code=2 forbidden",
    )
  })

  test("redacts 500 response", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 5, message: "internal error" }, 500)),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow(
      "Clarus REST request failed: status=500 code=5 internal error",
    )
  })

  test("redacts URLs in error messages", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() => jsonResponse({ code: 1, message: "failed at https://evil.example.com/leak/secret" }, 502)),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow("[redacted-url]")
    await expect(client.listUsers({ query: "test" })).rejects.not.toThrow("evil.example.com")
    await expect(client.listUsers({ query: "test" })).rejects.not.toThrow("secret")
  })

  test("error message length is bounded", async () => {
    // The redactMessage function slices at MAX_WIRE_STRING_ERROR_MESSAGE (500)
    // so long messages are truncated
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: fakeFetch(() =>
        jsonResponse(
          {
            code: 1,
            message: "x".repeat(600),
          },
          500,
        ),
      ),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow()
    // The error message should be truncated, not contain the full 600 chars
    await expect(client.listUsers({ query: "test" })).rejects.not.toThrow("x".repeat(600))
  })

  // ── Dynamic credential refresh ───────────────────────────

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
      fetch: fakeFetch(() => jsonResponse(standardEnvelope(wireAgentList([wireAgentItem({ agent_id: "a" })])))),
    })

    await client.listUsers({ query: "a" })
    await client.listUsers({ query: "b" })

    expect(calls).toEqual(["agent_1", "agent_2"])
  })

  test("handles credential returning undefined", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => undefined,
      fetch: fakeFetch(() => jsonResponse({})),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow("Clarus credentials are unavailable")
  })

  test("handles credential returning empty secret", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => ({ agentId: "agent_1", agentSecret: "" }),
      fetch: fakeFetch(() => jsonResponse({})),
    })

    await expect(client.listUsers({ query: "test" })).rejects.toThrow("Clarus credential is invalid")
  })

  // ── No agent_key leakage ─────────────────────────────────

  test("does not expose agent_key in DTO", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({
              agent_id: "ag_x",
              agent_key: "super_secret_key_do_not_expose",
              owner_id: "usr_x",
              owner_name: "Xander",
            }),
          ]),
        ),
      ),
    )

    const result = await client.listUsers({ query: "xan" })
    expect(result.users).toHaveLength(1)
    const dto = result.users[0] as unknown as Record<string, unknown>
    expect(dto).not.toHaveProperty("agentKey")
    expect(dto).not.toHaveProperty("agent_key")
    expect(JSON.stringify(dto)).not.toContain("super_secret_key_do_not_expose")
  })

  test("DTO only contains userId, userName, agentId", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireAgentList([
            wireAgentItem({
              agent_id: "ag_x",
              agent_key: "sk_abc",
              owner_id: "usr_x",
              owner_name: "Xander",
              profile: { role: "admin" },
              extra_field: "should_not_appear",
            }),
          ]),
        ),
      ),
    )

    const result = await client.listUsers({ query: "xan" })
    expect(result.users).toHaveLength(1)
    const dto = result.users[0]
    expect(Object.keys(dto).sort()).toEqual(["agentId", "userId", "userName"])
  })

  // ── Existing methods unchanged ───────────────────────────

  test("listProjects still works after listUsers addition", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope({
          items: [
            {
              project_id: "proj_1",
              title: "Test",
              status: "active",
              role: "owner",
              updated_at: new Date().toISOString(),
            },
          ],
        }),
      ),
    )

    const result = await client.listProjects({})
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].projectId).toBe("proj_1")
  })

  test("listMessages still works after listUsers addition", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope({
          items: [
            {
              message_id: "msg_1",
              message_type: "text",
              content: "Hello",
              created_at: new Date().toISOString(),
            },
          ],
        }),
      ),
    )

    const result = await client.listMessages({ projectId: "proj_1" })
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].messageId).toBe("msg_1")
  })

  test("getProject still works after listUsers addition", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope({
          project_id: "proj_1",
          title: "Test",
          status: "active",
          role: "owner",
          updated_at: new Date().toISOString(),
        }),
      ),
    )

    const result = await client.getProject({ projectId: "proj_1" })
    expect(result.projectId).toBe("proj_1")
  })
})

// ── Constants ──────────────────────────────────────────────────

describe("listUsers bound constants", () => {
  test("MAX_WIRE_STRING_USER_QUERY is 256", () => {
    expect(MAX_WIRE_STRING_USER_QUERY).toBe(256)
  })

  test("MAX_USER_CANDIDATES is 5", () => {
    expect(MAX_USER_CANDIDATES).toBe(5)
  })
})
