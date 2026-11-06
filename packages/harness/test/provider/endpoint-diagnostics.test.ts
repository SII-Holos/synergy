import { describe, expect, test } from "bun:test"
import {
  getProviderEndpointChecks,
  parseProviderRoutes,
  providerEndpointChecks,
  providerEndpoints,
  type ProviderEndpointOverrides,
} from "../../src/provider/endpoint-diagnostics"

const ROUTING = "provider-endpoint-routing"
const TLS = "provider-endpoint-tls"

const CLEAN_ROUTES = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.3.1        UGScg                 en0
127                127.0.0.1          UCS                   lo0
192.168.3          link#15            UCS                   en0`

const LINUX_CLEAN_ROUTES = `default via 192.168.1.1 dev eth0 proto dhcp metric 100
192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.20`

const HALF_DEFAULT_ROUTES = `Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.3.1        UGScg                 en0
0.0.0.0/1          utun98             USc                utun98
128.0.0.0/1        utun98             USc                utun98
198.18.0/16        utun98             USc                utun98`

const TUN_DEFAULT_ROUTES = `Internet:
Destination        Gateway            Flags               Netif Expire
default            link#20            UGScg                 utun3
1                  utun3              USc                   utun3
192.168.3          link#15            UCS                   en0`

const IPV6_ONLY_TUNNEL_ROUTES = `Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.3.1        UGScg                 en0
192.168.3          link#15            UCS                   en0

Internet6:
Destination                             Gateway                         Flags               Netif Expire
default                                 fe80::%utun0                    UGcIg               utun0
default                                 fe80::%utun3                    UGcIg               utun3`

// Bun's bundled BoringSSL reports a handshake it cannot map to a reason code using this
// exact fallback string with no error code attached.
const OPAQUE_VERIFICATION_ERROR = new Error("unknown certificate verification error")

function overrides(input: Partial<ProviderEndpointOverrides> = {}): ProviderEndpointOverrides {
  return {
    timeoutMs: 50,
    resolve: async () => ["93.184.216.34"],
    readRoutes: async () => CLEAN_ROUTES,
    connectTls: async () => ({ address: "93.184.216.34", issuer: "DigiCert TLS RSA SHA256 2020 CA1" }),
    ...input,
  }
}

const endpoint = (url: string, providerID = "fixture") => [{ providerID, url }]

async function routing(overridesInput: Partial<ProviderEndpointOverrides>, url = "https://api.example.test/v1") {
  const checks = await providerEndpointChecks({ endpoints: endpoint(url), overrides: overrides(overridesInput) })
  return checks.find((check) => check.id === ROUTING)!
}

async function tls(overridesInput: Partial<ProviderEndpointOverrides>, url = "https://api.example.test/v1") {
  const checks = await providerEndpointChecks({ endpoints: endpoint(url), overrides: overrides(overridesInput) })
  return checks.find((check) => check.id === TLS)!
}

describe("provider endpoints", () => {
  test("collects one entry per distinct endpoint and prefers the provider base URL", () => {
    expect(
      providerEndpoints({
        alpha: {
          options: { baseURL: "https://alpha.example.test/v1" },
          models: {
            one: { api: { url: "https://alpha.example.test/v1" } },
            two: { api: { url: "https://alpha.example.test/v1" } },
          },
        },
        beta: { models: { three: { api: { url: "https://beta.example.test/v1" } } } },
      }),
    ).toEqual([
      { providerID: "alpha", url: "https://alpha.example.test/v1" },
      { providerID: "beta", url: "https://beta.example.test/v1" },
    ])
  })

  test("reports a warning instead of throwing when no endpoint is configured", async () => {
    const checks = await providerEndpointChecks({ endpoints: [] })
    expect(checks.map((check) => check.status)).toEqual(["warn", "warn"])
    expect(checks.map((check) => check.id)).toEqual([ROUTING, TLS])
  })
})

