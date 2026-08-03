import { describe, expect, test } from "bun:test"
import { SynergyLinkHolosClient } from "../src/holos/client"
import { SynergyLinkHolosLogin } from "../src/holos/login"

describe("SynergyLinkHolos endpoint URL construction", () => {
  const prefixed = {
    apiUrl: "https://holos.example.test/base",
    wsUrl: "wss://holos.example.test/tunnel",
    portalUrl: "https://portal.example.test/portal",
  }

  test("keeps the configured ws base prefix on websocket routes", () => {
    expect(SynergyLinkHolosClient.websocketEndpoint("secret-token", prefixed)).toBe(
      "wss://holos.example.test/tunnel/api/v1/holos/agent_tunnel/ws?token=secret-token",
    )
    expect(SynergyLinkHolosClient.sanitizedWebsocketEndpoint(prefixed)).toBe(
      "wss://holos.example.test/tunnel/api/v1/holos/agent_tunnel/ws",
    )
  })

  test("keeps the configured portal base prefix on bind routes", () => {
    expect(
      SynergyLinkHolosLogin.createBindURL({
        callbackURL: "http://127.0.0.1:20000/holos/login",
        state: "state-1",
        portalUrl: prefixed.portalUrl,
      }),
    ).toBe(
      "https://portal.example.test/portal/api/v1/holos/agent_tunnel/bind/start?local_callback=http%3A%2F%2F127.0.0.1%3A20000%2Fholos%2Flogin&state=state-1",
    )
  })

  test("root endpoints without a base prefix keep the default /api routes", () => {
    const root = {
      apiUrl: "https://holos.example.test",
      wsUrl: "wss://holos.example.test",
      portalUrl: "https://portal.example.test",
    }
    expect(SynergyLinkHolosClient.websocketEndpoint("secret-token", root)).toBe(
      "wss://holos.example.test/api/v1/holos/agent_tunnel/ws?token=secret-token",
    )
    expect(
      SynergyLinkHolosLogin.createBindURL({
        callbackURL: "http://127.0.0.1:20000/holos/login",
        state: "state-1",
        portalUrl: root.portalUrl,
      }),
    ).toBe(
      "https://portal.example.test/api/v1/holos/agent_tunnel/bind/start?local_callback=http%3A%2F%2F127.0.0.1%3A20000%2Fholos%2Flogin&state=state-1",
    )
  })

  test("accepts bases with or without a trailing slash", () => {
    expect(
      SynergyLinkHolosClient.sanitizedWebsocketEndpoint({ ...prefixed, wsUrl: "wss://holos.example.test/tunnel/" }),
    ).toBe("wss://holos.example.test/tunnel/api/v1/holos/agent_tunnel/ws")
  })
})
