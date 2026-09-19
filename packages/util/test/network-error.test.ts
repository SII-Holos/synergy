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

// Provenance: https://github.com/oven-sh/bun/issues/11821
// Bun's bundled BoringSSL emits this fallback string when it cannot map a verification failure to a reason code.
test("treats an unmapped certificate verification failure as indeterminate", () => {
  expect(classifyNetworkError(new Error("unknown certificate verification error"))).toMatchObject({
    kind: "indeterminate",
    category: "tls-verification",
  })
  expect(classifyNetworkError("Error: unknown certificate verification error")).toMatchObject({
    kind: "indeterminate",
    category: "tls-verification",
  })
})

test("keeps an unmapped certificate verification failure visible through a fetch wrapper", () => {
  const wrapped = new TypeError("fetch failed", {
    cause: new Error("unknown certificate verification error"),
  })
  expect(classifyNetworkError(wrapped)).toMatchObject({ kind: "indeterminate", category: "tls-verification" })
})

test.each([
  "certificate verification failed",
  "certificate verify failed",
  "certificate has expired",
  "self signed certificate",
  "unable to verify the first certificate",
])("keeps the known certificate wording %s terminal", (message) => {
  expect(classifyNetworkError(new Error(message))?.kind).toBe("permanent")
})

test.each([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
])("keeps the mapped certificate code %s terminal", (code) => {
  expect(classifyNetworkError(Object.assign(new Error("verification failed"), { code }))?.kind).toBe("permanent")
})

test("a permanent certificate code outranks an unmapped sibling failure", () => {
  const error = new TypeError("fetch failed", {
    cause: new AggregateError([
      new Error("unknown certificate verification error"),
      Object.assign(new Error("expired"), { code: "CERT_HAS_EXPIRED" }),
    ]),
  })
  expect(classifyNetworkError(error)).toMatchObject({ kind: "permanent", code: "CERT_HAS_EXPIRED" })
})

test("does not infer an unmapped verification failure without certificate wording", () => {
  expect(classifyNetworkError(new Error("invalid TLS configuration"))).toBeUndefined()
  expect(classifyNetworkError(new Error("verification code rejected"))).toBeUndefined()
})
