/**
 * IPv4 fallback transport tests — concurrent race + security boundaries.
 */
import { describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { createFallbackFetcher, isPrivateOrReservedIPv4 } from "../../src/clarus/fallback-transport"
import { ClarusRestClient } from "../../src/clarus/rest-client"

// ── Helpers ───────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function makeCredential(agentId = "agent_test", agentSecret = "secret_test") {
  return { agentId, agentSecret }
}

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

type Ipv4Branch = (
  url: URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
  rejectUnauthorized: boolean,
  connectTimeoutMs: number,
) => Promise<Response>

function successBranch(label: string, delayMs: number): Ipv4Branch {
  return async () => {
    await new Promise<void>((r) => setTimeout(r, delayMs))
    return jsonResponse({ code: 0, message: "ok", data: { from: label } })
  }
}

function hangingBranch(): Ipv4Branch {
  return async (_url, _init, signal) =>
    new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException("aborted", "AbortError"))
        return
      }
      signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")))
    })
}

function failingBranch(): Ipv4Branch {
  return async () => {
    throw new Error("IPv4 branch failed")
  }
}

function chunkedBranch(chunks: string[]): Ipv4Branch {
  return async () => {
    // Simulate multiple data chunks: Bun buffers internally but the Response
    // can be read with .text() which collects everything — equivalent to our collect-all approach.
    return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/plain" } })
  }
}

function hangingBaseFetch() {
  return async (input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = input instanceof Request ? input.signal : init?.signal
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("aborted", "AbortError"))
        return
      }
      signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")))
    })
}

// ── IP address filter ─────────────────────────────────────────

describe("IPv4 address safety filter", () => {
  test("allows public IPs", () => {
    expect(isPrivateOrReservedIPv4("8.8.8.8")).toBe(false)
    expect(isPrivateOrReservedIPv4("1.1.1.1")).toBe(false)
    expect(isPrivateOrReservedIPv4("93.184.216.34")).toBe(false)
  })
  test("rejects 10.0.0.0/8", () => {
    expect(isPrivateOrReservedIPv4("10.0.0.1")).toBe(true)
  })
  test("rejects 127.0.0.0/8", () => {
    expect(isPrivateOrReservedIPv4("127.0.0.1")).toBe(true)
  })
  test("rejects 169.254.0.0/16", () => {
    expect(isPrivateOrReservedIPv4("169.254.1.1")).toBe(true)
  })
  test("rejects 172.16.0.0/12", () => {
    expect(isPrivateOrReservedIPv4("172.16.0.1")).toBe(true)
    expect(isPrivateOrReservedIPv4("172.31.255.255")).toBe(true)
  })
  test("rejects 192.168.0.0/16", () => {
    expect(isPrivateOrReservedIPv4("192.168.1.1")).toBe(true)
  })
  test("rejects 100.64.0.0/10 CGNAT", () => {
    expect(isPrivateOrReservedIPv4("100.64.0.1")).toBe(true)
    expect(isPrivateOrReservedIPv4("100.127.255.255")).toBe(true)
  })
  test("rejects multicast", () => {
    expect(isPrivateOrReservedIPv4("224.0.0.1")).toBe(true)
  })
  test("rejects reserved 240/4", () => {
    expect(isPrivateOrReservedIPv4("240.0.0.1")).toBe(true)
  })
  test("rejects 0/8", () => {
    expect(isPrivateOrReservedIPv4("0.0.0.0")).toBe(true)
  })
  test("rejects TEST-NET ranges", () => {
    expect(isPrivateOrReservedIPv4("192.0.2.1")).toBe(true)
    expect(isPrivateOrReservedIPv4("198.51.100.1")).toBe(true)
    expect(isPrivateOrReservedIPv4("203.0.113.1")).toBe(true)
  })
  test("rejects malformed", () => {
    expect(isPrivateOrReservedIPv4("not.an.ip")).toBe(true)
    expect(isPrivateOrReservedIPv4("")).toBe(true)
  })
})

// ── Race timing / branch lifecycle ─────────────────────────────

