import { test, expect } from "bun:test"
import { resolveRuntimeMode } from "../../src/plugin-runtime/mode-resolver.js"
import type { PluginSource, RuntimeMode } from "../../src/plugin-runtime/mode-resolver.js"

// ---------------------------------------------------------------------------
// Helper: creates default input for a given source, overriding specific fields
// ---------------------------------------------------------------------------

function opts(overrides: {
  source: PluginSource
  manifestMode?: "in-process" | "worker" | "process"
  devMode?: boolean
  userTrusted?: boolean
  risk?: "low" | "medium" | "high"
  forceProcess?: boolean
}) {
  return {
    source: overrides.source,
    manifestMode: overrides.manifestMode,
    devMode: overrides.devMode ?? false,
    userTrusted: overrides.userTrusted ?? false,
    risk: overrides.risk ?? "low",
    forceProcess: overrides.forceProcess ?? false,
  }
}

// ===========================================================================
// Rule 1: builtin → in-process
// ===========================================================================

test("builtin plugin defaults to in-process", () => {
  expect(resolveRuntimeMode(opts({ source: "builtin" }))).toBe("in-process")
})

test("builtin plugin with low risk stays in-process", () => {
  expect(resolveRuntimeMode(opts({ source: "builtin", risk: "low" }))).toBe("in-process")
})

test("builtin plugin with medium risk stays in-process", () => {
  expect(resolveRuntimeMode(opts({ source: "builtin", risk: "medium" }))).toBe("in-process")
})

// ===========================================================================
// Rule 2: local + dev → in-process
// ===========================================================================

test("local plugin in dev mode defaults to in-process", () => {
  expect(resolveRuntimeMode(opts({ source: "local", devMode: true }))).toBe("in-process")
})

test("local dev plugin with user trust stays in-process", () => {
  expect(resolveRuntimeMode(opts({ source: "local", devMode: true, userTrusted: true }))).toBe("in-process")
})

// ===========================================================================
// Rule 3: local + forceProcess → process
// ===========================================================================

test("local plugin with forceProcess flag runs in process", () => {
  expect(resolveRuntimeMode(opts({ source: "local", devMode: true, forceProcess: true }))).toBe("process")
})

// ===========================================================================
// Rule 4: npm → process
// ===========================================================================

test("npm plugin defaults to process", () => {
  expect(resolveRuntimeMode(opts({ source: "npm" }))).toBe("process")
})

test("npm plugin with user trust but no verified integrity defaults to process", () => {
  expect(resolveRuntimeMode(opts({ source: "npm", userTrusted: true }))).toBe("process")
})

// ===========================================================================
// Rule 5: git → process
// ===========================================================================

test("git plugin defaults to process", () => {
  expect(resolveRuntimeMode(opts({ source: "git" }))).toBe("process")
})

test("git plugin with user trust stays in process (not enough for worker)", () => {
  expect(resolveRuntimeMode(opts({ source: "git", userTrusted: true }))).toBe("process")
})

// ===========================================================================
// Rule 6: url → process
// ===========================================================================

test("url plugin always runs in process", () => {
  expect(resolveRuntimeMode(opts({ source: "url" }))).toBe("process")
})

test("url plugin with trust still runs in process", () => {
  expect(resolveRuntimeMode(opts({ source: "url", userTrusted: true }))).toBe("process")
})

// ===========================================================================
// Rule 7: high-risk → process (safety override)
// ===========================================================================

test("high-risk builtin plugin is forced to process", () => {
  expect(resolveRuntimeMode(opts({ source: "builtin", risk: "high" }))).toBe("process")
})

test("high-risk local dev plugin is forced to process", () => {
  expect(resolveRuntimeMode(opts({ source: "local", devMode: true, risk: "high" }))).toBe("process")
})

test("high-risk npm plugin stays process", () => {
  expect(resolveRuntimeMode(opts({ source: "npm", risk: "high" }))).toBe("process")
})

// ===========================================================================
// Rule 8: manifest-mode = "process" → process
// ===========================================================================

test("manifest requests process, honored", () => {
  expect(resolveRuntimeMode(opts({ source: "local", devMode: true, manifestMode: "process" }))).toBe("process")
})

test("manifest process + builtin uses process", () => {
  expect(resolveRuntimeMode(opts({ source: "builtin", manifestMode: "process" }))).toBe("process")
})

// ===========================================================================
// Rule 9: manifest-mode = "worker" + userTrusted → worker
// ===========================================================================

test("manifest worker with user trust results in worker mode", () => {
  expect(
    resolveRuntimeMode(
      opts({
        source: "local",
        devMode: true,
        manifestMode: "worker",
        userTrusted: true,
      }),
    ),
  ).toBe("worker")
})

test("manifest worker without user trust falls back to process", () => {
  expect(
    resolveRuntimeMode(
      opts({
        source: "npm",
        manifestMode: "worker",
        userTrusted: false,
      }),
    ),
  ).toBe("process")
})

// ===========================================================================
// Rule 10: manifest-mode = "in-process" + third-party → process (forced)
// ===========================================================================

test("third-party npm plugin requesting in-process is forced to process", () => {
  expect(resolveRuntimeMode(opts({ source: "npm", manifestMode: "in-process" }))).toBe("process")
})

test("third-party git plugin requesting in-process is forced to process", () => {
  expect(resolveRuntimeMode(opts({ source: "git", manifestMode: "in-process" }))).toBe("process")
})

test("third-party url plugin requesting in-process is forced to process", () => {
  expect(resolveRuntimeMode(opts({ source: "url", manifestMode: "in-process" }))).toBe("process")
})

test("builtin plugin requesting in-process is allowed (not third-party)", () => {
  expect(resolveRuntimeMode(opts({ source: "builtin", manifestMode: "in-process" }))).toBe("in-process")
})

test("local dev plugin requesting in-process is allowed (not third-party)", () => {
  expect(
    resolveRuntimeMode(
      opts({
        source: "local",
        devMode: true,
        manifestMode: "in-process",
      }),
    ),
  ).toBe("in-process")
})

// ===========================================================================
// Edge cases: official source
// ===========================================================================

test("official plugin defaults to in-process", () => {
  expect(resolveRuntimeMode(opts({ source: "official" }))).toBe("in-process")
})

test("official plugin with high risk is forced to process", () => {
  expect(resolveRuntimeMode(opts({ source: "official", risk: "high" }))).toBe("process")
})

// ===========================================================================
// Edge case: risk trumps all
// ===========================================================================

test("high risk trumps builtin + in-process manifest", () => {
  expect(
    resolveRuntimeMode(
      opts({
        source: "builtin",
        risk: "high",
        manifestMode: "in-process",
      }),
    ),
  ).toBe("process")
})

test("high risk trumps worker + trusted", () => {
  expect(
    resolveRuntimeMode(
      opts({
        source: "local",
        devMode: true,
        risk: "high",
        manifestMode: "worker",
        userTrusted: true,
      }),
    ),
  ).toBe("process")
})
