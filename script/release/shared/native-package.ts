import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"
import { buildPty } from "../../../packages/local-runtime/script/build-pty"
import { buildWatcher } from "../../../packages/local-runtime/script/build-watcher"
import { buildSqlite } from "../../../packages/harness/script/build-sqlite"
import { nativePackageName } from "../../../packages/util/src/native-assets"
import { resolveSandboxAsset, type SandboxRuntimeTarget } from "./build/sandbox-assets"
import { REPO_ROOT } from "./packages"

export const NATIVE_TARGETS: SandboxRuntimeTarget[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
]

export function nativeDependencies(version: string, platforms?: string[]) {
  return Object.fromEntries(
    NATIVE_TARGETS.filter((target) => !platforms || platforms.includes(target.os)).map((target) => [
      nativePackageName({ platform: target.os, arch: target.arch, libc: target.abi ?? "glibc" }),
      version,
    ]),
  )
}

export async function packNativeWorkspace(
  output: string,
  version: string,
  target: SandboxRuntimeTarget,
  assetsRoot?: string,
) {
  const name = nativePackageName({ platform: target.os, arch: target.arch, libc: target.abi ?? "glibc" })
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-native-pack-"))
  try {
    const pty = await buildPty({ os: target.os, arch: target.arch, libc: target.abi ?? "glibc" })
    await fs.copyFile(pty, path.join(stage, path.basename(pty)))
    await fs.copyFile(
      path.join(REPO_ROOT, "packages/local-runtime/src/process/native-pty/LICENSE.bun-pty"),
      path.join(stage, "PTY-LICENSE"),
    )
    if (target.os === "darwin") await fs.copyFile(await buildSqlite(), path.join(stage, "libsqlite3.dylib"))
    const binding =
      target.os === "linux"
        ? await buildWatcher({ arch: target.arch, libc: target.abi ?? "glibc" })
        : createRequire(path.join(REPO_ROOT, "packages/local-runtime/package.json")).resolve(
            `@parcel/watcher-${target.os}-${target.arch}/watcher.node`,
          )
    await fs.copyFile(binding, path.join(stage, "watcher.node"))
    const sandbox = resolveSandboxAsset(target, { assetsRoot, required: true })
    if (sandbox) {
      const file = path.basename(sandbox.relativePath)
      await fs.copyFile(sandbox.sourcePath, path.join(stage, file))
      await fs.chmod(path.join(stage, file), 0o755)
      await Bun.write(
        path.join(stage, "sandbox.json"),
        JSON.stringify({ platform: target.os, file, sha256: sandbox.sha256 }),
      )
    }
    await Bun.write(
      path.join(stage, "package.json"),
      JSON.stringify(
        {
          name,
          version,
          license: "MIT",
          os: [target.os],
          cpu: [target.arch],
          ...(target.os === "linux" ? { libc: [target.abi ?? "glibc"] } : {}),
          exports: { "./*": "./*" },
        },
        null,
        2,
      ),
    )
    await fs.mkdir(output, { recursive: true })
    const archive = path.join(output, `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`)
    const child = Bun.spawn(["bun", "pm", "pack", "--filename", archive, "--ignore-scripts"], {
      cwd: stage,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (code) throw new Error(`Packing ${name} failed: ${stderr}`)
    return { name, archive }
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}
