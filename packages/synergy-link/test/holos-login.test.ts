import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkHolosAuth } from "../src/holos/auth"
import { SynergyLinkHolosLogin } from "../src/holos/login"

const tempRoots: string[] = []

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-login-test-"))
  tempRoots.push(root)
  return root
}

async function configureEndpoints(root: string, port: number) {
  const configPath = SynergyLinkHolosAuth.globalConfigPath()
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({
      holos: {
        apiUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}`,
        portalUrl: `http://127.0.0.1:${port}`,
      },
    }),
  )
}

const originalSynergyHome = process.env.SYNERGY_TEST_HOME
const originalLinkHome = process.env.SYNERGY_LINK_HOME

afterEach(() => {
  if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalSynergyHome
  if (originalLinkHome === undefined) delete process.env.SYNERGY_LINK_HOME
  else process.env.SYNERGY_LINK_HOME = originalLinkHome
})

describe("synergy-link login secret files", () => {
  test("reads a protected secret file and strips trailing newlines", async () => {
    const root = await createRoot()
    const secretPath = path.join(root, "secret")
    await writeFile(secretPath, "candidate-secret\n", { mode: 0o600 })
    expect(await SynergyLinkHolosLogin.readAgentSecretFile(secretPath)).toBe("candidate-secret")

    await writeFile(secretPath, "candidate-secret\r\n", { mode: 0o600 })
    expect(await SynergyLinkHolosLogin.readAgentSecretFile(secretPath)).toBe("candidate-secret")

    await writeFile(secretPath, "candidate-secret", { mode: 0o600 })
    expect(await SynergyLinkHolosLogin.readAgentSecretFile(secretPath)).toBe("candidate-secret")
  })

  test("rejects missing files, directories, and oversized secrets", async () => {
    const root = await createRoot()
    await expect(SynergyLinkHolosLogin.readAgentSecretFile(path.join(root, "absent"))).rejects.toThrow(
      "Could not read agent secret file.",
    )

    await mkdir(path.join(root, "dir"))
    await expect(SynergyLinkHolosLogin.readAgentSecretFile(path.join(root, "dir"))).rejects.toThrow(
      "Could not read agent secret file.",
    )

    const oversizedPath = path.join(root, "oversized")
    await writeFile(oversizedPath, "x".repeat(5000))
    await expect(SynergyLinkHolosLogin.readAgentSecretFile(oversizedPath)).rejects.toThrow("exceeds 4096 bytes")
  })

  test("rejects empty, multi-line, and null-byte secret content", async () => {
    const root = await createRoot()
    const emptyPath = path.join(root, "empty")
    await writeFile(emptyPath, "\n")
    await expect(SynergyLinkHolosLogin.readAgentSecretFile(emptyPath)).rejects.toThrow("is empty")

    const multiLinePath = path.join(root, "multiline")
    await writeFile(multiLinePath, "one\ntwo")
    await expect(SynergyLinkHolosLogin.readAgentSecretFile(multiLinePath)).rejects.toThrow("invalid content")

    const nullPath = path.join(root, "nullbyte")
    await writeFile(nullPath, "sec\u0000ret")
    await expect(SynergyLinkHolosLogin.readAgentSecretFile(nullPath)).rejects.toThrow("invalid content")
  })

  test("warns when a posix secret file is readable by group or others", async () => {
    const root = await createRoot()
    const secretPath = path.join(root, "secret")
    await writeFile(secretPath, "candidate-secret\n", { mode: 0o644 })
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    await expect(SynergyLinkHolosLogin.readAgentSecretFile(secretPath)).resolves.toBe("candidate-secret")
    errorSpy.mockRestore()
  })
})

