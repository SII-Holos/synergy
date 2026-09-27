import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
// Keep the production dependency loaded, as it is after other native suites in a coverage batch.
import "../../src/process/native-pty"

const owner = path.resolve(import.meta.dir, "../..")
const cases = [
  { name: "source glibc", platform: "linux", maps: "glibc", selected: "glibc", built: "glibc" },
  { name: "source musl", platform: "linux", maps: "musl", selected: "musl", built: "musl" },
  {
    name: "compiled glibc overrides musl host",
    platform: "linux",
    maps: "musl",
    override: "glibc",
    selected: "glibc",
    built: "glibc",
  },
  {
    name: "compiled musl overrides glibc host",
    platform: "linux",
    maps: "glibc",
    override: "musl",
    selected: "musl",
    built: "musl",
  },
  {
    name: "explicit glibc build on musl",
    platform: "linux",
    maps: "musl",
    selected: "musl",
    target: "glibc",
    built: "glibc",
  },
  {
    name: "explicit musl build on glibc",
    platform: "linux",
    maps: "glibc",
    selected: "glibc",
    target: "musl",
    built: "musl",
  },
  {
    name: "non-Linux defaults cross-build to glibc",
    platform: "darwin",
    maps: "musl",
    override: "musl",
    selected: "darwin",
    built: "glibc",
  },
] as const

for (const example of cases) {
  test(`native library build and loading select ${example.name}`, async () => {
    await using directory = await tmpdir()
    const compiler = Bun.spawn(
      [
        process.execPath,
        "build",
        "src/process/native-pty.ts",
        "script/build-pty.ts",
        "--root",
        owner,
        "--outdir",
        directory.path,
        "--entry-naming=[dir]/[name].js",
        "--target=bun",
        ...("override" in example ? ["--define", `SYNERGY_LIBC=${JSON.stringify(example.override)}`] : []),
      ],
      { cwd: owner, stdout: "pipe", stderr: "pipe" },
    )
    try {
      const [code, output, error] = await Promise.all([
        compiler.exited,
        new Response(compiler.stdout).text(),
        new Response(compiler.stderr).text(),
      ])
      expect(code, `${output}\n${error}`).toBe(0)
    } finally {
      if (compiler.exitCode === null) compiler.kill("SIGKILL")
      await compiler.exited
    }
    const names = ["Cargo.toml", "Cargo.lock", "src/lib.rs"]
    for (const name of names) {
      const target = path.join(directory.path, "src/process/native-pty", name)
      await Bun.write(target, await Bun.file(path.join(owner, "src/process/native-pty", name)).bytes())
    }
    const filename = (target: string) => (target === "darwin" ? "libsynergy_pty.dylib" : "libsynergy_pty.so")
    const asset = (target: string) =>
      path.join(
        directory.path,
        ".artifacts/pty",
        target === "darwin" ? `darwin-${process.arch}` : `linux-${process.arch}-${target}`,
        filename(target),
      )
    for (const abi of ["glibc", "musl", "darwin"]) {
      const output = asset(abi)
      const target = path.basename(path.dirname(output))
      const bytes = Buffer.from(`fixture for ${target}`)
      const hash = new Bun.CryptoHasher("sha256")
        .update(target)
        .update(await Bun.file(path.join(directory.path, "script/build-pty.js")).bytes())
      for (const name of names)
        hash.update(await Bun.file(path.join(directory.path, "src/process/native-pty", name)).bytes())
      await Bun.write(output, bytes)
      await Bun.write(
        path.join(path.dirname(output), "receipt.json"),
        JSON.stringify({
          version: 1,
          identity: hash.digest("hex"),
          target,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        }),
      )
    }
    const input = JSON.stringify({
      root: directory.path,
      platform: example.platform,
      maps: example.maps,
      target: "target" in example ? example.target : undefined,
    })
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/native-library.ts"), input], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = new Response(child.stdout).text()
    const error = new Response(child.stderr).text()
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(() => deadline.reject(new Error("Native library selection fixture timed out")), 4000)
    try {
      expect(await Promise.race([child.exited, deadline.promise]), await error).toBe(0)
      const actual = JSON.parse(await output)
      expect(actual.selected).toBe(asset(example.selected))
      expect(actual.built).toBe(asset(example.built))
      if ("override" in example || example.platform !== "linux") expect(actual.mapsReads).toBe(0)
      expect((await fs.readdir(path.join(directory.path, ".artifacts/pty"))).sort()).toEqual(
        [`darwin-${process.arch}`, `linux-${process.arch}-glibc`, `linux-${process.arch}-musl`].sort(),
      )
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }, 8000)
}
