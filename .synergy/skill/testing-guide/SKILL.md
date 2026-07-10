---
name: testing-guide
description: "Guide for writing tests in the Synergy codebase using TDD. Covers test philosophy, patterns, fixtures, mock strategies, and commands. Use when writing new tests, fixing bugs, or adding features. Triggers: 'test', 'testing', 'TDD', 'write test', 'test pattern', 'how to test', 'bun test', 'fixture', 'coverage'."
---

# Testing Guide for Synergy

## Test Philosophy

1. **Test behavioral contracts, not implementation details** — A good test passes after a refactor that preserves behavior. If you rewrote the code differently, the test should still pass.

2. **Write the test first (TDD)** — The test captures what "correct" means before implementation biases you. For bug fixes: write the failing test, then fix. For new features: write the test, then implement. Pure refactoring (no behavior change) is the only exemption.

3. **Avoid source-text assertions** — Don't grep source code in tests. Call the function and check the result. The `workspace-contract.test.ts` exception is marked TEMPORARY.

4. **Minimize mocking** — Synergy has no mock framework. Prefer real instances + temp directory isolation + context overrides. Don't add jest/vitest mock imports.

## Framework and Configuration

**Framework**: Bun's built-in test runner. All tests import from `"bun:test"`.

**Config**: `packages/synergy/bunfig.toml`

```toml
[test]
preload = ["./test/preload.ts"]
timeout = 10000
```

**Preload** (`test/preload.ts`) — runs before every test file, provides:

- Temp PID-isolated test home directory (`SYNERGY_TEST_HOME`)
- Model catalog seeded from pinned fixture (`test/tool/fixtures/models-api.json`)
- Network disabled (all provider API keys cleared, fetch disabled)
- Logging initialized silently at DEBUG level
- Cleanup in `afterAll` with retry logic

## Test Commands

```bash
cd packages/synergy

bun test                                # All tests
bun test test/tool/read.test.ts         # Single file
bun test --watch                        # Watch mode
bun run test:changed                    # Only changed vs origin/dev
bun run test:coverage                   # Full suite + LCOV coverage (30s timeout)
bun run test:profile                    # JUnit timing profile

# From repo root
bun turbo test                          # All package tests
bun run quality:quick                   # Fast: format + lint + typecheck + monorepo + package (no tests)
bun run quality                         # Full: quality:quick + all tests
```

## Eight Test Patterns (simplest → most complex)

When writing a test, pick the simplest pattern that covers the behavior.

### A. Pure Function Unit Test (`test/util/path.test.ts`)

**Zero dependencies. Zero context.**

```ts
import { describe, expect, test } from "bun:test"
import { getFilename } from "../../src/util/path"

describe("getFilename", () => {
  test("returns filename from Unix absolute path", () => {
    expect(getFilename("/home/user/file.txt")).toBe("file.txt")
  })
  test("returns empty string for root", () => {
    expect(getFilename("/")).toBe("")
  })
})
```

**Use for**: Pure data transforms, utility functions, validation logic.

### B. Classifier/Mapping Test (`test/tool/taxonomy.test.ts`)

**One function call, one assertion.**

```ts
import { describe, expect, test } from "bun:test"
import { ToolTaxonomy } from "../../src/tool/taxonomy"

describe("ToolTaxonomy.classify", () => {
  test("classifies render tool", () => {
    const result = ToolTaxonomy.classify("render")
    expect(result.kind).toBe("display")
  })
})
```

**Use for**: Classification, mapping, simple business logic.

### C. Tool Test with Temp Directory (`test/tool/read.test.ts`)

**Real tool code, isolated filesystem, minimal context injection.**

```ts
import { describe, expect, test } from "bun:test"
import { tmpdir } from "@/test/fixture/fixture"
import { ScopeContext } from "@/scope"

describe("ReadTool", () => {
  test("reads a file", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide(tmp.path, async () => {
      // Write test files
      await Bun.write(`${tmp.path}/hello.txt`, "hello world")

      // Build a test context (no mocking framework)
      const ctx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: "test-agent",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async (_req: any) => {}, // capture or silently allow
      }

      const result = await ReadTool.init({}).then((t) => t.execute({ filePath: "hello.txt" }, ctx as any))
      expect(result.output).toContain("hello world")
    })
  })
})
```

**Use for**: Tools, file operations, scope-aware features.

### D. Full Session Integration (`test/session/session.test.ts`)

**Real session lifecycle, real storage.**

