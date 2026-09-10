import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"

const owner = path.resolve(import.meta.dir, "..")
const require = createRequire(path.join(owner, "package.json"))
const PATCH = "parcel-2.5.6-eintr-1"
export const WATCHER_BUILD_IMAGE = "node:22.14.0-bullseye"
const sources = [
  "binding",
  "Watcher",
  "Backend",
  "DirTree",
  "Glob",
  "Debounce",
  "watchman/BSER",
  "watchman/WatchmanBackend",
  "shared/BruteForceBackend",
  "linux/InotifyBackend",
  "unix/legacy",
].map((name) => `src/${name}.cc`)

async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 600_000)
  try {
    if ((await child.exited) !== 0) throw new Error(`Watcher build command failed: ${args[0]}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function buildWatcher(options: { arch?: string; libc?: string; local?: boolean; headers?: string } = {}) {
  const arch = options.arch ?? process.arch
  const libc = options.libc ?? "glibc"
  if (!["x64", "arm64"].includes(arch) || !["glibc", "musl"].includes(libc))
    throw new Error("Unsupported watcher target")
  const source = path.dirname(require.resolve("@parcel/watcher/package.json"))
  if ((await Bun.file(path.join(source, "package.json")).json()).version !== "2.5.6")
    throw new Error("Watcher source must be pinned to 2.5.6")
  const upstream = await Bun.file(path.join(source, "src/linux/InotifyBackend.cc")).bytes()
  if (
    new Bun.CryptoHasher("sha256").update(upstream).digest("hex") !==
    "0e75ae33d24e7c6c1558dc7efb95a7e14cf0f54d63df7605e2c92cec2249ca47"
  )
    throw new Error("Watcher patch source changed")
  const addon = path.dirname(createRequire(path.join(source, "package.json")).resolve("node-addon-api/package.json"))
  const patch = path.join(import.meta.dir, "watcher/eintr.patch")
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(patch).bytes()).digest("hex")
  const target = path.join(owner, ".artifacts/watcher", `linux-${arch}-${libc}`)
  const identityHash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(import.meta.filename).bytes())
    .update(hash)
    .update(arch)
    .update(libc)
  for (const root of [path.join(source, "src"), addon]) {
    const files = await Array.fromAsync(new Bun.Glob("**/*.{cc,hh,h,json}").scan({ cwd: root, onlyFiles: true }))
    for (const file of files.sort()) identityHash.update(file).update(await Bun.file(path.join(root, file)).bytes())
  }
  const identity = identityHash.digest("hex")
  const receiptFile = Bun.file(path.join(target, "receipt.json"))
  if (await receiptFile.exists()) {
    const receipt = await receiptFile.json()
    const binary = Bun.file(path.join(target, "watcher.node"))
    if (
      receipt.identity === identity &&
      (await binary.exists()) &&
      new Bun.CryptoHasher("sha256").update(await binary.bytes()).digest("hex") === receipt.sha256
    )
      return path.join(target, "watcher.node")
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  const stage = await fs.mkdtemp(path.join(path.dirname(target), ".building-"))
  try {
    await fs.cp(path.join(source, "src"), path.join(stage, "src"), { recursive: true })
    await fs.cp(addon, path.join(stage, "addon"), {
      recursive: true,
      filter: (entry) => path.basename(entry) !== "node_modules",
    })
    await fs.copyFile(path.join(source, "LICENSE"), path.join(stage, "LICENSE"))
    await run(["patch", "-p1", "--batch", "--forward", "-i", patch], stage)
    const compile = [
      "g++",
      "-shared",
      "-fPIC",
      "-O2",
      "-std=c++17",
      "-fexceptions",
      "-fstack-protector-strong",
      "-DNAPI_DISABLE_CPP_EXCEPTIONS",
      "-DNAPI_VERSION=8",
      "-DWATCHMAN",
      "-DINOTIFY",
      "-DBRUTE_FORCE",
      "-Iaddon",
      `-I${options.local ? (options.headers ?? "/usr/local/include/node") : "/usr/local/include/node"}`,
      ...sources,
      "-pthread",
      "-static-libstdc++",
      "-static-libgcc",
      "-o",
      "watcher.node",
    ]
    const check = "if(require('./watcher.node').synergyWatcherPatch !== '" + PATCH + "') process.exit(1)"
    if (options.local) {
      if (process.platform !== "linux" || process.arch !== arch)
        throw new Error("Local watcher builds require the target Linux architecture")
      await run(compile, stage)
      await run([process.execPath, "-e", check], stage)
    } else {
      const image = libc === "musl" ? "node:22.14.0-alpine3.21" : WATCHER_BUILD_IMAGE
      const platform = `linux/${arch === "x64" ? "amd64" : "arm64"}`
      const script =
        (libc === "musl" ? "apk add --no-cache g++\n" : "") + compile.join(" ") + "\nnode -e " + JSON.stringify(check)
      await Bun.write(path.join(stage, "build.sh"), "set -eu\n" + script)
      await run(
        [
          "docker",
          "run",
          "--rm",
          "--cidfile",
          path.join(stage, "container.id"),
          "--platform",
          platform,
          "-v",
          `${stage}:/build`,
          "-w",
          "/build",
          image,
          "sh",
          "/build/build.sh",
        ],
        stage,
      )
    }
    const sha256 = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path.join(stage, "watcher.node")).bytes())
      .digest("hex")
    await Bun.write(
      path.join(stage, "receipt.json"),
      JSON.stringify({
        version: 1,
        patch: PATCH,
        identity,
        patch_sha256: hash,
        source: "@parcel/watcher@2.5.6",
        arch,
        libc,
        sha256,
        compiler: compile,
        node_headers: "22.14.0",
      }),
    )
    await fs.mkdir(target, { recursive: true })
    for (const file of ["watcher.node", "receipt.json", "LICENSE"])
      await fs.rename(path.join(stage, file), path.join(target, file))
    return path.join(target, "watcher.node")
  } finally {
    const cid = Bun.file(path.join(stage, "container.id"))
    if (await cid.exists()) {
      const container = (await cid.text()).trim()
      if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("Invalid owned watcher build container ID")
      const cleanup = Bun.spawn(["docker", "rm", "-f", container], { stdout: "ignore", stderr: "ignore" })
      await cleanup.exited
    }
    await fs.rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  console.log(
    await buildWatcher({
      arch: value("--arch"),
      libc: value("--libc"),
      headers: value("--headers"),
      local: args.includes("--local"),
    }),
  )
}