describe("provider endpoint routing", () => {
  test("warns when an endpoint resolves into the RFC 2544 fake-IP range", async () => {
    const check = await routing({ resolve: async () => ["198.18.0.33"] })
    expect(check).toMatchObject({ id: ROUTING, label: "Provider endpoint routing", status: "warn" })
    expect(check.detail).toContain("198.18.0.33")
    expect(check.detail).toContain("fake-IP")
  })

  test("warns for every address in the 198.18.0.0/15 block", async () => {
    for (const address of ["198.18.0.1", "198.19.255.254"]) {
      const check = await routing({ resolve: async () => [address] })
      expect(check.status).toBe("warn")
    }
  })

  test("warns when an endpoint resolves into the reserved 240.0.0.0/4 range", async () => {
    const check = await routing({ resolve: async () => ["240.0.0.7"] })
    expect(check.status).toBe("warn")
    expect(check.detail).toContain("240.0.0.0/4")
  })

  test("warns when half-default routes are installed", async () => {
    const check = await routing({ readRoutes: async () => HALF_DEFAULT_ROUTES })
    expect(check.status).toBe("warn")
    expect(check.detail).toContain("0.0.0.0/1")
    expect(check.detail).toContain("128.0.0.0/1")
  })

  test("warns when the default route is bound to a tunnel device", async () => {
    const check = await routing({ readRoutes: async () => TUN_DEFAULT_ROUTES })
    expect(check.status).toBe("warn")
    expect(check.detail).toContain("utun3")
  })

  test("warns on a single 128.0.0.0/1 half-default route", async () => {
    const check = await routing({
      readRoutes: async () => `default 192.168.3.1 UGScg en0\n128.0.0.0/1 utun98 USc utun98`,
    })
    expect(check.status).toBe("warn")
    expect(check.detail).toContain("128.0.0.0/1")
  })

  test("warns when the resolver throws or times out and never throws itself", async () => {
    const thrown = await routing({
      resolve: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
      },
    })
    expect(thrown).toMatchObject({ id: ROUTING, status: "warn" })
    expect(thrown.detail).toContain("ENOTFOUND")

    const timedOut = await routing({ resolve: () => new Promise<string[]>(() => {}) })
    expect(timedOut.status).toBe("warn")
    expect(timedOut.detail).toContain("timed out")
  })

  test("warns when the route table cannot be read", async () => {
    const check = await routing({
      readRoutes: async () => {
        throw new Error("netstat is unavailable")
      },
    })
    expect(check.status).toBe("warn")
    expect(check.detail).toContain("route table could not be read")
  })

  test("passes for a normal public endpoint", async () => {
    const check = await routing({})
    expect(check).toMatchObject({ id: ROUTING, label: "Provider endpoint routing", status: "pass" })
    expect(check.detail).toContain("no half-default or tunnel-bound default route")
  })

  test("does not flag a Tailscale 100.64.0.0/10 address", async () => {
    const check = await routing({ resolve: async () => ["100.64.2.5"] })
    expect(check.status).toBe("pass")
    expect(check.detail).not.toContain("100.64")
  })

  test("does not flag IPv6-only tunnel defaults from unrelated VPN frameworks", async () => {
    const check = await routing({ readRoutes: async () => IPV6_ONLY_TUNNEL_ROUTES })
    expect(check.status).toBe("pass")
  })

  test("parses Linux ip route output without a family header", async () => {
    expect(parseProviderRoutes(LINUX_CLEAN_ROUTES)).toEqual({ halfDefaultRoutes: [], defaultDevice: undefined })
    expect(
      parseProviderRoutes(`default dev tun0 scope link
0.0.0.0/1 via 10.8.0.1 dev tun0
128.0.0.0/1 via 10.8.0.1 dev tun0`),
    ).toEqual({ halfDefaultRoutes: ["0.0.0.0/1", "128.0.0.0/1"], defaultDevice: "tun0" })
  })

  test("parses the mihomo-style macOS cascade that only installs 128.0.0.0/1", async () => {
    expect(
      parseProviderRoutes(`Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.3.1        UGScg                 en0
1                  utun98             USc                utun98
2/7                utun98             USc                utun98
4/6                utun98             USc                utun98
16/4               utun98             USc                utun98
127                127.0.0.1          UCS                   lo0
128.0/1            utun98             USc                utun98
198.18.0/16        utun98             USc                utun98`),
    ).toEqual({ halfDefaultRoutes: ["128.0.0.0/1"], defaultDevice: undefined })
  })

  test("parses Windows netstat destinations with a separate netmask column", async () => {
    expect(
      parseProviderRoutes(`IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.10     25
          0.0.0.0        128.0.0.0        10.8.0.2       10.8.0.5      5
        128.0.0.0        128.0.0.0        10.8.0.2       10.8.0.5      5`),
    ).toEqual({ halfDefaultRoutes: ["0.0.0.0/1", "128.0.0.0/1"], defaultDevice: undefined })
  })
})

describe("provider endpoint TLS", () => {
  test("fails when certificate verification is rejected without a reason code", async () => {
    const check = await tls({
      connectTls: async () => {
        throw OPAQUE_VERIFICATION_ERROR
      },
    })
    expect(check).toMatchObject({ id: TLS, label: "Provider endpoint TLS", status: "fail" })
    expect(check.detail).toContain("TLS verification failed")
    expect(check.detail).toContain("does not trust intercepted certificates")
  })

  test("fails on a self-signed interception certificate", async () => {
    const check = await tls({
      connectTls: async () => {
        throw Object.assign(new Error("self signed certificate in certificate chain"), {
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        })
      },
    })
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("SELF_SIGNED_CERT_IN_CHAIN")
  })

  test("passes and neutrally reports the issuer and resolved address", async () => {
    const check = await tls({})
    expect(check).toMatchObject({ id: TLS, label: "Provider endpoint TLS", status: "pass" })
    expect(check.detail).toContain("DigiCert TLS RSA SHA256 2020 CA1")
    expect(check.detail).toContain("93.184.216.34")
  })

  test("warns instead of failing when the handshake cannot complete", async () => {
    const check = await tls({
      connectTls: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(check.status).toBe("warn")
    expect(check.detail).toContain("ECONNREFUSED")
  })

  test("warns when the handshake times out", async () => {
    const check = await tls({ connectTls: () => new Promise(() => {}) })
    expect(check.status).toBe("warn")
    expect(check.detail).toContain("timed out")
  })

  test("warns when no configured endpoint uses HTTPS", async () => {
    const check = await tls({}, "http://127.0.0.1:1/v1")
    expect(check.status).toBe("warn")
    expect(check.detail).toContain("No configured provider endpoint uses HTTPS")
  })
})

describe("provider endpoint diagnostics entry point", () => {
  test("degrades to warnings instead of throwing when providers cannot be read", async () => {
    const checks = await getProviderEndpointChecks({
      listProviders: async () => {
        throw new Error("config domain is unreadable")
      },
    })
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      [ROUTING, "warn"],
      [TLS, "warn"],
    ])
    expect(checks[0].detail).toContain("config domain is unreadable")
  })

  test("warns instead of hanging when reading providers exceeds the bound", async () => {
    const checks = await getProviderEndpointChecks({
      providerTimeoutMs: 30,
      listProviders: () => new Promise(() => {}),
    })
    expect(checks.map((check) => check.status)).toEqual(["warn", "warn"])
    expect(checks[0].detail).toContain("timed out")
  })
})
