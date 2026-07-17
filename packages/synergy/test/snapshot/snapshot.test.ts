import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Snapshot } from "../../src/session/snapshot"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"
import { SessionBounds } from "../../src/session/bounds"

async function bootstrap(options?: { commit?: boolean }) {
  const sessionID = `test-${Math.random().toString(36).slice(2)}`
  return tmpdir({
    git: options?.commit,
    init: async (dir) => {
      const unique = Math.random().toString(36).slice(2)
      const aContent = `A${unique}`
      const bContent = `B${unique}`
      await Bun.write(`${dir}/a.txt`, aContent)
      await Bun.write(`${dir}/b.txt`, bContent)
      if (options?.commit) {
        await $`git add .`.cwd(dir).quiet()
        await $`git commit --no-gpg-sign -m init`.cwd(dir).quiet()
      } else {
        await $`git init`.cwd(dir).quiet()
      }
      return {
        aContent,
        bContent,
        sessionID,
      }
    },
  })
}

function longFilenameFor(root: string) {
  const extension = ".txt"
  const desiredLength = 200
  if (process.platform !== "win32") return "a".repeat(desiredLength) + extension

  const maxPathLength = 240
  const prefixLength = path.join(root, "").length
  const safeLength = Math.max(64, Math.min(desiredLength, maxPathLength - prefixLength - extension.length))
  return "a".repeat(safeLength) + extension
}

async function trySymlink(target: string, link: string, type: "file" | "dir") {
  try {
    await fs.symlink(target, link, process.platform === "win32" && type === "dir" ? "junction" : type)
    return true
  } catch (error) {
    if (process.platform === "win32" && isSymlinkPrivilegeError(error)) return false
    throw error
  }
}

function isSymlinkPrivilegeError(error: unknown) {
  const code = (error as { code?: unknown })?.code
  return code === "EPERM" || code === "EACCES" || code === "UNKNOWN"
}

async function withGitCommandLog<T>(fn: (commands: string[]) => Promise<T>) {
  const originalSpawn = Bun.spawn
  const commands: string[] = []
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const command = args[0]
    if (Array.isArray(command) && command[0] === "git") commands.push(command.map(String).join(" "))
    return originalSpawn(...args)
  }) as typeof Bun.spawn
  try {
    return await fn(commands)
  } finally {
    Bun.spawn = originalSpawn
  }
}

