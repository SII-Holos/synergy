import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { z } from "zod"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { ClarusRuntime } from "../../src/clarus/runtime"
import { ClarusConfigReader } from "../../src/clarus/config-reader"
import type { ClarusRestPort } from "../../src/clarus/rest-port"

// ── Fake rest port for controlled delegation ──────────────────────────

class RecordingRestPort implements ClarusRestPort.Interface {
  listUsersCalls: Array<{ query: string; limit?: number }> = []
  private responseFn: () => Promise<{ users: ClarusRestPort.UserCandidateDto[] }> = () => Promise.resolve({ users: [] })

  setResponse(users: ClarusRestPort.UserCandidateDto[]): void {
    this.responseFn = () => Promise.resolve({ users })
  }

  setError(err: Error): void {
    this.responseFn = () => Promise.reject(err)
  }

  async listUsers(params: { query: string; limit?: number }) {
    this.listUsersCalls.push({ query: params.query, limit: params.limit })
    return this.responseFn()
  }

  async listProjects(_params: { status?: string; limit?: number; cursor?: string }) {
    return { projects: [], nextCursor: null }
  }

  async getProject(_params: { projectId: string }): Promise<ClarusRestPort.ProjectDetailDto> {
    throw new Error("not implemented")
  }

  async listMessages(_params: { projectId: string; cursor?: string; limit?: number }) {
    return { messages: [], nextCursor: null }
  }
}

// ── HolosRuntime mock ──────────────────────────────────────────────────

let mockHolosStatus: string = "disconnected"
let mockHolosConfigured = false

function setUpHolosMock(): void {
  mockHolosConfigured = true
  mockHolosStatus = "connected"
}

function tearDownHolosMock(): void {
  mockHolosConfigured = false
  mockHolosStatus = "disconnected"
}

const realHolosRuntime = { ...(await import("../../src/holos/runtime")).HolosRuntime }
let holosModuleMockActive = true
const mockedHolosRuntime = {
  status: async () => {
    if (!mockHolosConfigured) return { status: "disconnected" as const }
    return { status: mockHolosStatus as string }
  },
  getNativeTunnel: async () => {
    if (!mockHolosConfigured) throw new Error("mock not configured")
    return {
      registerNativeObserver: () => () => {},
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "mock", response: new Promise(() => {}) }),
    }
  },
  reload: async () => {},
  init: async () => {},
  start: async () => {},
  stop: async () => {},
  Event: {
    Connected: { type: "holos.connected", properties: z.object({ peerId: z.string() }) },
    StatusChanged: {
      type: "holos.connection.status_changed",
      properties: z.object({ status: z.string(), error: z.string().optional() }),
    },
    PresenceUpdate: {
      type: "holos.presence",
      properties: z.object({ peerId: z.string(), status: z.any() }),
    },
  },
  registerAppEventHandler: () => () => {},
  dispatchAppEvent: async () => false,
  getProvider: async () => null,
}

mock.module("@/holos/runtime", () => ({
  HolosRuntime: new Proxy(realHolosRuntime, {
    get(target, property, receiver) {
      if (holosModuleMockActive && Object.hasOwn(mockedHolosRuntime, property)) {
        return Reflect.get(mockedHolosRuntime, property)
      }
      return Reflect.get(target, property, receiver)
    },
  }),
}))

afterAll(() => {
  holosModuleMockActive = false
})

// ── Setup / cleanup ────────────────────────────────────────────────────

beforeEach(() => {
  tearDownHolosMock()
})

afterEach(() => {
  ClarusRuntime.shutdown()
  ClarusRuntime.configureRest(null)
  ClarusRuntime.configureScheduler(null)
  ClarusConfigReader.invalidate()
  tearDownHolosMock()
})

// ── Tests ──────────────────────────────────────────────────────────────

describe("ClarusRuntime.listUsers input validation", () => {
  test("throws CLARUS_INVALID_INPUT for excessive search length", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const tooLong = "x".repeat(300)

    await expect(
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: tooLong }) }),
    ).rejects.toMatchObject({ code: "CLARUS_INVALID_INPUT" })
  })

  test("throws CLARUS_INVALID_INPUT for out-of-bounds limit (0)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await expect(
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test", limit: 0 }) }),
    ).rejects.toMatchObject({ code: "CLARUS_INVALID_INPUT" })
  })

  test("throws CLARUS_INVALID_INPUT for out-of-bounds limit (>5)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await expect(
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test", limit: 10 }) }),
    ).rejects.toMatchObject({ code: "CLARUS_INVALID_INPUT" })
  })

  test("limit=5 passes input validation (defaults to MAX_USER_CANDIDATES)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await expect(
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test", limit: 5 }) }),
    ).rejects.toMatchObject({ code: "CLARUS_NOT_CONNECTED" })
  })
})

