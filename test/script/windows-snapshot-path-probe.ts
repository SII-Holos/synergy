import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "sy-git-probe-"))
const deep = path.join(root, "nested-".repeat(12), "directory-".repeat(12))
await fs.mkdir(deep, { recursive: true })
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_DEFAULT_HASH: "sha1" }
function git(label: string, args: string[], extra?: Record<string, string>) {
  const result = Bun.spawnSync(["git", "-c", "core.longpaths=true", ...args], {
    cwd: path.parse(root).root,
    env: { ...env, ...extra },
  })
  console.log(
    JSON.stringify({
      label,
      code: result.exitCode,
      stdout: result.stdout.toString().trim().slice(0, 600),
      stderr: result.stderr.toString().trim().slice(0, 900),
    }),
  )
  return result
}
async function roundtrip(label: string, repo: string, workspace: string) {
  const index = path.join(deep, label + "-index")
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, "content.txt"), "retained bytes\r\n")
  const args = ["--git-dir", repo, "--work-tree", workspace]
  git(label + ":config", ["--git-dir", repo, "config", "core.autocrlf", "false"])
  git(label + ":add", [...args, "add", "--all"], { GIT_INDEX_FILE: index })
  const tree = git(label + ":tree", [...args, "write-tree"], { GIT_INDEX_FILE: index })
  if (tree.exitCode === 0)
    git(label + ":show", ["--git-dir", repo, "show", tree.stdout.toString().trim() + ":content.txt"])
}
try {
  const original = path.join(deep, "plain.git")
  git("original-init", ["--git-dir", original, "init", "--bare"])
  const short = path.join(root, "short.git")
  git("short-init", ["--git-dir", short, "init", "--bare"])
  const copied = path.join(deep, "copied.git")
  await fs.cp(short, copied, { recursive: true })
  await roundtrip("copied", copied, path.join(deep, "copied-workspace"))
  git("prefixed-init", ["--git-dir", path.toNamespacedPath(path.join(deep, "prefixed.git")), "init", "--bare"])
  const direct = path.join(root, "direct")
  await fs.symlink(deep, direct, "junction")
  const directRepo = path.join(direct, "direct.git")
  git("direct-junction-init", ["--git-dir", directRepo, "init", "--bare"])
  if (
    await fs.stat(path.join(directRepo, "HEAD")).then(
      () => true,
      () => false,
    )
  )
    await roundtrip("direct-junction", directRepo, path.join(direct, "workdir"))
  const first = path.join(root, "first")
  await fs.symlink(path.join(root, "nested-".repeat(12)), first, "junction")
  const second = path.join(root, "second")
  await fs.symlink(path.join(first, "directory-".repeat(12)), second, "junction")
  const chainRepo = path.join(second, "chain.git")
  git("chain-junction-init", ["--git-dir", chainRepo, "init", "--bare"])
  if (
    await fs.stat(path.join(chainRepo, "HEAD")).then(
      () => true,
      () => false,
    )
  )
    await roundtrip("chain-junction", chainRepo, path.join(second, "workdir"))
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
