import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pruneSeedPayload } from "../../../script/release/shared/seed-payload"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-seed-payload-"))
  directories.push(directory)
  const library = "node_modules/@ericsanchezok/synergy-library/dist"
  const required = [
    `${library}/vector/packaged-embedding.js`,
    `${library}/lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs`,
    `${library}/lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm`,
  ]
  const removed = [
    "node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/libonnxruntime.so.1",
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll",
    "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    "node_modules/@ericsanchezok/synergy-library/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm",
    "node_modules/library/dist/index.js.map",
    "node_modules/library/.npmignore",
  ]
  const retained = [
    ...required,
    "node_modules/onnxruntime-node/package.json",
    "node_modules/onnxruntime-node/LICENSE",
    "node_modules/onnxruntime-node/bin/napi-v6/LICENSE.txt",
    "node_modules/onnxruntime-web/dist/ort.wasm.min.mjs",
    "node_modules/onnxruntime-web/types.d.ts",
    "node_modules/other/dist/runtime.wasm",
    "node_modules/other/data/world.map",
    "node_modules/library/dist/index.js",
  ]
  for (const file of [...removed, ...retained]) await Bun.write(path.join(directory, file), file)
  return { directory, required, removed, retained }
}

test("sealed full seeds retain the bundled embedding backend and omit unused dependency binaries", async () => {
  const run = await fixture()
  await pruneSeedPayload(run.directory)
  for (const file of run.removed) expect(await Bun.file(path.join(run.directory, file)).exists(), file).toBe(false)
  for (const file of run.retained) expect(await Bun.file(path.join(run.directory, file)).text()).toBe(file)
  await pruneSeedPayload(run.directory)
  for (const file of run.retained) expect(await Bun.file(path.join(run.directory, file)).text()).toBe(file)
})

test("missing bundled embedding assets fail before any dependency payload is removed", async () => {
  const run = await fixture()
  await fs.rm(path.join(run.directory, run.required[2]!))
  await expect(pruneSeedPayload(run.directory)).rejects.toThrow("bundled embedding")
  for (const file of run.removed) expect(await Bun.file(path.join(run.directory, file)).text()).toBe(file)
})

test.each([
  ["@ast-grep/cli-win32-x64-msvc", ".exe"],
  ["@ast-grep/cli-darwin-arm64", ""],
  ["owner/node_modules/@ast-grep/cli-linux-x64-gnu", ""],
])("full seeds keep the canonical ast-grep executable from %s", async (dependency, extension) => {
  const run = await fixture()
  const directory = path.join(run.directory, "node_modules", dependency)
  const canonical = path.join(directory, `ast-grep${extension}`)
  const alias = path.join(directory, `sg${extension}`)
  await Bun.write(canonical, "canonical executable")
  await fs.chmod(canonical, 0o755)
  await Bun.write(alias, "duplicate CLI executable")
  const unrelated = path.join(run.directory, "node_modules/other/sg.exe")
  await Bun.write(unrelated, "unrelated executable")
  await pruneSeedPayload(run.directory)
  expect(await Bun.file(canonical).text()).toBe("canonical executable")
  expect((await fs.stat(canonical)).mode & 0o111).toBe(0o111)
  expect(await Bun.file(alias).exists()).toBe(false)
  expect(await Bun.file(unrelated).text()).toBe("unrelated executable")
})

test("a missing canonical ast-grep executable fails without removing its alias", async () => {
  const run = await fixture()
  const alias = path.join(run.directory, "node_modules/@ast-grep/cli-win32-x64-msvc/sg.exe")
  await Bun.write(alias, "only executable")
  await expect(pruneSeedPayload(run.directory)).rejects.toThrow("canonical ast-grep executable")
  expect(await Bun.file(alias).text()).toBe("only executable")
  for (const file of run.removed) expect(await Bun.file(path.join(run.directory, file)).exists()).toBe(true)
})

test.each(["glibc", "musl"] as const)("Linux seeds retain only %s-compatible optional packages", async (libc) => {
  const run = await fixture()
  await Bun.write(path.join(run.directory, "node_modules/onnxruntime-node/package.json"), "{}")
  for (const item of ["glibc", "musl"])
    await Bun.write(
      path.join(run.directory, `node_modules/@native/backend-${item}/package.json`),
      JSON.stringify({ name: `@native/backend-${item}`, libc: [item] }),
    )
  await Bun.write(
    path.join(run.directory, "node_modules/owner/node_modules/negative/package.json"),
    JSON.stringify({ name: "negative", libc: ["!musl"] }),
  )
  await pruneSeedPayload(run.directory, { os: "linux", arch: "arm64", ...(libc === "musl" ? { abi: libc } : {}) })
  for (const item of ["glibc", "musl"])
    expect(await Bun.file(path.join(run.directory, `node_modules/@native/backend-${item}/package.json`)).exists()).toBe(
      item === libc,
    )
  expect(
    await Bun.file(path.join(run.directory, "node_modules/owner/node_modules/negative/package.json")).exists(),
  ).toBe(libc === "glibc")
})
