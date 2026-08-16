import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  EMBEDDING_RUNTIME_REQUIRED_PATHS,
  stageEmbeddingRuntimeAssets,
  standaloneEmbeddingBuildPlugin,
} from "../../script/embedding-runtime-assets"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe("standalone embedding runtime", () => {
  test("stages the platform-independent ONNX runtime assets", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-embedding-runtime-assets-"))
    temporaryDirectories.push(runtimeDir)

    await stageEmbeddingRuntimeAssets({ runtimeDir })

    for (const relative of EMBEDDING_RUNTIME_REQUIRED_PATHS) {
      expect(await Bun.file(path.join(runtimeDir, relative)).exists()).toBe(true)
    }
  })

  test("loads transformers and initializes ONNX from a compiled artifact", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-embedding-standalone-"))
    temporaryDirectories.push(runtimeDir)
    const binary = path.join(runtimeDir, "bin", process.platform === "win32" ? "probe.exe" : "probe")
    await fs.mkdir(path.dirname(binary), { recursive: true })

    const output = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/embedding-standalone-entry.ts")],
      conditions: ["browser"],
      plugins: [standaloneEmbeddingBuildPlugin()],
      define: { SYNERGY_STANDALONE: "true" },
      compile: { outfile: binary },
    })
    expect(output.success, output.logs.map((log) => log.message).join("\n")).toBe(true)
    await stageEmbeddingRuntimeAssets({ runtimeDir })

    const proc = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(code, stderr).toBe(0)
    expect(stdout).toContain("standalone embedding runtime ready")
  }, 30_000)

  test("loads local model paths into buffers before reaching the WASM backend", async () => {
    // Regression: transformers.js runs in Node mode under Bun and passes local
    // model file paths to InferenceSession.create(). The WASM backend cannot
    // read disk paths and falls back to fetch(path), which Bun rejects with
    // "fetch() URL is invalid". The build plugin shim must convert paths to
    // buffers so the backend reaches ONNX protobuf parsing instead.
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-embedding-standalone-path-"))
    temporaryDirectories.push(runtimeDir)
    const binary = path.join(runtimeDir, "bin", process.platform === "win32" ? "probe.exe" : "probe")
    await fs.mkdir(path.dirname(binary), { recursive: true })

    const output = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/embedding-standalone-path-entry.ts")],
      conditions: ["browser"],
      plugins: [standaloneEmbeddingBuildPlugin()],
      define: { SYNERGY_STANDALONE: "true" },
      compile: { outfile: binary },
    })
    expect(output.success, output.logs.map((log) => log.message).join("\n")).toBe(true)
    await stageEmbeddingRuntimeAssets({ runtimeDir })

    const proc = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(code, stderr).toBe(0)
    expect(stdout).toContain("standalone embedding path shim ready")
  }, 30_000)

  test("serves local model files through fetch inside a compiled artifact", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-embedding-standalone-fetch-"))
    temporaryDirectories.push(runtimeDir)
    const binary = path.join(runtimeDir, "bin", process.platform === "win32" ? "probe.exe" : "probe")
    await fs.mkdir(path.dirname(binary), { recursive: true })
    const probeFile = path.join(runtimeDir, "model.onnx")
    await fs.writeFile(probeFile, "onnx-model-content")

    const output = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/embedding-local-file-entry.ts")],
      conditions: ["browser"],
      plugins: [standaloneEmbeddingBuildPlugin()],
      define: { SYNERGY_STANDALONE: "true" },
      compile: { outfile: binary },
    })
    expect(output.success, output.logs.map((log) => log.message).join("\n")).toBe(true)
    await stageEmbeddingRuntimeAssets({ runtimeDir })

    const proc = Bun.spawn([binary, probeFile], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(code, stderr).toBe(0)
    expect(stdout).toContain("standalone local file fetch ready")
  }, 30_000)
})
