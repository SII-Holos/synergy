import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_SESSION_MEMORY_COMPARE_LIMITS,
  compareSessionMemoryResults,
  parseCompareArguments,
} from "../../script/session-memory-runtime-compare"

const METRICS = {
  rssBytes: 1_048_576,
  processTreeRssBytes: 2_097_152,
  descendantRssBytes: 524_288,
  heapUsedBytes: 262_144,
  externalBytes: 131_072,
  arrayBuffersBytes: 65_536,
}

const CHECKPOINTS = [
  "run-1-after-delete",
  "run-5-after-delete",
  "release-plus-5s",
  "release-plus-30s",
  "release-plus-120s",
]

function result(mutate?: (label: string, delta: typeof METRICS) => void, patch: Record<string, unknown> = {}) {
  return {
    harness: "synergy-session-runtime-memory",
    scenario: "sequential",
    workload: { contractVersion: 3, fingerprint: "same-workload" },
    samples: [
      { label: "periodic", phase: "sequential-primary" },
      ...CHECKPOINTS.map((label) => {
        const delta = { ...METRICS }
        mutate?.(label, delta)
        return { label, deltaFromIdle: delta }
      }),
    ],
    ...patch,
  }
}

describe("session memory runtime compare", () => {
  test("rejects limits that cannot provide a finite non-negative byte allowance", () => {
    for (const limit of [Infinity, NaN, -1]) {
      expect(() => compareSessionMemoryResults(result(), result(), { rssBytes: limit })).toThrow("finite")
    }
    expect(() => parseCompareArguments(["--max-rss-mib", "9".repeat(400)])).toThrow("finite")
  })

  test("documents the default byte allowances", () => {
    expect(DEFAULT_SESSION_MEMORY_COMPARE_LIMITS).toEqual({
      rssBytes: 64 * 1024 * 1024,
      processTreeRssBytes: 96 * 1024 * 1024,
      descendantRssBytes: 64 * 1024 * 1024,
      heapUsedBytes: 32 * 1024 * 1024,
      externalBytes: 32 * 1024 * 1024,
      arrayBuffersBytes: 16 * 1024 * 1024,
    })
  })

  test("passes when the final deletion and idle samples stay within the default limits", () => {
    const candidate = result((label, delta) => {
      if (label === "run-5-after-delete") delta.rssBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.rssBytes
      if (label === "release-plus-120s") delta.heapUsedBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.heapUsedBytes
    })
    const report = compareSessionMemoryResults(result(), candidate)
    expect(report.ok).toBe(true)
    expect(report.blocked).toBeUndefined()
    expect(report.checks.every((check) => check.pass)).toBe(true)
  })

  test("ignores growth on earlier deletion checkpoints", () => {
    const candidate = result((label, delta) => {
      if (label === "run-1-after-delete") delta.rssBytes += 512 * 1024 * 1024
    })
    const report = compareSessionMemoryResults(result(), candidate)
    expect(report.ok).toBe(true)
    expect(report.checks.filter((check) => check.checkpoint === "after-delete").map((check) => check.label)).toEqual([
      "run-5-after-delete",
      "run-5-after-delete",
      "run-5-after-delete",
      "run-5-after-delete",
      "run-5-after-delete",
      "run-5-after-delete",
    ])
  })

  test("fails when retained memory after the final deletion exceeds a limit", () => {
    const candidate = result((label, delta) => {
      if (label === "run-5-after-delete") delta.rssBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.rssBytes + 1
    })
    const report = compareSessionMemoryResults(result(), candidate)
    expect(report.ok).toBe(false)
    const failed = report.checks.filter((check) => !check.pass)
    expect(failed).toEqual([
      expect.objectContaining({
        checkpoint: "after-delete",
        label: "run-5-after-delete",
        metric: "rssBytes",
        deltaBytes: DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.rssBytes + 1,
      }),
    ])
  })

  test("fails when a 5, 30, or 120 second idle-relative sample exceeds its limit", () => {
    const candidate = result((label, delta) => {
      if (label === "release-plus-5s") {
        delta.rssBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.rssBytes + 1
        delta.processTreeRssBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.processTreeRssBytes + 1
        delta.descendantRssBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.descendantRssBytes + 1
        delta.heapUsedBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.heapUsedBytes + 1
        delta.externalBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.externalBytes + 1
        delta.arrayBuffersBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.arrayBuffersBytes + 1
      }
      if (label === "release-plus-30s") delta.externalBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.externalBytes + 1
      if (label === "release-plus-120s") delta.heapUsedBytes += DEFAULT_SESSION_MEMORY_COMPARE_LIMITS.heapUsedBytes + 1
    })
    const report = compareSessionMemoryResults(result(), candidate)
    expect(report.ok).toBe(false)
    expect(report.checks.filter((check) => !check.pass).map((check) => `${check.label}:${check.metric}`)).toEqual([
      "release-plus-5s:rssBytes",
      "release-plus-5s:processTreeRssBytes",
      "release-plus-5s:descendantRssBytes",
      "release-plus-5s:heapUsedBytes",
      "release-plus-5s:externalBytes",
      "release-plus-5s:arrayBuffersBytes",
      "release-plus-30s:externalBytes",
      "release-plus-120s:heapUsedBytes",
    ])
  })

  test("treats a lower candidate as an improvement", () => {
    const candidate = result((_label, delta) => {
      delta.rssBytes -= 4096
    })
    expect(compareSessionMemoryResults(result(), candidate).ok).toBe(true)
  })

  test("fails closed when the workload fingerprint differs", () => {
    const candidate = result(undefined, {
      workload: { contractVersion: 3, fingerprint: "other-workload" },
    })
    const report = compareSessionMemoryResults(result(), candidate)
    expect(report.ok).toBe(false)
    expect(report.checks).toEqual([])
    expect(report.blocked).toContain("fingerprint")
  })

  test("fails closed when a standard release sample is missing", () => {
    const candidate = result()
    candidate.samples = candidate.samples.filter((sample) => sample.label !== "release-plus-30s")
    const report = compareSessionMemoryResults(result(), candidate)
    expect(report.ok).toBe(false)
    expect(report.checks).toEqual([])
    expect(report.blocked).toBe("candidate omitted release-plus-30s")
  })

  test("rejects a non-sequential scenario before comparing samples", () => {
    const report = compareSessionMemoryResults(result(), result(undefined, { scenario: "parallel" }))
    expect(report.ok).toBe(false)
    expect(report.checks).toEqual([])
    expect(report.blocked).toContain("sequential")
  })

  test("selects the sequential scenario from a runtime suite", () => {
    const sequential = result()
    const suite = {
      harness: "synergy-session-runtime-memory-suite",
      scenarios: [result(undefined, { scenario: "parallel" }), sequential],
    }
    expect(compareSessionMemoryResults(suite, sequential).ok).toBe(true)
  })

  test("accepts a per-metric limit above the default", () => {
    const candidate = result((label, delta) => {
      if (label === "run-5-after-delete") delta.rssBytes += 80 * 1024 * 1024
    })
    expect(compareSessionMemoryResults(result(), candidate).ok).toBe(false)
    expect(compareSessionMemoryResults(result(), candidate, { rssBytes: 96 * 1024 * 1024 }).ok).toBe(true)
  })

  test("parses limit flags as mebibytes", () => {
    expect(
      parseCompareArguments(["--baseline", "base.json", "--candidate", "cand.json", "--max-heap-mib", "1.5"]),
    ).toEqual({
      baseline: "base.json",
      candidate: "cand.json",
      limits: { heapUsedBytes: Math.round(1.5 * 1024 * 1024) },
    })
    expect(() => parseCompareArguments(["--baseline", "base.json"])).toThrow("Usage:")
    expect(() => parseCompareArguments(["--max-rss-mib", "-4"])).toThrow("non-negative")
  })
})

