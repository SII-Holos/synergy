import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { ComputerBuildProgress } from "../../script/prepare-computer-progress"
import { checkComputerDriverCache, downloadComputerSource } from "../../script/prepare-computer"

const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

function observe() {
  let now = 0
  const lines: string[] = []
  const timers = new Set<() => void>()
  const progress = new ComputerBuildProgress({
    write: (line) => lines.push(line),
    now: () => now,
    schedule(tick) {
      timers.add(tick)
      return () => timers.delete(tick)
    },
  })
  return {
    progress,
    lines,
    timers,
    advance(milliseconds: number) {
      now += milliseconds
      for (const tick of timers) tick()
    },
  }
}

test("a pending phase is visible immediately and reports elapsed time every five seconds", async () => {
  const observed = observe()
  const release = Promise.withResolvers<void>()
  const pending = observed.progress.step("Building arm64", () => release.promise)
  expect(observed.lines).toEqual(["[computer] Building arm64 · elapsed 0s\n"])
  observed.advance(4_999)
  expect(observed.lines).toHaveLength(1)
  observed.advance(1)
  expect(observed.lines.at(-1)).toBe("[computer] Building arm64 · elapsed 5s\n")
  release.resolve()
  await pending
  expect(observed.lines.at(-1)).toBe("[computer] Building arm64 complete · elapsed 5s\n")
  expect(observed.timers.size).toBe(0)
  observed.advance(5_000)
  expect(observed.lines).toHaveLength(3)
})

test("phase failures preserve the original error and release their progress timer", async () => {
  const observed = observe()
  const original = new Error("compiler exited with code 7")
  await expect(
    observed.progress.step("Building x86_64", async () => {
      observed.advance(6_000)
      throw original
    }),
  ).rejects.toBe(original)
  expect(observed.lines.at(-1)).toContain("Building x86_64 failed · elapsed 6s · compiler exited with code 7")
  expect(observed.timers.size).toBe(0)
  const count = observed.lines.length
  observed.advance(5_000)
  expect(observed.lines).toHaveLength(count)
})

test("download reports use received bytes, interval speed and a known total", async () => {
  const observed = observe()
  const release = Promise.withResolvers<void>()
  const pending = observed.progress.step("Downloading source", () => release.promise)
  observed.progress.download(1024 * 1024, 4 * 1024 * 1024)
  observed.advance(5_000)
  expect(observed.lines.at(-1)).toContain("1.0 / 4.0 MiB · 25% · 0.2 MiB/s · elapsed 5s")
  observed.advance(5_000)
  expect(observed.lines.at(-1)).toContain("25% · 0.0 MiB/s · elapsed 10s")
  observed.progress.download(2 * 1024 * 1024, 4 * 1024 * 1024)
  observed.advance(5_000)
  expect(observed.lines.at(-1)).toContain("50% · 0.2 MiB/s · elapsed 15s")
  release.resolve()
  await pending
})

test("unknown or inconsistent download totals never produce a percentage", async () => {
  const observed = observe()
  const release = Promise.withResolvers<void>()
  const pending = observed.progress.step("Downloading source", () => release.promise)
  observed.progress.download(1024 * 1024)
  observed.advance(5_000)
  expect(observed.lines.at(-1)).toContain("1.0 MiB · 0.2 MiB/s")
  expect(observed.lines.at(-1)).not.toContain("%")
  observed.progress.download(2 * 1024 * 1024, 1024 * 1024)
  observed.advance(5_000)
  expect(observed.lines.at(-1)).not.toContain("%")
  release.resolve()
  await pending
})

test("sequential phases reset elapsed time and readiness reports total elapsed time", async () => {
  const observed = observe()
  await observed.progress.step("Building arm64", async () => observed.advance(7_000))
  await observed.progress.step("Building x86_64", async () => observed.advance(8_000))
  observed.progress.ready()
  expect(observed.lines).toContain("[computer] Building x86_64 · elapsed 0s\n")
  expect(observed.lines.at(-1)).toBe("[computer] Driver ready · total 15s\n")
  expect(observed.lines.every((line) => line.endsWith("\n") && !line.includes("\r") && !line.includes("\x1b"))).toBe(
    true,
  )
})

async function withSource(
  handler: (request: Request) => Response | Promise<Response>,
  run: (archive: string, url: string) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-computer-source-"))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  try {
    await run(path.join(directory, "source.tar.gz"), server.url.href)
  } finally {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}

