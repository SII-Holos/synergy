import fs from "node:fs/promises"
import path from "node:path"
import { NativePty } from "../src/process/native-pty"

const owner = path.resolve(import.meta.dir, "..")
type Target = { os?: string; arch?: string; libc?: string }

async function run(args: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(args, { cwd, env, stdout: "inherit", stderr: "inherit" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 600_000)
  try {
    if ((await child.exited) !== 0) throw new Error(`Native PTY build failed: ${args[0]}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function buildPty(options: Target = {}) {
  const os = options.os === "windows" ? "win32" : (options.os ?? process.platform)
  const arch = options.arch ?? process.arch
  const libc = options.libc ?? "glibc"
  if (
    !["linux", "darwin", "win32"].includes(os) ||
    !["x64", "arm64"].includes(arch) ||
    !["glibc", "musl"].includes(libc)
  )
    throw new Error("Unsupported native PTY target")
  const target = `${os}-${arch}${os === "linux" ? `-${libc}` : ""}`
  const crate = path.join(owner, "src/process/native-pty")
  const destination = path.join(owner, ".artifacts/pty", target)
  const filename = NativePty.filename(os)
  const hash = new Bun.CryptoHasher("sha256").update(target).update(await Bun.file(import.meta.filename).bytes())
  for (const name of ["Cargo.toml", "Cargo.lock", "src/lib.rs"])
    hash.update(await Bun.file(path.join(crate, name)).bytes())
  const identity = hash.digest("hex")
  const output = path.join(destination, filename)
  const receipt = await Bun.file(path.join(destination, "receipt.json"))
    .json()
    .catch(() => undefined)
  if (
    receipt?.identity === identity &&
    (await Bun.file(output).exists()) &&
    new Bun.CryptoHasher("sha256").update(await Bun.file(output).bytes()).digest("hex") === receipt.sha256
  )
    return output
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const stage = await fs.mkdtemp(path.join(path.dirname(destination), ".building-"))
  try {
    await fs.cp(crate, stage, { recursive: true, filter: (entry) => path.basename(entry) !== "target" })
    let source: string
    if (os === "linux" && (process.platform !== "linux" || arch !== process.arch || libc === "musl")) {
      const image = libc === "musl" ? "rust:1.94.0-alpine3.23" : "rust:1.94.0-bookworm"
      await run(
        [
          "docker",
          "run",
          "--rm",
          "--cidfile",
          path.join(stage, "container.id"),
          "--platform",
          `linux/${arch === "x64" ? "amd64" : "arm64"}`,
          "-v",
          `${stage}:/build`,
          "-w",
          "/build",
          "-e",
          "RUSTFLAGS=-C target-feature=-crt-static",
          image,
          "cargo",
          "build",
          "--locked",
          "--release",
        ],
        stage,
      )
      source = path.join(stage, "target/release", filename)
    } else {
      if (os !== process.platform) throw new Error(`Native PTY target ${os} needs a matching build host`)
      const triple = `${arch === "x64" ? "x86_64" : "aarch64"}-${os === "darwin" ? "apple-darwin" : os === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu"}`
      if (arch !== process.arch) await run(["rustup", "target", "add", triple], stage)
      await run(["cargo", "build", "--locked", "--release", "--target", triple], stage)
      source = path.join(stage, "target", triple, "release", filename)
    }
    const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(source).bytes()).digest("hex")
    await fs.mkdir(destination, { recursive: true })
    const staged = path.join(stage, filename)
    await fs.copyFile(source, staged)
    await fs.rename(staged, output)
    await Bun.write(path.join(stage, "receipt.json"), JSON.stringify({ version: 1, identity, target, sha256 }))
    await fs.rename(path.join(stage, "receipt.json"), path.join(destination, "receipt.json"))
    return output
  } finally {
    const cid = await Bun.file(path.join(stage, "container.id"))
      .text()
      .catch(() => undefined)
    if (cid && /^[a-f0-9]{64}$/.test(cid.trim())) {
      const child = Bun.spawn(["docker", "rm", "-f", cid.trim()], { stdout: "ignore", stderr: "ignore" })
      await child.exited
    }
    await fs.rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) console.log(await buildPty())