describe("session memory runtime compare command", () => {
  test("exits non-zero and prints the failing checks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-memory-compare-"))
    try {
      const baseline = path.join(directory, "baseline.json")
      const candidate = path.join(directory, "candidate.json")
      await Bun.write(baseline, JSON.stringify(result()))
      await Bun.write(
        candidate,
        JSON.stringify(
          result((label, delta) => {
            if (label === "release-plus-120s") delta.heapUsedBytes += 64 * 1024 * 1024
          }),
        ),
      )
      const script = path.resolve(import.meta.dir, "../../script/session-memory-runtime-compare.ts")
      const failed = Bun.spawn([process.execPath, script, "--baseline", baseline, "--candidate", candidate], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const passed = Bun.spawn(
        [process.execPath, script, "--baseline", baseline, "--candidate", candidate, "--max-heap-mib", "64"],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [failedCode, failedOut, failedErr, passedCode, passedOut] = await Promise.all([
        failed.exited,
        new Response(failed.stdout).text(),
        new Response(failed.stderr).text(),
        passed.exited,
        new Response(passed.stdout).text(),
      ])
      expect(failedCode).toBe(1)
      expect(JSON.parse(failedOut).ok).toBe(false)
      expect(failedErr).toContain("release-plus-120s")
      expect(failedErr).toContain("heapUsedBytes")
      expect(passedCode).toBe(0)
      expect(JSON.parse(passedOut).ok).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