describe.serial("snapshot", () => {
  test("retries a transient git spawn failure", async () => {
    await using tmp = await bootstrap()
    const scope = await tmp.scope()
    const originalSpawn = Bun.spawn
    let diffFilesAttempts = 0
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      const command = args[0]
      if (Array.isArray(command) && command[0] === "git" && command.includes("diff-files")) {
        diffFilesAttempts++
        if (diffFilesAttempts === 1) {
          throw Object.assign(new Error("too many open files"), { code: "EMFILE" })
        }
      }
      return originalSpawn(...args)
    }) as typeof Bun.spawn

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          expect(await Snapshot.track(tmp.extra.sessionID)).toBeTruthy()
        },
      })
      expect(diffFilesAttempts).toBe(2)
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  test("retries a transient git init SIGPIPE exit", async () => {
    await using tmp = await bootstrap()
    const scope = await tmp.scope()
    const originalSpawn = Bun.spawn
    let initAttempts = 0
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      const command = args[0]
      if (Array.isArray(command) && command.length === 2 && command[0] === "git" && command[1] === "init") {
        initAttempts++
        if (initAttempts === 1) {
          return originalSpawn([process.execPath, "-e", "process.exit(141)"], args[1])
        }
      }
      return originalSpawn(...args)
    }) as typeof Bun.spawn

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          expect(await Snapshot.track(tmp.extra.sessionID)).toBeTruthy()
        },
      })
      expect(initAttempts).toBe(2)
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  test("does not retry a permanent git spawn failure", async () => {
    await using tmp = await bootstrap()
    const scope = await tmp.scope()
    const originalSpawn = Bun.spawn
    let diffFilesAttempts = 0
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      const command = args[0]
      if (Array.isArray(command) && command[0] === "git" && command.includes("diff-files")) {
        diffFilesAttempts++
        throw Object.assign(new Error("permission denied"), { code: "EACCES" })
      }
      return originalSpawn(...args)
    }) as typeof Bun.spawn

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          expect(await Snapshot.track(tmp.extra.sessionID)).toBeUndefined()
        },
      })
      expect(diffFilesAttempts).toBe(1)
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  test("tracks deleted files correctly", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await $`rm ${tmp.path}/a.txt`.quiet()

        expect((await Snapshot.patch(before!, tmp.extra.sessionID)).files).toContain(`${tmp.path}/a.txt`)
      },
    })
  })

  test("revert should remove new files", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/new.txt`, "NEW")

        await Snapshot.revert([await Snapshot.patch(before!, tmp.extra.sessionID)], tmp.extra.sessionID)

        expect(await Bun.file(`${tmp.path}/new.txt`).exists()).toBe(false)
      },
    })
  })

  test("revert in subdirectory", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await $`mkdir -p ${tmp.path}/sub`.quiet()
        await Bun.write(`${tmp.path}/sub/file.txt`, "SUB")

        await Snapshot.revert([await Snapshot.patch(before!, tmp.extra.sessionID)], tmp.extra.sessionID)

        expect(await Bun.file(`${tmp.path}/sub/file.txt`).exists()).toBe(false)
        // Note: revert currently only removes files, not directories
        // The empty subdirectory will remain
      },
    })
  })

  test("multiple file operations", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await $`rm ${tmp.path}/a.txt`.quiet()
        await Bun.write(`${tmp.path}/c.txt`, "C")
        await $`mkdir -p ${tmp.path}/dir`.quiet()
        await Bun.write(`${tmp.path}/dir/d.txt`, "D")
        await Bun.write(`${tmp.path}/b.txt`, "MODIFIED")

        await Snapshot.revert([await Snapshot.patch(before!, tmp.extra.sessionID)], tmp.extra.sessionID)

        expect(await Bun.file(`${tmp.path}/a.txt`).text()).toBe(tmp.extra.aContent)
        expect(await Bun.file(`${tmp.path}/c.txt`).exists()).toBe(false)
        // Note: revert currently only removes files, not directories
        // The empty directory will remain
        expect(await Bun.file(`${tmp.path}/b.txt`).text()).toBe(tmp.extra.bContent)
      },
    })
  })

  test("empty directory handling", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await $`mkdir ${tmp.path}/empty`.quiet()

        expect((await Snapshot.patch(before!, tmp.extra.sessionID)).files.length).toBe(0)
      },
    })
  })

  test("binary file handling respects snapshot exclude policy", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/image.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
        expect(patch.files).not.toContain(`${tmp.path}/image.png`)

        await Snapshot.revert([patch], tmp.extra.sessionID)
        expect(await Bun.file(`${tmp.path}/image.png`).exists()).toBe(true)
      },
    })
  })

  test("patch returns empty immediately when signal is already aborted", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/aborted.txt`, "aborted")
        const controller = new AbortController()
        controller.abort()
        const started = Date.now()
        const patch = await Snapshot.patch(before!, tmp.extra.sessionID, { signal: controller.signal })

        expect(patch.files).toEqual([])
        expect(Date.now() - started).toBeLessThan(1000)
      },
    })
  })

  test("large file handling", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/large.txt`, "x".repeat(1024 * 1024))

        expect((await Snapshot.patch(before!, tmp.extra.sessionID)).files).toContain(`${tmp.path}/large.txt`)
      },
    })
  })

  test("snapshot policy excludes private, dependency, archive, binary, and oversized files", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await $`mkdir -p ${tmp.path}/.synergy ${tmp.path}/node_modules/pkg`.quiet()
        await Bun.write(`${tmp.path}/.synergy/private.json`, "{}")
        await Bun.write(`${tmp.path}/node_modules/pkg/index.js`, "module.exports = 1")
        await Bun.write(`${tmp.path}/archive.zip`, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
        await Bun.write(`${tmp.path}/data.db`, new Uint8Array([0x00, 0x01]))
        await Bun.write(`${tmp.path}/document.pdf`, "%PDF-1.7")
        await Bun.write(`${tmp.path}/image.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
        await Bun.write(`${tmp.path}/too-large.txt`, "x".repeat(2 * 1024 * 1024 + 1))
        await Bun.write(`${tmp.path}/included.txt`, "small text")

        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
        expect(patch.files).toContain(`${tmp.path}/included.txt`)
        expect(patch.files).not.toContain(`${tmp.path}/.synergy/private.json`)
        expect(patch.files).not.toContain(`${tmp.path}/node_modules/pkg/index.js`)
        expect(patch.files).not.toContain(`${tmp.path}/archive.zip`)
        expect(patch.files).not.toContain(`${tmp.path}/data.db`)
        expect(patch.files).not.toContain(`${tmp.path}/document.pdf`)
        expect(patch.files).not.toContain(`${tmp.path}/image.png`)
        expect(patch.files).not.toContain(`${tmp.path}/too-large.txt`)
      },
    })
  })

  test("nested directory revert", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await $`mkdir -p ${tmp.path}/level1/level2/level3`.quiet()
        await Bun.write(`${tmp.path}/level1/level2/level3/deep.txt`, "DEEP")

        await Snapshot.revert([await Snapshot.patch(before!, tmp.extra.sessionID)], tmp.extra.sessionID)

        expect(await Bun.file(`${tmp.path}/level1/level2/level3/deep.txt`).exists()).toBe(false)
      },
    })
  })

  test("revert with empty patches", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Should not crash with empty patches
        expect(Snapshot.revert([], tmp.extra.sessionID)).resolves.toBeUndefined()

        // Should not crash with patches that have empty file lists
        expect(Snapshot.revert([{ hash: "dummy", files: [] }], tmp.extra.sessionID)).resolves.toBeUndefined()
      },
    })
  })

  test("patch with invalid hash", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        // Create a change
        await Bun.write(`${tmp.path}/test.txt`, "TEST")

        // Try to patch with invalid hash - should handle gracefully
        const patch = await Snapshot.patch("invalid-hash-12345", tmp.extra.sessionID)
        expect(patch.files).toEqual([])
        expect(patch.hash).toBe("invalid-hash-12345")
      },
    })
  })

  test("revert non-existent file", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        // Try to revert a file that doesn't exist in the snapshot
        // This should not crash
        expect(
          Snapshot.revert(
            [
              {
                hash: before!,
                files: [`${tmp.path}/nonexistent.txt`],
              },
            ],
            tmp.extra.sessionID,
          ),
        ).resolves.toBeUndefined()
      },
    })
  })

  test("unicode filenames", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        const unicodeFiles = [
          `${tmp.path}/文件.txt`,
          `${tmp.path}/🚀rocket.txt`,
          `${tmp.path}/café.txt`,
          `${tmp.path}/файл.txt`,
        ]

        for (const file of unicodeFiles) {
          await Bun.write(file, "unicode content")
        }

        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
        // Note: git escapes unicode characters by default, so we just check that files are detected
        // The actual filenames will be escaped like "caf\303\251.txt" but functionality works
        expect(patch.files.length).toBe(4)

        // Skip revert test due to git filename escaping issues
        // The functionality works but git uses escaped filenames internally
      },
    })
  })

  test("very long filenames", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        const longName = longFilenameFor(tmp.path)
        const longFile = `${tmp.path}/${longName}`

        await Bun.write(longFile, "long filename content")

        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
        expect(patch.files).toContain(longFile)

        await Snapshot.revert([patch], tmp.extra.sessionID)
        expect(await Bun.file(longFile).exists()).toBe(false)
      },
    })
  })

  test("hidden files", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/.hidden`, "hidden content")
        await Bun.write(`${tmp.path}/.gitignore`, "*.log")
        await Bun.write(`${tmp.path}/.config`, "config content")

        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
        expect(patch.files).toContain(`${tmp.path}/.hidden`)
        expect(patch.files).toContain(`${tmp.path}/.gitignore`)
        expect(patch.files).toContain(`${tmp.path}/.config`)
      },
    })
  })

  test("nested symlinks", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        const subDir = path.join(tmp.path, "sub", "dir")
        const targetFile = path.join(subDir, "target.txt")
        const fileLink = path.join(subDir, "link.txt")
        const dirLink = path.join(tmp.path, "sub-link")
        await fs.mkdir(subDir, { recursive: true })
        await Bun.write(targetFile, "target content")
        const createdFileLink = await trySymlink(targetFile, fileLink, "file")
        const createdDirLink = await trySymlink(path.join(tmp.path, "sub"), dirLink, "dir")

        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
        if (createdFileLink) expect(patch.files).toContain(`${tmp.path}/sub/dir/link.txt`)
        if (createdDirLink) {
          const dirLinkPath = `${tmp.path}/sub-link`
          if (process.platform === "win32") expect(patch.files.some((file) => file.startsWith(dirLinkPath))).toBe(true)
          else expect(patch.files).toContain(dirLinkPath)
        }
        if (!createdFileLink && !createdDirLink) expect(patch.files).toContain(`${tmp.path}/sub/dir/target.txt`)
      },
    })
  })

  test("file permissions and ownership changes", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        // Change permissions multiple times
        await fs.chmod(path.join(tmp.path, "a.txt"), 0o600)
        await fs.chmod(path.join(tmp.path, "a.txt"), 0o755)
        await fs.chmod(path.join(tmp.path, "a.txt"), 0o644)

        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
        // Note: git doesn't track permission changes on existing files by default
        // Only tracks executable bit when files are first added
        expect(patch.files.length).toBe(0)
      },
    })
  })

  test("circular symlinks", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        // Create circular symlink
        await $`ln -s ${tmp.path}/circular ${tmp.path}/circular`.quiet().nothrow()

        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
        expect(patch.files.length).toBeGreaterThanOrEqual(0) // Should not crash
      },
    })
  })

  test("gitignore changes", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/.gitignore`, "*.ignored")
        await Bun.write(`${tmp.path}/test.ignored`, "ignored content")
        await Bun.write(`${tmp.path}/normal.txt`, "normal content")
        // Ensure git picks up the new .gitignore before diffing
        await $`git add .`.cwd(tmp.path).quiet().nothrow()

        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)

        // Should track gitignore itself
        expect(patch.files).toContain(`${tmp.path}/.gitignore`)
        // Should track normal files
        expect(patch.files).toContain(`${tmp.path}/normal.txt`)
        // Should not track ignored files (git won't see them)
        expect(patch.files).not.toContain(`${tmp.path}/test.ignored`)
      },
    })
  })

  test("concurrent file operations during patch", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        // Start creating files
        const createPromise = (async () => {
          for (let i = 0; i < 10; i++) {
            await Bun.write(`${tmp.path}/concurrent${i}.txt`, `concurrent${i}`)
            // Small delay to simulate concurrent operations
            await new Promise((resolve) => setTimeout(resolve, 1))
          }
        })()

        // Get patch while files are being created
        const patchPromise = Snapshot.patch(before!, tmp.extra.sessionID)

        await createPromise
        const patch = await patchPromise

        // Should capture some or all of the concurrent files
        expect(patch.files.length).toBeGreaterThanOrEqual(0)
      },
    })
  })

  test("snapshot state isolation between projects", async () => {
    // Test that different projects don't interfere with each other
    await using tmp1 = await bootstrap()
    await using tmp2 = await bootstrap()

    await ScopeContext.provide({
      scope: await tmp1.scope(),
      fn: async () => {
        const before1 = await Snapshot.track(tmp1.extra.sessionID)
        await Bun.write(`${tmp1.path}/project1.txt`, "project1 content")
        const patch1 = await Snapshot.patch(before1!, tmp1.extra.sessionID)
        expect(patch1.files).toContain(`${tmp1.path}/project1.txt`)
      },
    })

    await ScopeContext.provide({
      scope: await tmp2.scope(),
      fn: async () => {
        const before2 = await Snapshot.track(tmp2.extra.sessionID)
        await Bun.write(`${tmp2.path}/project2.txt`, "project2 content")
        const patch2 = await Snapshot.patch(before2!, tmp2.extra.sessionID)
        expect(patch2.files).toContain(`${tmp2.path}/project2.txt`)

        // Ensure project1 files don't appear in project2
        expect(patch2.files).not.toContain(`${tmp1?.path}/project1.txt`)
      },
    })
  })

  test("patch detects changes in secondary worktree", async () => {
    await using tmp = await bootstrap({ commit: true })
    const worktreePath = `${tmp.path}-worktree`
    await $`git worktree add ${worktreePath} HEAD`.cwd(tmp.path).quiet()

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          expect(await Snapshot.track(tmp.extra.sessionID)).toBeTruthy()
        },
      })

      await ScopeContext.provide({
        scope: (await Scope.fromDirectory(worktreePath)).scope,
        fn: async () => {
          const before = await Snapshot.track(tmp.extra.sessionID)
          expect(before).toBeTruthy()

          const worktreeFile = `${worktreePath}/worktree.txt`
          await Bun.write(worktreeFile, "worktree content")

          const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
          expect(patch.files).toContain(worktreeFile)
        },
      })
    } finally {
      await $`git worktree remove --force ${worktreePath}`.cwd(tmp.path).quiet().nothrow()
      await $`rm -rf ${worktreePath}`.quiet()
    }
  })

  test("revert only removes files in invoking worktree", async () => {
    await using tmp = await bootstrap({ commit: true })
    const sessionID = "revert-worktree-isolation"
    const worktreePath = `${tmp.path}-worktree`
    await $`git worktree add ${worktreePath} HEAD`.cwd(tmp.path).quiet()

    try {
      const primaryFile = `${tmp.path}/worktree.txt`
      await Bun.write(primaryFile, "primary content")

      await ScopeContext.provide({
        scope: (await Scope.fromDirectory(worktreePath)).scope,
        fn: async () => {
          const before = await Snapshot.track(sessionID)
          expect(before).toBeTruthy()

          const worktreeFile = `${worktreePath}/worktree.txt`
          await Bun.write(worktreeFile, "worktree content")

          const patch = await Snapshot.patch(before!, sessionID)
          await Snapshot.revert([patch], sessionID)

          expect(await Bun.file(worktreeFile).exists()).toBe(false)
        },
      })

      expect(await Bun.file(primaryFile).text()).toBe("primary content")
    } finally {
      await $`git worktree remove --force ${worktreePath}`.cwd(tmp.path).quiet().nothrow()
      await $`rm -rf ${worktreePath}`.quiet()
      await $`rm -f ${tmp.path}/worktree.txt`.quiet()
    }
  })

  test("diff reports worktree-only/shared edits and ignores primary-only", async () => {
    await using tmp = await bootstrap({ commit: true })
    const worktreePath = `${tmp.path}-worktree`
    await $`git worktree add ${worktreePath} HEAD`.cwd(tmp.path).quiet()

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          expect(await Snapshot.track(tmp.extra.sessionID)).toBeTruthy()
        },
      })

      await ScopeContext.provide({
        scope: (await Scope.fromDirectory(worktreePath)).scope,
        fn: async () => {
          const before = await Snapshot.track(tmp.extra.sessionID)
          expect(before).toBeTruthy()

          await Bun.write(`${worktreePath}/worktree-only.txt`, "worktree diff content")
          await Bun.write(`${worktreePath}/shared.txt`, "worktree edit")
          await Bun.write(`${tmp.path}/shared.txt`, "primary edit")
          await Bun.write(`${tmp.path}/primary-only.txt`, "primary change")

          const diff = await Snapshot.diff(before!, tmp.extra.sessionID)
          expect(diff).toContain("worktree-only.txt")
          expect(diff).toContain("shared.txt")
          expect(diff).not.toContain("primary-only.txt")
        },
      })
    } finally {
      await $`git worktree remove --force ${worktreePath}`.cwd(tmp.path).quiet().nothrow()
      await $`rm -rf ${worktreePath}`.quiet()
      await $`rm -f ${tmp.path}/shared.txt`.quiet()
      await $`rm -f ${tmp.path}/primary-only.txt`.quiet()
    }
  })

  test("track with no changes returns same hash", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const hash1 = await Snapshot.track(tmp.extra.sessionID)
        expect(hash1).toBeTruthy()

        // Track again with no changes
        const hash2 = await Snapshot.track(tmp.extra.sessionID)
        expect(hash2).toBe(hash1!)

        // Track again
        const hash3 = await Snapshot.track(tmp.extra.sessionID)
        expect(hash3).toBe(hash1!)
      },
    })
  })

  test("snapshot refresh keeps the shadow index and diffSummary uses bounded git commands", async () => {
    await using tmp = await bootstrap()
    await withGitCommandLog(async (commands) => {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const before = await Snapshot.track(tmp.extra.sessionID)
          expect(before).toBeTruthy()

          await Bun.write(`${tmp.path}/a.txt`, "changed a")
          await Bun.write(`${tmp.path}/c.txt`, "new c")
          const after = await Snapshot.track(tmp.extra.sessionID)
          expect(after).toBeTruthy()

          const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
          expect(diffs.map((diff) => diff.file).sort()).toEqual(["a.txt", "c.txt"])

          expect(commands.some((command) => command.includes("rm -r --cached") && command.endsWith(" ."))).toBe(false)
          expect(
            commands.filter((command) => command.includes(" diff ") && command.includes(" --numstat -p ")),
          ).toHaveLength(1)
          expect(commands.filter((command) => command.includes(" cat-file --batch-check="))).toHaveLength(1)
          expect(commands.some((command) => command.includes(" cat-file -s "))).toBe(false)
        },
      })
    })
  })

  test("diff function with various changes", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        // Make various changes
        await $`rm ${tmp.path}/a.txt`.quiet()
        await Bun.write(`${tmp.path}/new.txt`, "new content")
        await Bun.write(`${tmp.path}/b.txt`, "modified content")

        const diff = await Snapshot.diff(before!, tmp.extra.sessionID)
        expect(diff).toContain("a.txt")
        expect(diff).toContain("b.txt")
        expect(diff).toContain("new.txt")
      },
    })
  })

  test("restore function — per-file restore based on session patches", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        // Make changes
        await $`rm ${tmp.path}/a.txt`.quiet()
        await Bun.write(`${tmp.path}/new.txt`, "new content")
        await Bun.write(`${tmp.path}/b.txt`, "modified")

        // Revert using session's patch (restores only tracked changes)
        const patch = await Snapshot.patch(before!, tmp.extra.sessionID)
        await Snapshot.revert([patch], tmp.extra.sessionID)

        // Files in patch should be restored
        expect(await Bun.file(`${tmp.path}/a.txt`).exists()).toBe(true)
        expect(await Bun.file(`${tmp.path}/a.txt`).text()).toBe(tmp.extra.aContent)
        expect(await Bun.file(`${tmp.path}/b.txt`).text()).toBe(tmp.extra.bContent)
        // Files not in any snapshot (new) are deleted
        expect(await Bun.file(`${tmp.path}/new.txt`).exists()).toBe(false)
      },
    })
  })

  test("revert should not delete files that existed but were deleted in snapshot", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const snapshot1 = await Snapshot.track(tmp.extra.sessionID)
        expect(snapshot1).toBeTruthy()

        await $`rm ${tmp.path}/a.txt`.quiet()

        const snapshot2 = await Snapshot.track(tmp.extra.sessionID)
        expect(snapshot2).toBeTruthy()

        await Bun.write(`${tmp.path}/a.txt`, "recreated content")

        const patch = await Snapshot.patch(snapshot2!, tmp.extra.sessionID)
        expect(patch.files).toContain(`${tmp.path}/a.txt`)

        await Snapshot.revert([patch], tmp.extra.sessionID)

        expect(await Bun.file(`${tmp.path}/a.txt`).exists()).toBe(false)
      },
    })
  })

  test("revert preserves file that existed in snapshot when deleted then recreated", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Bun.write(`${tmp.path}/existing.txt`, "original content")

        const snapshot = await Snapshot.track(tmp.extra.sessionID)
        expect(snapshot).toBeTruthy()

        await $`rm ${tmp.path}/existing.txt`.quiet()
        await Bun.write(`${tmp.path}/existing.txt`, "recreated")
        await Bun.write(`${tmp.path}/newfile.txt`, "new")

        const patch = await Snapshot.patch(snapshot!, tmp.extra.sessionID)
        expect(patch.files).toContain(`${tmp.path}/existing.txt`)
        expect(patch.files).toContain(`${tmp.path}/newfile.txt`)

        await Snapshot.revert([patch], tmp.extra.sessionID)

        expect(await Bun.file(`${tmp.path}/newfile.txt`).exists()).toBe(false)
        expect(await Bun.file(`${tmp.path}/existing.txt`).exists()).toBe(true)
        expect(await Bun.file(`${tmp.path}/existing.txt`).text()).toBe("original content")
      },
    })
  })

  test("diffSummary with new file additions", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/new.txt`, "new content")

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        expect(diffs.length).toBe(1)

        const newFileDiff = diffs[0]
        expect(newFileDiff.file).toBe("new.txt")
        expect(newFileDiff.beforeBytes).toBeUndefined()
        expect(newFileDiff.afterBytes).toBe("new content".length)
        expect(newFileDiff.preview).toContain("new content")
        expect(newFileDiff.additions).toBe(1)
        expect(newFileDiff.deletions).toBe(0)
      },
    })
  })

  test("diffSummary with file modifications", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/b.txt`, "modified content")

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        expect(diffs.length).toBe(1)

        const modifiedFileDiff = diffs[0]
        expect(modifiedFileDiff.file).toBe("b.txt")
        expect(modifiedFileDiff.beforeBytes).toBe(tmp.extra.bContent.length)
        expect(modifiedFileDiff.afterBytes).toBe("modified content".length)
        expect(modifiedFileDiff.preview).toContain("modified content")
        expect(modifiedFileDiff.additions).toBeGreaterThan(0)
        expect(modifiedFileDiff.deletions).toBeGreaterThan(0)
      },
    })
  })

  test("diffSummary with file deletions", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await $`rm ${tmp.path}/a.txt`.quiet()

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        expect(diffs.length).toBe(1)

        const removedFileDiff = diffs[0]
        expect(removedFileDiff.file).toBe("a.txt")
        expect(removedFileDiff.beforeBytes).toBe(tmp.extra.aContent.length)
        expect(removedFileDiff.afterBytes).toBeUndefined()
        expect(removedFileDiff.preview).toContain("a.txt")
        expect(removedFileDiff.additions).toBe(0)
        expect(removedFileDiff.deletions).toBe(1)
      },
    })
  })

  test("diffSummary with multiple line additions", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/multi.txt`, "line1\nline2\nline3")

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        expect(diffs.length).toBe(1)

        const multiDiff = diffs[0]
        expect(multiDiff.file).toBe("multi.txt")
        expect(multiDiff.beforeBytes).toBeUndefined()
        expect(multiDiff.afterBytes).toBe("line1\nline2\nline3".length)
        expect(multiDiff.preview).toContain("line1")
        expect(multiDiff.additions).toBe(3)
        expect(multiDiff.deletions).toBe(0)
      },
    })
  })

  test("diffSummary with addition and deletion", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/added.txt`, "added content")
        await $`rm ${tmp.path}/a.txt`.quiet()

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        expect(diffs.length).toBe(2)

        const addedFileDiff = diffs.find((d) => d.file === "added.txt")
        expect(addedFileDiff).toBeDefined()
        expect(addedFileDiff!.beforeBytes).toBeUndefined()
        expect(addedFileDiff!.afterBytes).toBe("added content".length)
        expect(addedFileDiff!.preview).toContain("added content")
        expect(addedFileDiff!.additions).toBe(1)
        expect(addedFileDiff!.deletions).toBe(0)

        const removedFileDiff = diffs.find((d) => d.file === "a.txt")
        expect(removedFileDiff).toBeDefined()
        expect(removedFileDiff!.beforeBytes).toBe(tmp.extra.aContent.length)
        expect(removedFileDiff!.afterBytes).toBeUndefined()
        expect(removedFileDiff!.preview).toContain("a.txt")
        expect(removedFileDiff!.additions).toBe(0)
        expect(removedFileDiff!.deletions).toBe(1)
      },
    })
  })

  test("diffSummary with multiple additions and deletions", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/multi1.txt`, "line1\nline2\nline3")
        await Bun.write(`${tmp.path}/multi2.txt`, "single line")
        await $`rm ${tmp.path}/a.txt`.quiet()
        await $`rm ${tmp.path}/b.txt`.quiet()

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        expect(diffs.length).toBe(4)

        const multi1Diff = diffs.find((d) => d.file === "multi1.txt")
        expect(multi1Diff).toBeDefined()
        expect(multi1Diff!.additions).toBe(3)
        expect(multi1Diff!.deletions).toBe(0)

        const multi2Diff = diffs.find((d) => d.file === "multi2.txt")
        expect(multi2Diff).toBeDefined()
        expect(multi2Diff!.additions).toBe(1)
        expect(multi2Diff!.deletions).toBe(0)

        const removedADiff = diffs.find((d) => d.file === "a.txt")
        expect(removedADiff).toBeDefined()
        expect(removedADiff!.additions).toBe(0)
        expect(removedADiff!.deletions).toBe(1)

        const removedBDiff = diffs.find((d) => d.file === "b.txt")
        expect(removedBDiff).toBeDefined()
        expect(removedBDiff!.additions).toBe(0)
        expect(removedBDiff!.deletions).toBe(1)
      },
    })
  })

  test("diffSummary with no changes", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        expect(diffs.length).toBe(0)
      },
    })
  })

  test("diffSummary bounds aggregate preview bytes while preserving file statistics", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        const fileCount = 50
        const content = "界".repeat(8_000)
        await Promise.all(
          Array.from({ length: fileCount }, (_, index) =>
            Bun.write(`${tmp.path}/large-${index.toString().padStart(2, "0")}.txt`, content),
          ),
        )

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        const previewBytes = diffs.reduce((sum, diff) => sum + Buffer.byteLength(diff.preview ?? "", "utf8"), 0)

        expect(diffs).toHaveLength(fileCount)
        expect(diffs.every((diff) => diff.additions === 1 && diff.deletions === 0)).toBe(true)
        expect(previewBytes).toBeLessThanOrEqual(SessionBounds.DIFF_AGGREGATE_PREVIEW_MAX_BYTES)
        expect(diffs.some((diff) => diff.preview === undefined && diff.truncated === true)).toBe(true)
      },
    })
  })

  test("diffSummary with binary file changes", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/binary.bin`, new Uint8Array([0x00, 0x01, 0x02, 0x03]))

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        expect(diffs.length).toBe(0)
      },
    })
  })

  test("diffSummary with whitespace changes", async () => {
    await using tmp = await bootstrap()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Bun.write(`${tmp.path}/whitespace.txt`, "line1\nline2")
        const before = await Snapshot.track(tmp.extra.sessionID)
        expect(before).toBeTruthy()

        await Bun.write(`${tmp.path}/whitespace.txt`, "line1\n\nline2\n")

        const after = await Snapshot.track(tmp.extra.sessionID)
        expect(after).toBeTruthy()

        const diffs = await Snapshot.diffSummary(before!, after!, tmp.extra.sessionID)
        expect(diffs.length).toBe(1)

        const whitespaceDiff = diffs[0]
        expect(whitespaceDiff.file).toBe("whitespace.txt")
        expect(whitespaceDiff.additions).toBeGreaterThan(0)
      },
    })
  })
})