```ts
import { describe, expect, test } from "bun:test"
import { tmpdir } from "@/test/fixture/fixture"
import { ScopeContext } from "@/scope"
import { Session } from "@/session"

describe("Session lifecycle", () => {
  test("creates and retrieves a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide(tmp.path, async () => {
      const session = await Session.create({ title: "test session" })
      const found = await Session.get(session.id)
      expect(found?.title).toBe("test session")
      await Session.remove(session.id)
    })
  })
})
```

**Use for**: Session, permission, workflow features needing real state.

### E. Structural Registry Test (`test/migration/registry.test.ts`)

**Side-effect import then assert invariants.**

```ts
import { describe, expect, test } from "bun:test"
import "../../src/migration" // registers all migrations

describe("Migration registry", () => {
  test("has expected domains", () => {
    const domains = MigrationRegistry.domains()
    expect(domains.length).toBeGreaterThanOrEqual(9)
  })
  test("all migrations have unique IDs", () => {
    const ids = MigrationRegistry.all().map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

**Use for**: Registry completeness, structural contracts, invariants across many items.

### F. Storage Atomic Test (`test/storage/storage.test.ts`)

**Random key prefix isolation + direct file reads.**

```ts
import { describe, expect, test } from "bun:test"
import { Storage } from "@/storage/storage"

describe("Storage", () => {
  test("atomic write survives crash", async () => {
    const key = ["storage-test", Math.random().toString(36).slice(2)]
    await Storage.write(key, { value: 42 })
    // Verify by reading the raw file
    const raw = await Bun.file(`${Storage.root()}/${key.join("/")}.json`).json()
    expect(raw.value).toBe(42)
  })
})
```

**Use for**: Storage, persistence, atomicity guarantees.

### G. Process Management Test (`test/tool/bash.test.ts`)

**beforeEach/afterEach state reset + scoped env vars.**

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test"

describe("BashTool", () => {
  let originalShell: string | undefined
  beforeEach(() => {
    originalShell = process.env.SHELL
    Shell.preferred.reset()
  })
  afterEach(() => {
    process.env.SHELL = originalShell ?? ""
    Shell.preferred.reset()
  })

  test("executes a command", async () => {
    // ...
  })
})
```

**Use for**: Shell execution, process management, env-sensitive features.

### H. Pure Data Transform (`test/session/message-v2.test.ts`)

**No external dependencies — inline object construction only.**

```ts
import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

describe("MessageV2.toModelMessage", () => {
  test("converts user message", () => {
    const msg = MessageV2.User({ content: "hello" })
    const modelMsg = MessageV2.toModelMessage(msg)
    expect(modelMsg.role).toBe("user")
    expect(modelMsg.content).toBe("hello")
  })
})
```

**Use for**: Serialization, deserialization, protocol transforms, data mapping.

## Fixture: `tmpdir()`

```ts
import { tmpdir } from "@/test/fixture/fixture"

// Basic — isolated directory + git init
await using tmp = await tmpdir({ git: true })
await ScopeContext.provide(tmp.path, async () => {
  // tmp.path is a real directory with .git/ initialized
})

// With custom init
await using tmp = await tmpdir({
  git: true,
  init: async (dir) => {
    await Bun.write(`${dir}/config.json`, '{"key": "value"}')
  },
})

// With config fragment
await using tmp = await tmpdir({
  config: { general: { logLevel: "DEBUG" } },
})
```

`tmpdir()` returns an `AsyncDisposable` — cleanup on scope exit is deferred to `afterAll` (global cleanup) because session references may outlive individual tests.

## Mock Strategy: What NOT to Do

**Never do this**:

- ❌ `vi.mock("./module")`
- ❌ `jest.mock("./module")`
- ❌ `mock("./module")`
- ❌ Mock Storage (use real temp directory)
- ❌ Mock Session (use `Session.create()`)
- ❌ Mock the filesystem (use `tmpdir()`)

**Always do this**:

- ✅ `await using tmp = await tmpdir()` for file system isolation
- ✅ Override `ctx.ask` to capture or simulate permission requests
- ✅ Override `process.env` in `beforeEach` / restore in `afterEach`
- ✅ Use `SYNERGY_TEST_HOME` (set by preload.ts)
- ✅ Trust preload.ts network disabling (all API keys cleared)

## Quality Gate

Before committing:

```bash
bun run quality:quick    # format:check + lint + typecheck + monorepo:check + package:check
cd packages/synergy && bun test test/<domain>/<file>.test.ts  # narrow test first
cd packages/synergy && bun test   # then full suite
```

The pre-push hook runs format, lint, typecheck, and monorepo checks — but NOT tests. Full test suite runs in CI via `bun turbo test`.