test("a delayed HTTP response still emits download status before receiving headers", async () => {
  const observed = observe()
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const bytes = new Uint8Array(1024 * 1024).fill(7)
  await withSource(
    async () => {
      requested.resolve()
      await release.promise
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } })
    },
    async (archive, url) => {
      const pending = downloadComputerSource({
        archive,
        url,
        sha256: digest(bytes),
        maxBytes: bytes.length,
        progress: observed.progress,
      })
      try {
        expect(observed.lines[0]).toContain("Downloading source")
        await requested.promise
        observed.advance(5_000)
        expect(observed.lines.at(-1)).toContain("elapsed 5s")
        release.resolve()
        await pending
        expect(new Uint8Array(await Bun.file(archive).arrayBuffer())).toEqual(bytes)
        expect(observed.lines.some((line) => line.includes("100%"))).toBe(true)
        expect(observed.lines.at(-1)).toContain("Verifying source complete")
        expect(observed.timers.size).toBe(0)
      } finally {
        release.resolve()
        await pending.catch(() => undefined)
      }
    },
  )
})

test("a chunked HTTP response displays received bytes without guessing its total", async () => {
  const observed = observe()
  const bytes = new Uint8Array(1024 * 1024).fill(5)
  await withSource(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
      ),
    async (archive, url) => {
      await downloadComputerSource({
        archive,
        url,
        sha256: digest(bytes),
        maxBytes: bytes.length,
        progress: observed.progress,
      })
      expect(observed.lines.join("")).toContain("1.0 MiB")
      expect(observed.lines.join("")).not.toContain("%")
      expect(observed.timers.size).toBe(0)
    },
  )
})

test("encoded HTTP bodies do not use their compressed length as a download percentage", async () => {
  const observed = observe()
  const bytes = new Uint8Array(1024 * 1024).fill(9)
  const encoded = gzipSync(bytes)
  await withSource(
    () => new Response(encoded, { headers: { "content-encoding": "gzip", "content-length": String(encoded.length) } }),
    async (archive, url) => {
      await downloadComputerSource({
        archive,
        url,
        sha256: digest(bytes),
        maxBytes: bytes.length,
        progress: observed.progress,
      })
      expect(observed.lines.join("")).toContain("1.0 MiB")
      expect(observed.lines.join("")).not.toContain("%")
    },
  )
})

test("an aborted download releases progress and does not proceed to source verification", async () => {
  const observed = observe()
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  await withSource(
    async () => {
      requested.resolve()
      await release.promise
      return new Response("fixture")
    },
    async (archive, url) => {
      const pending = downloadComputerSource({
        archive,
        url,
        sha256: digest("fixture"),
        maxBytes: 1024,
        progress: observed.progress,
        signal: controller.signal,
      })
      try {
        await requested.promise
        observed.advance(5_000)
        controller.abort()
        await expect(pending).rejects.toThrow()
        expect(observed.lines.join("")).toContain("Downloading source failed")
        expect(observed.lines.join("")).not.toContain("Verifying source")
        expect(observed.timers.size).toBe(0)
      } finally {
        release.resolve()
        await pending.catch(() => undefined)
      }
    },
  )
})

for (const failure of ["http", "limit", "checksum"] as const) {
  test(`a source ${failure} failure identifies its phase without announcing readiness`, async () => {
    const observed = observe()
    const bytes = new Uint8Array(1024).fill(3)
    await withSource(
      () => new Response(bytes, { status: failure === "http" ? 502 : 200 }),
      async (archive, url) => {
        await expect(
          downloadComputerSource({
            archive,
            url,
            sha256: failure === "checksum" ? "0".repeat(64) : digest(bytes),
            maxBytes: failure === "limit" ? 1 : bytes.length,
            progress: observed.progress,
          }),
        ).rejects.toThrow(failure === "http" ? "502" : failure === "limit" ? "size limit" : "checksum mismatch")
        expect(observed.lines.join("")).toContain(
          `${failure === "checksum" ? "Verifying" : "Downloading"} source failed`,
        )
        expect(observed.lines.join("")).not.toContain("Driver ready")
        expect(observed.timers.size).toBe(0)
      },
    )
  })
}

for (const state of ["valid", "missing-receipt", "recipe", "missing-binary", "digest"] as const) {
  test(`driver cache ${state} is verified against actual receipt and executable bytes`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-computer-cache-"))
    const observed = observe()
    const executable = path.join(directory, "cua-driver")
    const receiptFile = path.join(directory, "receipt.json")
    try {
      if (state !== "missing-binary") await Bun.write(executable, "cached native fixture")
      if (state !== "missing-receipt")
        await Bun.write(
          receiptFile,
          JSON.stringify({
            version: 1,
            recipe: state === "recipe" ? "previous" : "current",
            sha256: state === "digest" ? "0".repeat(64) : digest("cached native fixture"),
            architecture: "universal",
            source: "pinned",
            rust: "pinned",
          }),
        )
      expect(
        await checkComputerDriverCache({ executable, receiptFile, recipe: "current", progress: observed.progress }),
      ).toBe(state === "valid")
      const reason = {
        valid: "cache verified",
        "missing-receipt": "No valid build receipt",
        recipe: "Build inputs changed",
        "missing-binary": "Cached driver is missing",
        digest: "Cached driver checksum mismatch",
      }[state]
      expect(observed.lines.join("")).toContain(reason)
      expect(observed.timers.size).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
