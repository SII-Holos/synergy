import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.skipIf(process.platform === "win32")(
  "release notes cover a long product range without scoped maintenance",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-changelog-"))
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
    try {
      execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: directory, env })
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "base",
        ],
        { cwd: directory, env },
      )
      execFileSync("git", ["tag", "v1.0.0"], { cwd: directory, env })
      let history = ""
      for (let index = 0; index < 253; index++) {
        const message =
          index === 251
            ? "test(release): fixture coverage"
            : index === 252
              ? "chore(ci): maintenance"
              : `feat: release change ${index}`
        const file =
          index === 0
            ? "packages/library/src/sample.ts"
            : index === 1
              ? "apps/desktop/src/main.ts"
              : index === 2
                ? "packages/ui/src/sample.ts"
                : "packages/local-runtime/src/sample.ts"
        const content = `export const value = ${index}\n`
        history +=
          `commit refs/heads/main\nmark :${index + 2}\n` +
          `committer Fixture <fixture@example.com> ${1700000001 + index} +0000\n` +
          `data ${Buffer.byteLength(message)}\n${message}\n` +
          (index === 0 ? "from refs/tags/v1.0.0\n" : "") +
          `M 100644 inline ${file}\ndata ${Buffer.byteLength(content)}\n${content}\n`
      }
      execFileSync("git", ["fast-import", "--quiet"], { cwd: directory, env, input: history })
      const commits = execFileSync("git", ["log", "--reverse", "--format=%H%x00%s", "v1.0.0..HEAD"], {
        cwd: directory,
        env,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .map((line, index) => {
          const [sha, message] = line.split("\0")
          return { sha, message, login: index === 0 ? null : "fixture-author" }
        })
      const bin = path.join(directory, "bin")
      await fs.mkdir(bin)
      await Bun.write(path.join(directory, "commits.json"), JSON.stringify(commits))
      await Bun.write(
        path.join(bin, "gh"),
        `#!${process.execPath}
const args = process.argv.slice(2)
const commits = await Bun.file(new URL("../commits.json", import.meta.url)).json()
const paged = args.some((arg) => arg.includes("per_page="))
const visible = paged ? (args.includes("--paginate") ? commits : commits.slice(0, 100)) : commits.slice(-250)
for (const commit of visible) console.log(JSON.stringify(commit))
`,
      )
      await fs.chmod(path.join(bin, "gh"), 0o755)
      const script = path.resolve(import.meta.dir, "../../script/changelog.ts")
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { getCommits } from ${JSON.stringify(script)}; console.log(JSON.stringify((await getCommits("1.0.0", "HEAD")).map(commit => ({...commit, areas: [...commit.areas]}))));`,
        ],
        {
          cwd: directory,
          env: { ...env, SYNERGY_RELEASE_REPO: "fixture/repo", PATH: `${bin}${path.delimiter}${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      const notes = JSON.parse(stdout) as Array<{
        hash: string
        message: string
        author: string | null
        areas: string[]
      }>
      expect(notes).toHaveLength(251)
      expect(notes[0]).toMatchObject({ message: "feat: release change 250", author: "fixture-author" })
      expect(notes.at(-1)).toMatchObject({ message: "feat: release change 0", author: null, areas: ["core"] })
      expect(notes.at(-2)).toMatchObject({ message: "feat: release change 1", areas: ["desktop"] })
      expect(notes.at(-3)).toMatchObject({ message: "feat: release change 2", areas: ["app"] })
      expect(new Set(notes.map((commit) => commit.hash)).size).toBe(251)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)