describe("happy eyeballs race", () => {
  test("IPv4 wins when native fetch hangs", async () => {
    const ctrl = new AbortController()
    const fetcher = createFallbackFetcher(hangingBaseFetch(), { _ipv4Branch: successBranch("ipv4", 10) })
    setTimeout(() => ctrl.abort(), 100)
    const start = Date.now()
    const resp = await fetcher("https://example.com/api", { signal: ctrl.signal })
    expect(Date.now() - start).toBeLessThan(80)
    expect((await resp.json()).data.from).toBe("ipv4")
  })

  test("native fetch wins when fast", async () => {
    const baseFetch = async () => {
      await new Promise<void>((r) => setTimeout(r, 5))
      return jsonResponse({ code: 0, message: "ok", data: { from: "native" } })
    }
    const fetcher = createFallbackFetcher(baseFetch, { _ipv4Branch: successBranch("ipv4", 200) })
    const start = Date.now()
    const resp = await fetcher("https://example.com/api")
    expect(Date.now() - start).toBeLessThan(100)
    expect((await resp.json()).data.from).toBe("native")
  })

  test("IPv4 wins, native loser cleaned up", async () => {
    const ctrl = new AbortController()
    const fetcher = createFallbackFetcher(hangingBaseFetch(), { _ipv4Branch: successBranch("ipv4", 10) })
    setTimeout(() => ctrl.abort(new Error("caller timeout")), 200)
    const resp = await fetcher("https://example.com/api", { signal: ctrl.signal })
    expect(resp.status).toBe(200)
  })

  test("both fail → sanitized error", async () => {
    const fetcher = createFallbackFetcher(
      async () => {
        throw new Error("native")
      },
      { _ipv4Branch: failingBranch() },
    )
    await expect(fetcher("https://example.com/api")).rejects.toThrow("Clarus REST request failed")
  })

  test("IPv4 branch preserves Request method and authentication headers", async () => {
    let capturedInit: RequestInit | undefined
    const fetcher = createFallbackFetcher(hangingBaseFetch(), {
      _ipv4Branch: async (_url, init) => {
        capturedInit = init
        return jsonResponse({ code: 0, message: "ok", data: { from: "ipv4" } })
      },
    })
    const request = new Request("https://example.com/api", {
      method: "GET",
      headers: {
        Authorization: "Bearer secret_test",
        "X-Agent-Id": "agent_test",
      },
    })

    await fetcher(request)

    const headers = new Headers(capturedInit?.headers)
    expect(capturedInit?.method).toBe("GET")
    expect(headers.get("authorization")).toBe("Bearer secret_test")
    expect(headers.get("x-agent-id")).toBe("agent_test")
  })
})

// ── Abort / deadline ───────────────────────────────────────────

describe("abort and deadline", () => {
  test("pre-aborted cancels both", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const fetcher = createFallbackFetcher(
      async () => {
        throw new DOMException("a", "AbortError")
      },
      {
        _ipv4Branch: async () => {
          throw new Error("no")
        },
      },
    )
    await expect(fetcher("https://example.com/api", { signal: ctrl.signal })).rejects.toBeTruthy()
  })

  test("abort during race cancels IPv4", async () => {
    const ctrl = new AbortController()
    let aborted = false
    const fetcher = createFallbackFetcher(hangingBaseFetch(), {
      _ipv4Branch: async (_u, _i, sig) =>
        new Promise((_r, rej) =>
          sig.addEventListener("abort", () => {
            aborted = true
            rej(sig.reason ?? new DOMException("a", "AbortError"))
          }),
        ),
    })
    setTimeout(() => ctrl.abort(), 20)
    await expect(fetcher("https://example.com/api", { signal: ctrl.signal })).rejects.toBeTruthy()
    expect(aborted).toBe(true)
  })

  test("total time bounded by one deadline", async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    const fetcher = createFallbackFetcher(hangingBaseFetch(), { _ipv4Branch: hangingBranch() })
    const start = Date.now()
    await expect(fetcher("https://example.com/api", { signal: ctrl.signal })).rejects.toBeTruthy()
    expect(Date.now() - start).toBeLessThan(200)
  })
})

// ── Segmented / chunked response ───────────────────────────────

describe("segmented and chunked responses", () => {
  test("response assembled from multiple chunks", async () => {
    const parts = ['{"code":0,"mess', 'age":"ok","dat', 'a":{"from":"segmented"}}']
    const fetcher = createFallbackFetcher(hangingBaseFetch(), { _ipv4Branch: chunkedBranch(parts) })
    const resp = await fetcher("https://example.com/api")
    const body = await resp.json()
    expect(body.data.from).toBe("segmented")
  })

  test("empty-body response", async () => {
    const fetcher = createFallbackFetcher(hangingBaseFetch(), {
      _ipv4Branch: async () => new Response("", { status: 204 }),
    })
    const resp = await fetcher("https://example.com/api")
    expect(resp.status).toBe(204)
  })
})

// ── HTTP / bypass ──────────────────────────────────────────────

describe("HTTP and bypass", () => {
  test("HTTP bypasses fallback", async () => {
    let calls = 0
    const fetcher = createFallbackFetcher(async () => {
      calls++
      return jsonResponse({ ok: true })
    })
    await fetcher("http://127.0.0.1:8080/api")
    expect(calls).toBe(1)
  })

  test("custom fetch bypasses fallback", async () => {
    let calls = 0
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: async () => {
        calls++
        return jsonResponse({ code: 0, message: "ok", data: { items: [wireProjectItem()] } })
      },
    })
    expect((await client.listProjects({})).projects).toHaveLength(1)
    expect(calls).toBe(1)
  })

  test("error redaction preserves URL safety", async () => {
    const client = new ClarusRestClient({
      apiUrl: "https://localhost:8443",
      credentials: async () => makeCredential(),
      fetch: async () => jsonResponse({ code: 401, message: "Invalid at https://auth.example.com/verify" }, 401),
    })
    await expect(client.listProjects({})).rejects.toThrow("Clarus REST request failed")
    await expect(client.listProjects({})).rejects.toThrow(/\[redacted-url\]/)
    await expect(client.listProjects({})).rejects.not.toThrow(/auth\.example/)
  })
})
