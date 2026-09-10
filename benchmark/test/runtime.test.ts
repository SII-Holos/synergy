import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function inspect(runtime: string, config: Record<string, unknown> = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "synergy-bench-contract-"))
  try {
    const file = path.join(home, "config.json")
    await Bun.write(file, JSON.stringify(config))
    const child = Bun.spawn([process.execPath, "runtime/inspect.ts", runtime, file], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { PATH: process.env.PATH, SYNERGY_HOME: home, SYNERGY_CONFIG_CONTENT: "{}" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test("core rejects settings for unloaded capabilities", async () => {
  const result = await inspect("core", { library: { memory: { enabled: true } } })
  expect(result.code).toBe(2)
  expect(result.stderr).toContain("library")
})

test("custom recipes cannot import outside the frozen runtime", async () => {
  const result = await inspect("./../package.json")
  expect(result.code).toBe(2)
  expect(result.stderr).toContain("inside the frozen runtime")
})

test("missing custom recipes fail as invalid input", async () => {
  const result = await inspect("./missing-recipe.ts")
  expect(result.code).toBe(2)
  expect(result.stderr).toContain("composition file not found")
})

test("each named composition reports its own capabilities", async () => {
  for (const runtime of ["core", "core-library", "full"]) {
    const result = await inspect(runtime)
    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!)
    expect(report.runtime).toBe(runtime)
    expect(report.configKeys.includes("library")).toBe(runtime !== "core")
    expect(report.configKeys.includes("mcp")).toBe(runtime === "full")
  }
}, 30_000)

test("offline preflight rejects an unavailable measured model before inference", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synergy-bench-model-"))
  try {
    const config = path.join(home, "config.json")
    await Bun.write(config, "{}")
    const child = Bun.spawn([process.execPath, "runtime/inspect.ts", "core", config, "", "missing/model", "synergy"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH,
        SYNERGY_HOME: home,
        SYNERGY_CONFIG: config,
        SYNERGY_CONFIG_CONTENT: "{}",
        SYNERGY_DISABLE_MODELS_FETCH: "1",
        MODELS_DEV_API_JSON: path.resolve(import.meta.dir, "../../packages/testing/fixtures/models-api.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, , stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(2)
    expect(stderr).toContain("ModelNotFoundError")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