describe("synergy-link login credential verification", () => {
  test("verifies valid ws tokens against configured endpoints", async () => {
    const root = await createRoot()
    process.env.SYNERGY_TEST_HOME = root
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          expect(request.headers.get("authorization")).toBe("Bearer candidate-secret")
          return Response.json({ code: 0, data: { ws_token: "token", expires_in: 60 } })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    await configureEndpoints(root, server.port)

    await expect(SynergyLinkHolosLogin.verifySecret("candidate-secret")).resolves.toEqual({ valid: true })
  })

  test("reports rejected credentials for non-zero codes and http failures", async () => {
    const root = await createRoot()
    process.env.SYNERGY_TEST_HOME = root
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token") && request.headers.get("authorization") === "Bearer ok-secret") {
          return Response.json({ code: 0, data: { ws_token: "token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 1, message: "nope" }, { status: 403 })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    await configureEndpoints(root, server.port)

    await expect(SynergyLinkHolosLogin.verifySecret("bad-secret")).resolves.toEqual({
      valid: false,
      reason: "Holos rejected the credentials.",
    })
  })

  test("reports verification failures for malformed responses and network errors", async () => {
    const root = await createRoot()
    process.env.SYNERGY_TEST_HOME = root
    using server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ unexpected: true })
      },
    })
    await configureEndpoints(root, server.port)
    await expect(SynergyLinkHolosLogin.verifySecret("candidate-secret")).resolves.toEqual({
      valid: false,
      reason: "Holos rejected the credentials.",
    })

    const deadRoot = await createRoot()
    process.env.SYNERGY_TEST_HOME = deadRoot
    const configPath = SynergyLinkHolosAuth.globalConfigPath()
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        holos: { apiUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1", portalUrl: "http://127.0.0.1:1" },
      }),
    )
    await expect(SynergyLinkHolosLogin.verifySecret("candidate-secret")).resolves.toEqual({
      valid: false,
      reason: "Holos credential verification failed.",
    })
  })

  test("verifyCredentials matches the agent identity returned by holos", async () => {
    const root = await createRoot()
    process.env.SYNERGY_TEST_HOME = root
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: "token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/me")) {
          return Response.json({ code: 0, data: { agent_id: "agent_a", profile: null } })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    await configureEndpoints(root, server.port)

    await expect(
      SynergyLinkHolosLogin.verifyCredentials({ agentID: "agent_a", agentSecret: "candidate-secret" }),
    ).resolves.toEqual({ valid: true, agentID: "agent_a" })

    await expect(
      SynergyLinkHolosLogin.verifyCredentials({ agentID: "agent_other", agentSecret: "candidate-secret" }),
    ).resolves.toEqual({
      valid: false,
      reason: "Holos secret belongs to agent_a, not agent_other.",
    })
  })

  test("verifyCredentials reports identity failures for http errors and missing identities", async () => {
    const root = await createRoot()
    process.env.SYNERGY_TEST_HOME = root
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: "token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/me")) {
          return Response.json({ message: "boom" }, { status: 401 })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    await configureEndpoints(root, server.port)

    await expect(
      SynergyLinkHolosLogin.verifyCredentials({ agentID: "agent_a", agentSecret: "candidate-secret" }),
    ).resolves.toEqual({ valid: false, reason: "Holos could not verify the credential identity." })
  })

  test("loginWithExistingCredentials persists verified credentials", async () => {
    const root = await createRoot()
    process.env.SYNERGY_TEST_HOME = root
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: "token", expires_in: 60 } })
        }
        if (url.pathname.endsWith("/me")) {
          return Response.json({ code: 0, data: { agent_id: "agent_a", profile: null } })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    await configureEndpoints(root, server.port)

    await expect(
      SynergyLinkHolosLogin.loginWithExistingCredentials({ agentID: "agent_a", agentSecret: "candidate-secret" }),
    ).resolves.toEqual({ agentID: "agent_a" })

    const stored = await SynergyLinkHolosAuth.load()
    expect(stored).toEqual({ agentID: "agent_a", agentSecret: "candidate-secret" })

    const config = JSON.parse(await Bun.file(SynergyLinkHolosAuth.globalConfigPath()).text())
    expect(config.holos.enabled).toBe(true)
  })

  test("loginWithExistingCredentials rejects invalid credentials", async () => {
    const root = await createRoot()
    process.env.SYNERGY_TEST_HOME = root
    using server = Bun.serve({ port: 0, fetch: () => Response.json({ code: 1 }, { status: 403 }) })
    await configureEndpoints(root, server.port)

    await expect(
      SynergyLinkHolosLogin.loginWithExistingCredentials({ agentID: "agent_a", agentSecret: "candidate-secret" }),
    ).rejects.toThrow("Credential validation failed")
  })

  test("createBindURL builds portal bind urls with callbacks and state", () => {
    const url = SynergyLinkHolosLogin.createBindURL({
      callbackURL: "http://127.0.0.1:19836/holos/login",
      state: "state-123",
    })
    const parsed = new URL(url)
    expect(parsed.origin).toBe("https://www.holosai.io")
    expect(parsed.pathname).toBe("/api/v1/holos/agent_tunnel/bind/start")
    expect(parsed.searchParams.get("local_callback")).toBe("http://127.0.0.1:19836/holos/login")
    expect(parsed.searchParams.get("state")).toBe("state-123")

    const custom = new URL(
      SynergyLinkHolosLogin.createBindURL({
        callbackURL: "http://cb",
        state: "s",
        portalUrl: "https://portal.example.test",
      }),
    )
    expect(custom.origin).toBe("https://portal.example.test")
  })

  test("readAgentSecretInput reads stdin and files alike", async () => {
    const root = await createRoot()
    const secretPath = path.join(root, "secret")
    await writeFile(secretPath, "file-secret\n", { mode: 0o600 })
    expect(await SynergyLinkHolosLogin.readAgentSecretInput(secretPath)).toBe("file-secret")
  })

  test("prompt helpers return null without a tty", async () => {
    await expect(SynergyLinkHolosLogin.promptForExistingCredentials()).resolves.toBeNull()
    await expect(SynergyLinkHolosLogin.promptLoginMode()).resolves.toBeNull()
  })
})
