import { describe, expect, test } from "bun:test"
import { ObservabilityRedaction } from "../../src/observability/redaction"

describe("ObservabilityRedaction", () => {
  test("redacts sensitive keys, bearer/query secrets, and standalone token formats", () => {
    const record = ObservabilityRedaction.record({
      token: "plain-secret",
      password: "pw",
      authorization: "Bearer abc.def",
      url: "/callback?token=secret&ok=true",
      message: "Bearer top.secret sk-live-secret ghp_exampletoken xoxb-123456789 tok_runtime_secret key_runtime_secret",
      openaiKey: "sk-object-secret",
      accessKey: "key-object-secret",
      privateKey: "ghp_objectsecret",
      credential: "tok_object_secret",
    })

    expect(record.token).toBe("[redacted]")
    expect(record.password).toBe("[redacted]")
    expect(record.authorization).toBe("[redacted]")
    expect(record.openaiKey).toBe("[redacted]")
    expect(record.accessKey).toBe("[redacted]")
    expect(record.privateKey).toBe("[redacted]")
    expect(record.credential).toBe("[redacted]")
    expect(record.url).toBe("/callback?token=[redacted]&ok=true")
    expect(record.message).toBe("Bearer [redacted] [redacted] [redacted] [redacted] [redacted] [redacted]")
    expect(JSON.stringify(record)).not.toContain("plain-secret")
    expect(JSON.stringify(record)).not.toContain("top.secret")
    expect(JSON.stringify(record)).not.toContain("sk-live-secret")
    expect(JSON.stringify(record)).not.toContain("ghp_exampletoken")
    expect(JSON.stringify(record)).not.toContain("xoxb-123456789")
  })

  test("summarizes commands and omits argv-like values", () => {
    const value = ObservabilityRedaction.value({
      command: "curl -H 'X-Test-Header: sk-test-placeholder' https://example.test",
      args: ["--token", "ghp_secret"],
      stack: "at /private/path/file.ts:1",
    }).value

    expect(value).toEqual({
      command: { family: "curl", length: 65 },
      args: "[omitted]",
      stack: "[redacted]",
    })
    expect(JSON.stringify(value)).not.toContain("sk-test-placeholder")
    expect(JSON.stringify(value)).not.toContain("ghp_secret")
    expect(JSON.stringify(value)).not.toContain("/private/path")
  })
  test("handles circular, deep, and nested values as flat labels", () => {
    const circular: Record<string, unknown> = { name: "root" }
    circular.self = circular
    const record = ObservabilityRedaction.record({ circular, nested: { value: "safe" } })

    expect(typeof record.circular).toBe("string")
    expect(record.circular).toContain("[circular]")
    expect(record.nested).toBe('{"value":"safe"}')
  })

  test("does not expose Error stack traces", () => {
    const error = new Error("failed with token=secret")
    const value = ObservabilityRedaction.value(error).value

    expect(value).toEqual({ name: "Error", message: "failed with token=[redacted]" })
    expect(JSON.stringify(value)).not.toContain("stack")
  })
})

test("redacts Authorization=Bearer tokens before lookbehind consumes Bearer prefix", () => {
  const text = (s: string) => ObservabilityRedaction.text(s)
  // The Bearer regex must run before the lookbehind to prevent token leak
  expect(text("Authorization=Bearer xyz123abc")).not.toContain("xyz123")
  expect(text("authorization=Bearer my-token-here")).not.toContain("my-token-here")
  expect(text("Auth=Bearer generic-jwt-token")).not.toContain("generic-jwt-token")
  // sk-like tokens still caught by standalone patterns after Bearer redaction
  expect(text("Auth=Bearer sk-123-problem")).not.toContain("sk-123-problem")
  expect(text("Auth=Bearer tok_test_value_here")).not.toContain("tok_test_value_here")
})

test("detects _key and _secret suffixed field names as sensitive", () => {
  expect(ObservabilityRedaction.isSensitiveKey("session_key")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("signing_key")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("master_key")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("encryption_key")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("hmac_key")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("client_secret")).toBe(true)
  // Still catches existing patterns
  expect(ObservabilityRedaction.isSensitiveKey("token")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("my_password")).toBe(true)
  // Does not false-positive on normal words ending in 'key'
  expect(ObservabilityRedaction.isSensitiveKey("monkey")).toBe(false)
  expect(ObservabilityRedaction.isSensitiveKey("api_key")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("auth")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("bearer")).toBe(true)
  // Body/headers/content broad keys only match as word boundaries
  expect(ObservabilityRedaction.isSensitiveKey("request_body")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("body_param")).toBe(true)
  expect(ObservabilityRedaction.isSensitiveKey("somebody")).toBe(false)
  expect(ObservabilityRedaction.isSensitiveKey("nobody")).toBe(false)
  expect(ObservabilityRedaction.isSensitiveKey("discontent")).toBe(false)
  expect(ObservabilityRedaction.isSensitiveKey("envelope")).toBe(false)
})

test("cwdScope returns abbreviated path not raw full path", () => {
  expect(ObservabilityRedaction.cwdScope(undefined)).toBe("unknown")
  expect(ObservabilityRedaction.cwdScope("")).toBe("unknown")
  const result = ObservabilityRedaction.cwdScope("/Users/yzxoi/synergy")
  expect(result).not.toBe("configured")
  expect(result).not.toBe("unknown")
  expect(result).not.toContain("/Users/")
  expect(result.length).toBeLessThanOrEqual(128)
})

test("redacts auth and bearer key values directly", () => {
  const record = ObservabilityRedaction.record({
    auth: "my-auth-token-value",
    bearer: "my-bearer-token-value",
  })
  expect(record.auth).toBe("[redacted]")
  expect(record.bearer).toBe("[redacted]")
})

test("routePath redacts github_pat_ and key_ segments", () => {
  expect(ObservabilityRedaction.routePath("/user/github_pat_asdf1234/repos")).toBe("/user/[redacted]/repos")
  expect(ObservabilityRedaction.routePath("/token/key_dangerous")).toBe("/token/[redacted]")
  expect(ObservabilityRedaction.routePath("/safe/path")).toBe("/safe/path")
})
