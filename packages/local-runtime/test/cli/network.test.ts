import { expect, test } from "bun:test"
import { resolveServerNetwork } from "../../src/cli/network"

test.each([
  ["0.0.0.0", "http://127.0.0.1:4321"],
  ["::", "http://[::1]:4321"],
  ["2001:db8::1", "http://[2001:db8::1]:4321"],
])("shared server attachment resolves %s without changing its address family", async (hostname, url) => {
  const result = await resolveServerNetwork({ argv: [], config: { server: { hostname, port: 4321 } } })
  expect(result.url).toBe(url)
  expect(result.hostname).toBe(hostname)
})

test("shared server attachment honors explicit flags and the standard default", async () => {
  expect((await resolveServerNetwork({ argv: [], config: {} })).url).toBe("http://127.0.0.1:4096")
  const result = await resolveServerNetwork({
    argv: ["--hostname", "::", "--port", "5000"],
    config: { server: { hostname: "127.0.0.1", port: 4321 } },
  })
  expect(result.url).toBe("http://[::1]:5000")
})