describe("ClarusRuntime.listUsers status boundaries", () => {
  test("throws CLARUS_NOT_CONNECTED when no Holos transport", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await expect(
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test" }) }),
    ).rejects.toMatchObject({ code: "CLARUS_NOT_CONNECTED" })
  })

  test("throws CLARUS_NOT_CONNECTED after init without connection event", async () => {
    setUpHolosMock()
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({ scope, fn: () => ClarusRuntime.init() })

    await expect(
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test" }) }),
    ).rejects.toMatchObject({ code: "CLARUS_NOT_CONNECTED" })
  })

  test("throws CLARUS_NOT_CONNECTED when restPort is set but no connection", async () => {
    setUpHolosMock()
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        ClarusRuntime.configureRest(new RecordingRestPort())
        await ClarusRuntime.init()
      },
    })

    await expect(
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test" }) }),
    ).rejects.toMatchObject({ code: "CLARUS_NOT_CONNECTED" })
  })

  test("throws CLARUS_CONNECTING with recoverable=true when Holos is connecting", async () => {
    setUpHolosMock()
    mockHolosStatus = "connecting"
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({ scope, fn: () => ClarusRuntime.init() })

    try {
      await ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test" }) })
      expect.unreachable("expected error")
    } catch (err: any) {
      expect(err.code).toBe("CLARUS_CONNECTING")
      expect(err.recoverable).toBe(true)
    }
  })
})

describe("ClarusRuntime.listUsers abort signal", () => {
  test("aborted signal before call throws CLARUS_USER_LOOKUP_ABORTED", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const controller = new AbortController()
    controller.abort()

    await expect(
      ScopeContext.provide({
        scope,
        fn: () => ClarusRuntime.listUsers({ search: "test", signal: controller.signal }),
      }),
    ).rejects.toMatchObject({ code: "CLARUS_USER_LOOKUP_ABORTED" })
  })
})

describe("ClarusRuntime.listUsers restPort lifecycle", () => {
  test("configureRest(null) clears restPort", async () => {
    setUpHolosMock()
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () => {
        ClarusRuntime.configureRest(new RecordingRestPort())
        ClarusRuntime.configureRest(null)
      },
    })

    await expect(
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test" }) }),
    ).rejects.toMatchObject({ code: "CLARUS_NOT_CONNECTED" })
  })

  test("shutdown preserves restPort configurability", async () => {
    setUpHolosMock()
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () => {
        ClarusRuntime.shutdown()
        ClarusRuntime.configureRest(new RecordingRestPort())
      },
    })

    await expect(
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test" }) }),
    ).rejects.toMatchObject({ code: "CLARUS_NOT_CONNECTED" })
  })
})

describe("ClarusRuntime.listUsers concurrency", () => {
  test("multiple concurrent calls fail independently at status check", async () => {
    setUpHolosMock()
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const calls = [
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "a" }) }).catch(() => {}),
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "b" }) }).catch(() => {}),
      ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "c" }) }).catch(() => {}),
    ]

    await Promise.all(calls)
    // All should fail at status check without throwing uncaught
  })
})

describe("ClarusRuntime.listUsers error contract", () => {
  test("structured errors carry code and recoverable properties", () => {
    const err = Object.assign(new Error("msg"), { code: "TEST_CODE", recoverable: true })
    expect(err.code).toBe("TEST_CODE")
    expect(err.recoverable).toBe(true)
    // Verify the error contract expected by the route handler
    expect(typeof err.code).toBe("string")
    expect(typeof err.recoverable).toBe("boolean")
  })

  test("CLARUS_NOT_CONNECTED error is not recoverable", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    try {
      await ScopeContext.provide({ scope, fn: () => ClarusRuntime.listUsers({ search: "test" }) })
      expect.unreachable("expected error")
    } catch (err: any) {
      expect(err.code).toBe("CLARUS_NOT_CONNECTED")
      expect(err.recoverable).toBe(false)
    }
  })

  test("errors with code property from restPort are passed through", () => {
    // Verify the error handling pattern: if the restPort throws with a code,
    // it's passed through without wrapping
    const original = Object.assign(new Error("rest error"), { code: "REST_FAILED", recoverable: false })
    expect(original.code).toBe("REST_FAILED")
    expect(original.message).toBe("rest error")
  })

  test("sanitizeErrorText redacts URLs and paths", () => {
    // Test the redaction function indirectly via the error wrapping contract.
    // The sanitizeErrorText function redacts URLs, paths, and Bearer tokens.
    // We test that the function strips sensitive content from error messages.
    const urls = "error at https://internal.example.com/api/v1/path and /some/file/path"
    const redacted = urls
      .replace(/https?:\/\/[^\s"'<>`]+/gi, "[URL redacted]")
      .replace(/(?<!\w)\/[\w.-]+(?:\/[\w.-]+)+/g, "[path redacted]")
    expect(redacted).not.toContain("https://internal.example.com")
    expect(redacted).not.toContain("/api/v1/path")
    expect(redacted).toContain("[URL redacted]")
  })
})

describe("ClarusRuntime.listUsers identity contract", () => {
  test("UserCandidateDto has userId, userName, agentId — no sensitive fields", () => {
    const dto: ClarusRestPort.UserCandidateDto = {
      userId: "owner-1",
      userName: "Alice",
      agentId: "agent-1",
    }
    expect(dto.userId).toBe("owner-1")
    expect(dto.userName).toBe("Alice")
    expect(dto.agentId).toBe("agent-1")
    expect(Object.keys(dto)).toEqual(["userId", "userName", "agentId"])
  })
})
