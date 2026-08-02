import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkCLIBackend } from "../src/cli-backend"
import { SynergyLinkCLIFormat } from "../src/cli/format"
import { SynergyLinkControlServer } from "../src/control/server"
import { SynergyLinkHolosAuth } from "../src/holos/auth"
import { SynergyLinkHolosClient } from "../src/holos/client"
import { SynergyLinkHolosLogin } from "../src/holos/login"
import { SynergyLinkStore } from "../src/state/store"

const originalLinkHome = process.env.SYNERGY_LINK_HOME
const originalSynergyHome = process.env.SYNERGY_TEST_HOME
const originalFetch = globalThis.fetch
const tempRoots: string[] = []

beforeEach(async () => {
  const linkRoot = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-hardening-link-"))
  const synergyHome = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-hardening-synergy-"))
  tempRoots.push(linkRoot, synergyHome)
  process.env.SYNERGY_LINK_HOME = linkRoot
  process.env.SYNERGY_TEST_HOME = synergyHome
  globalThis.fetch = originalFetch
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  if (originalLinkHome === undefined) delete process.env.SYNERGY_LINK_HOME
  else process.env.SYNERGY_LINK_HOME = originalLinkHome
  if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalSynergyHome
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link CLI hardening", () => {
  test("uses one configured Holos endpoint set for token and websocket traffic", async () => {
    const configPath = await SynergyLinkHolosAuth.globalConfigPath()
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        holos: {
          enabled: true,
          apiUrl: "https://holos.example.test/base/",
          wsUrl: "wss://holos.example.test/tunnel/",
          portalUrl: "https://portal.example.test/",
        },
      }),
    )

    const endpoints = await SynergyLinkHolosAuth.resolveEndpoints()
    expect(endpoints).toEqual({
      apiUrl: "https://holos.example.test/base",
      wsUrl: "wss://holos.example.test/tunnel",
      portalUrl: "https://portal.example.test",
    })
    expect(SynergyLinkHolosClient.websocketEndpoint("secret-token", endpoints)).toBe(
      "wss://holos.example.test/tunnel/api/v1/holos/agent_tunnel/ws?token=secret-token",
    )
    expect(SynergyLinkHolosClient.sanitizedWebsocketEndpoint(endpoints)).toBe(
      "wss://holos.example.test/tunnel/api/v1/holos/agent_tunnel/ws",
    )
    const doctor = await SynergyLinkCLIBackend.doctor()
    expect(doctor.checks.find((check) => check.name === "endpoints")).toEqual({
      name: "endpoints",
      ok: true,
      detail:
        "API https://holos.example.test/base; WebSocket wss://holos.example.test/tunnel; portal https://portal.example.test",
    })
  })

  test("keeps the configured API base prefix on token and identity requests", async () => {
    const configPath = await SynergyLinkHolosAuth.globalConfigPath()
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        holos: {
          enabled: true,
          apiUrl: "https://holos.example.test/base/",
          wsUrl: "wss://holos.example.test/tunnel/",
          portalUrl: "https://portal.example.test/",
        },
      }),
    )
    const calls: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/base/api/v1/holos/agent_tunnel/ws_token")) {
        return Response.json({ code: 0, data: { ws_token: "opaque-token", expires_in: 60 } })
      }
      if (url.endsWith("/base/api/v1/holos/agent_tunnel/me")) {
        return Response.json({ code: 0, data: { agent_id: "agent_matching", profile: {} } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    await expect(
      SynergyLinkHolosLogin.loginWithExistingCredentials({
        agentID: "agent_matching",
        agentSecret: "candidate-secret",
      }),
    ).resolves.toEqual({ agentID: "agent_matching" })

    expect(calls.some((url) => url.includes("/base/api/v1/holos/agent_tunnel/ws_token"))).toBe(true)
    expect(calls.some((url) => url.includes("/base/api/v1/holos/agent_tunnel/me"))).toBe(true)
  })

  test("prefers canonical Holos endpoints and only falls back when that file is absent", async () => {
    const legacyPath = await SynergyLinkHolosAuth.legacyGlobalConfigPath()
    await mkdir(path.dirname(legacyPath), { recursive: true })
    await writeFile(
      legacyPath,
      JSON.stringify({
        holos: {
          apiUrl: "https://legacy.example.test",
          wsUrl: "wss://legacy.example.test",
          portalUrl: "https://legacy-portal.example.test",
        },
      }),
    )

    await expect(SynergyLinkHolosAuth.resolveEndpoints()).resolves.toEqual({
      apiUrl: "https://legacy.example.test",
      wsUrl: "wss://legacy.example.test",
      portalUrl: "https://legacy-portal.example.test",
    })

    const canonicalPath = SynergyLinkHolosAuth.globalConfigPath()
    await mkdir(path.dirname(canonicalPath), { recursive: true })
    await writeFile(
      canonicalPath,
      `{
        // The package config fragment is authoritative when present.
        "holos": {
          "apiUrl": "https://canonical.example.test",
          "wsUrl": "wss://canonical.example.test",
          "portalUrl": "https://canonical-portal.example.test",
        },
      }`,
    )

    await expect(SynergyLinkHolosAuth.resolveEndpoints()).resolves.toEqual({
      apiUrl: "https://canonical.example.test",
      wsUrl: "wss://canonical.example.test",
      portalUrl: "https://canonical-portal.example.test",
    })

    await writeFile(canonicalPath, "{ invalid")
    await expect(SynergyLinkHolosAuth.resolveEndpoints()).rejects.toThrow("invalid JSONC")
  })

  test("rejects API and WebSocket endpoints from different Holos environments", async () => {
    const configPath = await SynergyLinkHolosAuth.globalConfigPath()
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        holos: {
          enabled: true,
          apiUrl: "https://api.environment-a.test",
          wsUrl: "wss://tunnel.environment-b.test",
          portalUrl: "https://portal.environment-a.test",
        },
      }),
    )

    await expect(SynergyLinkHolosAuth.resolveEndpoints()).rejects.toThrow(
      "Holos API and WebSocket endpoints must use the same host and port",
    )
  })

  test("fails closed on an explicitly invalid Holos endpoint without dispatching credentials", async () => {
    const configPath = await SynergyLinkHolosAuth.globalConfigPath()
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        holos: {
          enabled: true,
          apiUrl: "https//invalid.example.test",
          wsUrl: "wss://invalid.example.test",
        },
      }),
    )
    await SynergyLinkHolosAuth.save({ agentID: "agent_config_test", agentSecret: "private-config-test-secret" }).catch(
      () => undefined,
    )
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("must not dispatch")
    }) as typeof fetch

    await expect(SynergyLinkHolosAuth.resolveEndpoints()).rejects.toThrow("valid URL")
    const verification = await SynergyLinkHolosLogin.verifySecret("private-config-test-secret")
    expect(verification).toEqual({ valid: false, reason: "Holos credential verification failed." })
    const doctor = await SynergyLinkCLIBackend.doctor()
    expect(doctor.checks.find((check) => check.name === "holos_secret")).toEqual({
      name: "holos_secret",
      ok: false,
      detail: "Holos credential verification failed.",
    })
    expect(fetchCalled).toBe(false)
  })

  test("verifies the authenticated Agent ID before replacing stored credentials", async () => {
    await SynergyLinkHolosAuth.save({ agentID: "agent_previous", agentSecret: "previous-secret" })
    const calls: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/api/v1/holos/agent_tunnel/ws_token")) {
        return Response.json({ code: 0, data: { ws_token: "opaque-token", expires_in: 60 } })
      }
      if (url.endsWith("/api/v1/holos/agent_tunnel/me")) {
        return Response.json({ code: 0, data: { agent_id: "agent_actual", profile: {} } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    await expect(
      SynergyLinkHolosLogin.loginWithExistingCredentials({
        agentID: "agent_claimed",
        agentSecret: "candidate-secret",
      }),
    ).rejects.toThrow("belongs to agent_actual, not agent_claimed")

    expect(await SynergyLinkHolosAuth.load()).toEqual({
      agentID: "agent_previous",
      agentSecret: "previous-secret",
    })
    expect(calls.some((url) => url.endsWith("/ws_token"))).toBe(true)
    expect(calls.some((url) => url.endsWith("/me"))).toBe(true)
  })

  test("saves matching credentials and rejects identity verification failures without leaking secrets", async () => {
    const candidateSecret = "candidate-secret-must-stay-private"
    const candidateToken = "opaque-token-must-stay-private"
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith("/api/v1/holos/agent_tunnel/ws_token")) {
        return Response.json({ code: 0, data: { ws_token: candidateToken, expires_in: 60 } })
      }
      if (url.endsWith("/api/v1/holos/agent_tunnel/me")) {
        return Response.json({ code: 0, data: { agent_id: "agent_matching", profile: {} } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    await expect(
      SynergyLinkHolosLogin.loginWithExistingCredentials({
        agentID: "agent_matching",
        agentSecret: candidateSecret,
      }),
    ).resolves.toEqual({ agentID: "agent_matching" })
    expect(await SynergyLinkHolosAuth.load()).toEqual({
      agentID: "agent_matching",
      agentSecret: candidateSecret,
    })

    for (const failure of [
      new Response("not json", { status: 200 }),
      Response.json({ code: 0, data: { profile: {} } }),
      Response.json({ code: 0, data: { agent_id: 123, profile: {} } }),
    ]) {
      globalThis.fetch = (async (input) => {
        const url = String(input)
        if (url.endsWith("/api/v1/holos/agent_tunnel/ws_token")) {
          return Response.json({ code: 0, data: { ws_token: candidateToken, expires_in: 60 } })
        }
        return failure.clone()
      }) as typeof fetch

      let message = ""
      try {
        await SynergyLinkHolosLogin.loginWithExistingCredentials({
          agentID: "agent_rejected",
          agentSecret: candidateSecret,
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain("Credential validation failed")
      expect(message).not.toContain(candidateSecret)
      expect(message).not.toContain(candidateToken)
      expect(await SynergyLinkHolosAuth.load()).toEqual({
        agentID: "agent_matching",
        agentSecret: candidateSecret,
      })
    }

    globalThis.fetch = (async () => new Response("denied", { status: 401 })) as typeof fetch
    await expect(
      SynergyLinkHolosLogin.loginWithExistingCredentials({
        agentID: "agent_rejected",
        agentSecret: candidateSecret,
      }),
    ).rejects.toThrow("Holos rejected the credentials")
    expect(await SynergyLinkHolosAuth.load()).toEqual({
      agentID: "agent_matching",
      agentSecret: candidateSecret,
    })
  })

  test("treats local ownership as not applicable in standalone doctor mode", async () => {
    const state = await SynergyLinkStore.loadState()
    state.runtimeMode = "standalone"
    await SynergyLinkStore.saveState(state)

    const result = await SynergyLinkCLIBackend.doctor()
    expect(result.checks.find((check) => check.name === "local_owner")).toEqual({
      name: "local_owner",
      ok: true,
      detail: "Not applicable in standalone mode",
    })
    expect(result.ok).toBe(result.checks.every((check) => check.ok))
  })

  test("requires a live local owner lease only in managed doctor mode", async () => {
    const state = await SynergyLinkStore.loadState()
    state.runtimeMode = "managed"
    state.connectionStatus = "disconnected"
    state.service.pid = process.pid
    state.service.runtimeStatus = "running"
    state.ownerRegistry.local.ownerIDs = ["owner_test"]
    state.ownerRegistry.local.activeOwnerID = "owner_test"
    state.ownerRegistry.local.leaseExpiresAt = Date.now() + 60_000
    await SynergyLinkStore.saveState(state)

    const healthy = await SynergyLinkCLIBackend.doctor()
    expect(healthy.ok).toBe(true)
    expect(healthy.checks.find((check) => check.name === "local_owner")).toMatchObject({
      ok: true,
      detail: "owner_test",
    })

    state.ownerRegistry.local.activeOwnerID = undefined
    state.ownerRegistry.local.leaseExpiresAt = undefined
    await SynergyLinkStore.saveState(state)
    const missing = await SynergyLinkCLIBackend.doctor()
    expect(missing.ok).toBe(false)
    expect(missing.checks.find((check) => check.name === "local_owner")).toMatchObject({
      ok: false,
      detail: "No active managed owner lease",
    })

    state.ownerRegistry.local.activeOwnerID = "owner_test"
    state.ownerRegistry.local.leaseExpiresAt = Date.now() - 1
    await SynergyLinkStore.saveState(state)
    const expired = await SynergyLinkCLIBackend.doctor()
    expect(expired.ok).toBe(false)
    expect(expired.checks.find((check) => check.name === "local_owner")).toMatchObject({
      ok: false,
      detail: "Managed owner lease expired for owner_test",
    })
  })

  test("distinguishes live status from a last-known snapshot", async () => {
    const state = await SynergyLinkStore.loadState()
    state.service.pid = process.pid
    state.service.runtimeStatus = "running"
    state.connectionStatus = "connected"
    await SynergyLinkStore.saveState(state)

    const snapshot = await SynergyLinkCLIBackend.status()
    expect(snapshot.source).toBe("snapshot")
    expect(snapshot.stale).toBe(true)
    if (snapshot.source !== "snapshot") throw new Error("Expected snapshot status")
    expect(snapshot.capturedAt).toBeNumber()
    expect(snapshot.controlError).toBe("Control socket is unavailable or did not respond.")
    const snapshotOutput = SynergyLinkCLIFormat.human(snapshot)
    expect(snapshotOutput).toContain("Status source")
    expect(snapshotOutput).toContain("snapshot (last-known)")

    const livePayload = { marker: "runtime-status" }
    const server = new SynergyLinkControlServer(async (request) => {
      if (request.action === "runtime.status") return livePayload
      return { ok: true }
    })
    await server.start()
    try {
      const live = await SynergyLinkCLIBackend.status()
      expect(live).toMatchObject({ source: "live", stale: false, marker: "runtime-status" })
      if (live.source !== "live") throw new Error("Expected live status")
      expect(live.verifiedAt).toBeNumber()
    } finally {
      await server.stop()
    }
  })

  test("reports snapshot timestamp, age, control error, and stale PID reconciliation", async () => {
    const state = await SynergyLinkStore.loadState()
    state.service.pid = 2_147_483_647
    state.service.runtimeStatus = "running"
    state.service.startedAt = Date.now() - 60_000
    state.connectionStatus = "connected"
    await SynergyLinkStore.saveState(state)

    const snapshot = await SynergyLinkCLIBackend.status()
    expect(snapshot).toMatchObject({
      source: "snapshot",
      stale: true,
      controlError: "Control socket is unavailable or did not respond.",
    })
    if (snapshot.source !== "snapshot") throw new Error("Expected snapshot status")
    expect(snapshot.snapshotAt).toBeNumber()
    expect(snapshot.snapshotAgeMs).toBeGreaterThanOrEqual(0)
    expect(snapshot.service.running).toBe(false)
    expect(snapshot.service.pid).toBeUndefined()

    const output = SynergyLinkCLIFormat.human(snapshot)
    expect(output).toContain("Snapshot age")
    expect(output).toContain("Control error")
  })

  test("keeps the absolute control socket path out of degraded status output", async () => {
    const state = await SynergyLinkStore.loadState()
    state.service.pid = process.pid
    state.service.runtimeStatus = "running"
    state.connectionStatus = "connected"
    await SynergyLinkStore.saveState(state)

    const socketPath = SynergyLinkStore.controlSocketPath()
    const server = new SynergyLinkControlServer(async (request) => {
      if (request.action === "runtime.status") {
        throw new Error(`Timed out connecting to control socket at ${socketPath}`)
      }
      return { ok: true }
    })
    await server.start()
    try {
      const snapshot = await SynergyLinkCLIBackend.status()
      expect(snapshot).toMatchObject({
        source: "snapshot",
        stale: true,
        controlError:
          "The control socket accepted a ping but the live status request failed; the runtime may be restarting or shutting down.",
      })
      expect(JSON.stringify(snapshot)).not.toContain(socketPath)
      expect(SynergyLinkCLIFormat.human(snapshot)).not.toContain(socketPath)
    } finally {
      await server.stop()
    }
  })
})
