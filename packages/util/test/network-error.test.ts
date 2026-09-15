import { expect, test } from "bun:test"
import { classifyNetworkError } from "../src/network-error"

test.each([
  "getaddrinfo ETIMEOUT api.deepseek.com",
  "TypeError: getaddrinfo ETIMEOUT other.example",
  "connect ECONNREFUSED 127.0.0.1",
])("recognizes transport codes retained only in messages: %s", (message) => {
  expect(classifyNetworkError(new TypeError(message))?.kind).toBe("transient")
})
test("does not infer network failures from unrelated timeout or TLS text", () => {
  for (const message of [
    "tool execution timeout",
    "invalid TLS configuration",
    "Cannot read properties of undefined",
    "Unexpected end of JSON input",
  ]) {
    expect(classifyNetworkError(new Error(message))).toBeUndefined()
  }
})
test("preserves permanent causes in mixed IPv4 and IPv6 failures", () => {
  const error = new TypeError("fetch failed", {
    cause: new AggregateError([
      { code: "ETIMEDOUT", message: "timeout" },
      { code: "CERT_HAS_EXPIRED", message: "expired" },
    ]),
  })
  expect(classifyNetworkError(error)).toMatchObject({ kind: "permanent", code: "CERT_HAS_EXPIRED" })
})
test("bounds cyclic and oversized error graphs", () => {
  const cyclic = Object.assign(new Error("unknown"), { cause: undefined as unknown })
  cyclic.cause = cyclic
  expect(classifyNetworkError(cyclic)).toBeUndefined()
  const errors = Array.from({ length: 100 }, () => ({ code: "ECONNRESET", message: "lost" }))
  expect(classifyNetworkError(new AggregateError(errors))?.kind).toBe("permanent")
})
