import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { Argv } from "yargs"
import yargs from "yargs"
import { tmpdir } from "../fixture/fixture"
import { Global } from "../../src/global"
import {
  CATEGORIES,
  checkDiskSpace,
  copyDirSkipExisting,
  dataRoot,
  dirExists,
  formatSize,
  getLibraryInfo,
  isDirEmpty,
  mergeLibraryDB,
  removeShellProfile,
  resolveLibraryDB,
  scanCategories,
  scanDir,
  shortenPath,
  updateShellProfile,
} from "../../src/cli/cmd/data/shared"

const clackState = {
  confirmResult: true as boolean | "cancel",
  multiselectResult: [] as string[] | "cancel",
  selectFirst: true,
  textValue: "",
  passwordValue: "secret",
}

const clackModuleURL = import.meta.resolve("@clack/prompts")
mock.module(clackModuleURL, () => ({
  intro: () => {},
  outro: () => {},
  log: { info: () => {}, success: () => {}, warn: () => {}, error: () => {}, message: () => {} },
  cancel: () => {},
  note: () => {},
  isCancel: (value: unknown) => value === "cancel" || value === undefined,
  spinner: () => ({ start: () => {}, message: () => {}, stop: () => {} }),
  text: async (opts?: { initialValue?: string }) => clackState.textValue || opts?.initialValue || "value",
  password: async () => clackState.passwordValue,
  confirm: async () => clackState.confirmResult,
  select: async (opts: { options: Array<{ value: unknown }> }) =>
    clackState.selectFirst ? opts.options[0]?.value : "cancel",
  multiselect: async () => clackState.multiselectResult,
}))

afterEach(() => {
  delete process.env.SYNERGY_HOME
  delete process.env.SHELL
  delete process.env.XDG_CONFIG_HOME
  clackState.confirmResult = true
  clackState.multiselectResult = []
  clackState.selectFirst = true
  clackState.textValue = ""
})

function handlerArgs<T extends Record<string, unknown>>(partial: T) {
  return { _: [] as Array<string | number>, $0: "synergy", ...partial }
}

function runHandler(command: { handler?: unknown }) {
  return (command.handler as (args: never) => Promise<void>).bind(command)
}

function runBuilder(command: { builder?: unknown }) {
  return (command.builder as (argv: Argv) => Argv)(yargs())
}

describe("data shared helpers", () => {
  test("scanDir sums sizes and file counts recursively", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "12345")
        await Bun.write(path.join(dir, "b.txt"), "123")
        await Bun.write(path.join(dir, "ignored-link"), "x")
      },
    })
    const stats = await scanDir(tmp.path)
    expect(stats.fileCount).toBe(3)
    expect(stats.size).toBe(9)
    expect((await scanDir(path.join(tmp.path, "missing"))).fileCount).toBe(0)
  })

  test("scanCategories maps every category key", async () => {
    await using tmp = await tmpdir()
    const stats = await scanCategories(tmp.path)
    expect(stats.size).toBe(CATEGORIES.length)
    for (const cat of CATEGORIES) expect(stats.get(cat.key)).toEqual({ size: 0, fileCount: 0 })
  })

  test("formatSize scales across byte units", () => {
    expect(formatSize(500)).toBe("500 B")
    expect(formatSize(2048)).toBe("2.0 KB")
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB")
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe("2.0 GB")
  })

  test("shortenPath leaves non-home paths unchanged", async () => {
    await using tmp = await tmpdir()
    expect(shortenPath(tmp.path)).toBe(tmp.path)
  })

  test("dirExists and isDirEmpty reflect the filesystem", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.txt"), "x")
      },
    })
    expect(await dirExists(tmp.path)).toBe(true)
    expect(await dirExists(path.join(tmp.path, "nope"))).toBe(false)
    expect(await isDirEmpty(tmp.path)).toBe(false)
    await using empty = await tmpdir()
    await fs.mkdir(path.join(empty.path, "subdir"))
    expect(await isDirEmpty(path.join(empty.path, "subdir"))).toBe(true)
  })

  test("checkDiskSpace creates the parent and reports ok", async () => {
    await using tmp = await tmpdir()
    const result = await checkDiskSpace(path.join(tmp.path, "deep", "target"), 1024)
    expect(result.ok).toBe(true)
    expect(result.available === null || result.available > 0).toBe(true)
    expect(await dirExists(path.join(tmp.path, "deep"))).toBe(true)
  })

  test("copyDirSkipExisting copies new files, skips existing, follows symlinks", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "keep.txt"), "original")
        await Bun.write(path.join(dir, "nested", "inner.txt"), "inner")
        await fs.symlink("keep.txt", path.join(dir, "link.txt"))
      },
    })
    await using dst = await tmpdir()
    const progress: number[] = []
    const result = await copyDirSkipExisting(tmp.path, dst.path, (p) => progress.push(p.copied))
    expect(result).toEqual({ copied: 3, skipped: 0 })
    expect(progress).toEqual([1, 2, 3])
    expect(await Bun.file(path.join(dst.path, "nested", "inner.txt")).text()).toBe("inner")

    await Bun.write(path.join(dst.path, "keep.txt"), "changed")
    const second = await copyDirSkipExisting(tmp.path, dst.path)
    expect(second).toEqual({ copied: 0, skipped: 3 })
    expect(await Bun.file(path.join(dst.path, "keep.txt")).text()).toBe("changed")
  })

  test("resolveLibraryDB prefers library.db over the legacy engram name", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "data", "engram.db"), "legacy")
      },
    })
    expect(await resolveLibraryDB(tmp.path)).toBe(path.join(tmp.path, "data", "engram.db"))
    await Bun.write(path.join(tmp.path, "data", "library.db"), "current")
    expect(await resolveLibraryDB(tmp.path)).toBe(path.join(tmp.path, "data", "library.db"))
  })

  test("getLibraryInfo reports missing databases without touching them", async () => {
    await using tmp = await tmpdir()
    expect(await getLibraryInfo(path.join(tmp.path, "missing.db"))).toEqual({
      exists: false,
      dimensions: null,
      embeddingModel: null,
      memoryCount: 0,
      experienceCount: 0,
    })
  })

  test("getLibraryInfo reads schema and counts from a real library database", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "library.db")
    const { Database } = await import("bun:sqlite")
    const conn = new Database(dbPath, { create: true })
    conn.exec(`CREATE TABLE schema_version (embedding_dimensions INTEGER)`)
    conn.exec(
      `CREATE TABLE memory (id TEXT PRIMARY KEY, title TEXT, content TEXT, category TEXT, recall_mode TEXT, embedding_model TEXT, created_at INTEGER, updated_at INTEGER)`,
    )
    conn.exec(
      `CREATE TABLE experience (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, intent TEXT, intent_embedding_model TEXT, script_embedding_model TEXT, source_provider_id TEXT, source_model_id TEXT, reward REAL, rewards TEXT, q_values TEXT, q_visits INTEGER, q_updated_at INTEGER, q_history TEXT, retrieved_experience_ids TEXT, reward_status TEXT, turns_remaining INTEGER, created_at INTEGER, updated_at INTEGER)`,
    )
    conn.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
    conn.exec(
      `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', 'xenova', 1, 2), ('m2', 't2', 'c2', 'coding', 'always', 'xenova', 1, 2)`,
    )
    conn.close()

    const info = await getLibraryInfo(dbPath)
    expect(info).toMatchObject({
      exists: true,
      dimensions: 384,
      embeddingModel: "xenova",
      memoryCount: 2,
      experienceCount: 0,
    })
  })

  test("mergeLibraryDB merges text rows and drops vectors under text_only", async () => {
    await using tmp = await tmpdir()
    const { Database } = await import("bun:sqlite")
    const schema = `
      CREATE TABLE schema_version (embedding_dimensions INTEGER);
      CREATE TABLE memory (id TEXT PRIMARY KEY, title TEXT, content TEXT, category TEXT, recall_mode TEXT, embedding_model TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, intent TEXT, intent_embedding_model TEXT, script_embedding_model TEXT, source_provider_id TEXT, source_model_id TEXT, reward REAL, rewards TEXT, q_values TEXT, q_visits INTEGER, q_updated_at INTEGER, q_history TEXT, retrieved_experience_ids TEXT, reward_status TEXT, turns_remaining INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience_content (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, user_input TEXT, script TEXT, raw TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);
    `
    const sourcePath = path.join(tmp.path, "source.db")
    const targetPath = path.join(tmp.path, "target.db")
    const source = new Database(sourcePath, { create: true })
    source.exec(schema)
    source.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
    source.exec(
      `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', NULL, 1, 2)`,
    )
    source.exec(
      `INSERT INTO experience (id, session_id, scope_id, intent, intent_embedding_model, script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits, q_updated_at, q_history, retrieved_experience_ids, reward_status, turns_remaining, created_at, updated_at) VALUES ('e1', 's', 'sc', 'i', NULL, NULL, NULL, NULL, NULL, '{}', '{}', 0, NULL, '{}', '{}', 'pending', NULL, 1, 2)`,
    )
    source.close()
    const target = new Database(targetPath, { create: true })
    target.exec(schema)
    target.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
    target.exec(
      `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', NULL, 1, 2), ('m9', 'x', 'y', 'coding', 'always', NULL, 1, 2)`,
    )
    target.close()

    const result = await mergeLibraryDB(sourcePath, targetPath, "text_only")
    expect(result).toEqual({
      memoriesMerged: 0,
      memoriesSkipped: 1,
      experiencesMerged: 1,
      experiencesSkipped: 0,
      vecDropped: true,
    })

    const verify = new Database(targetPath, { readonly: true })
    expect((verify.prepare("SELECT COUNT(*) as c FROM memory").get() as { c: number }).c).toBe(2)
    expect((verify.prepare("SELECT COUNT(*) as c FROM experience").get() as { c: number }).c).toBe(1)
    verify.close()
  })

  test("mergeLibraryDB counts conflicts as skipped under the skip strategy", async () => {
    await using tmp = await tmpdir()
    const { Database } = await import("bun:sqlite")
    const schema = `
      CREATE TABLE schema_version (embedding_dimensions INTEGER);
      CREATE TABLE memory (id TEXT PRIMARY KEY, title TEXT, content TEXT, category TEXT, recall_mode TEXT, embedding_model TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, intent TEXT, intent_embedding_model TEXT, script_embedding_model TEXT, source_provider_id TEXT, source_model_id TEXT, reward REAL, rewards TEXT, q_values TEXT, q_visits INTEGER, q_updated_at INTEGER, q_history TEXT, retrieved_experience_ids TEXT, reward_status TEXT, turns_remaining INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience_content (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, user_input TEXT, script TEXT, raw TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);
    `
    const sourcePath = path.join(tmp.path, "source.db")
    const targetPath = path.join(tmp.path, "target.db")
    const source = new Database(sourcePath, { create: true })
    source.exec(schema)
    source.exec(
      `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', NULL, 1, 2)`,
    )
    source.close()
    const target = new Database(targetPath, { create: true })
    target.exec(schema)
    target.exec(
      `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', NULL, 1, 2)`,
    )
    target.close()

    const result = await mergeLibraryDB(sourcePath, targetPath, "skip")
    expect(result.memoriesSkipped).toBe(1)
    expect(result.memoriesMerged).toBe(0)
    expect(result.vecDropped).toBe(false)
  })

  test("updateShellProfile writes and removeShellProfile removes a fish export line", async () => {
    await using tmp = await tmpdir()
    const fishConfig = path.join(tmp.path, "fish", "config.fish")
    await Bun.write(fishConfig, "set fish_greeting off\n")
    process.env.SHELL = "/usr/bin/fish"
    process.env.XDG_CONFIG_HOME = tmp.path

    const result = await updateShellProfile("/custom/home")
    expect(result).toEqual({ updated: true, file: fishConfig })
    const content = await Bun.file(fishConfig).text()
    expect(content).toContain(`set -gx SYNERGY_HOME "/custom/home"`)
    expect(content).toContain("# synergy")

    const second = await updateShellProfile("/other")
    expect(second.updated).toBe(false)

    const removed = await removeShellProfile()
    expect(removed).toEqual({ removed: true, file: fishConfig })
    const after = await Bun.file(fishConfig).text()
    expect(after).not.toContain("SYNERGY_HOME")
    expect(after).toContain("set fish_greeting off")
  })

  test("removeShellProfile reports nothing to remove when profiles are clean", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "fish", "config.fish"), "clean\n")
    process.env.SHELL = "/usr/bin/fish"
    process.env.XDG_CONFIG_HOME = tmp.path
    expect(await removeShellProfile()).toEqual({ removed: false, file: null })
  })

  test("updateShellProfile reports no candidate file when none exists", async () => {
    await using tmp = await tmpdir()
    process.env.SHELL = "/usr/bin/fish"
    process.env.XDG_CONFIG_HOME = tmp.path
    expect(await updateShellProfile("/custom/home")).toEqual({ updated: false, file: null })
  })

  test("dataRoot resolves to the global data path", () => {
    expect(dataRoot()).toBe(Global.Path.root)
  })
})

describe("data move command", () => {
  test("dry-run plans a move without touching the target", async () => {
    const { executeMove } = await import("../../src/cli/cmd/data/move")
    await using target = await tmpdir()
    const root = Global.Path.root
    await Bun.write(path.join(root, "data", "session.json"), "{}")
    try {
      await executeMove({ target: target.path, removeOriginal: false, dryRun: true })
      expect(await dirExists(path.join(target.path, ".synergy", "data"))).toBe(false)
    } finally {
      await Bun.file(path.join(root, "data", "session.json"))
        .delete()
        .catch(() => {})
    }
  })

  test("rejects a target equal to the current data root", async () => {
    const { executeMove } = await import("../../src/cli/cmd/data/move")
    await Bun.write(path.join(Global.Path.root, "data", "session.json"), "{}")
    try {
      await executeMove({ target: Global.Path.root, removeOriginal: false, dryRun: true })
    } finally {
      await Bun.file(path.join(Global.Path.root, "data", "session.json"))
        .delete()
        .catch(() => {})
    }
  })

  test("cancel at confirmation aborts before any copy", async () => {
    const { executeMove } = await import("../../src/cli/cmd/data/move")
    await using target = await tmpdir()
    clackState.confirmResult = "cancel"
    const root = Global.Path.root
    await Bun.write(path.join(root, "data", "session.json"), "{}")
    try {
      await executeMove({ target: target.path, removeOriginal: false, dryRun: false })
      expect(await dirExists(path.join(target.path, ".synergy", "data"))).toBe(false)
    } finally {
      await Bun.file(path.join(root, "data", "session.json"))
        .delete()
        .catch(() => {})
    }
  })

  test("executes a real move when confirmed", async () => {
    const { executeMove } = await import("../../src/cli/cmd/data/move")
    await using target = await tmpdir()
    const root = Global.Path.root
    await Bun.write(path.join(root, "data", "session.json"), "{}")
    try {
      await executeMove({ target: target.path, removeOriginal: false, dryRun: false })
      expect(await Bun.file(path.join(target.path, ".synergy", "data", "session.json")).text()).toBe("{}")
    } finally {
      await Bun.file(path.join(root, "data", "session.json"))
        .delete()
        .catch(() => {})
    }
  })
})

describe("data command registrations", () => {
  test("registers the data command tree and migrate alias", async () => {
    const { DataCommand, MigrateCommand } = await import("../../src/cli/cmd/data")
    expect(runBuilder(DataCommand)).toBeDefined()
    expect(runBuilder(MigrateCommand)).toBeDefined()
  })

  test("data path handler reports the data root", async () => {
    const { DataPathCommand } = await import("../../src/cli/cmd/data/path")
    process.env.SYNERGY_HOME = "/override"
    await runHandler(DataPathCommand)(handlerArgs({}) as never)
  })

  test("data set-home unset removes the shell profile entry", async () => {
    const { DataSetHomeCommand } = await import("../../src/cli/cmd/data/set-home")
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "fish", "config.fish"), "clean\n")
    process.env.SHELL = "/usr/bin/fish"
    process.env.XDG_CONFIG_HOME = tmp.path
    await runHandler(DataSetHomeCommand)(handlerArgs({ path: "/ignored", unset: true }) as never)
    expect(await Bun.file(path.join(tmp.path, "fish", "config.fish")).text()).toBe("clean\n")
  })

  test("data set-home detects when the target already holds the current home", async () => {
    const { DataSetHomeCommand } = await import("../../src/cli/cmd/data/set-home")
    const current = Global.Path.root
    const parent = current.slice(0, -"/.synergy".length)
    process.env.SYNERGY_HOME = parent
    await runHandler(DataSetHomeCommand)(handlerArgs({ path: parent, unset: false }) as never)
  })

  test("data merge merges a directory source into the current data root", async () => {
    const { DataMergeCommand } = await import("../../src/cli/cmd/data/merge")
    await using source = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "data", "file.txt"), "payload")
      },
    })
    const root = Global.Path.root
    await Bun.write(path.join(root, "data", "target.txt"), "{}")
    try {
      await runHandler(DataMergeCommand)(handlerArgs({ source: source.path }) as never)
      expect(await Bun.file(path.join(root, "data", "file.txt")).text()).toBe("payload")
    } finally {
      await Bun.file(path.join(root, "data", "file.txt"))
        .delete()
        .catch(() => {})
      await Bun.file(path.join(root, "data", "target.txt"))
        .delete()
        .catch(() => {})
    }
  })

  test("data merge aborts on a missing source", async () => {
    const { DataMergeCommand } = await import("../../src/cli/cmd/data/merge")
    await runHandler(DataMergeCommand)(
      handlerArgs({ source: path.join(Global.Path.root, "definitely-missing") }) as never,
    )
  })

  test("data pack cancels when multiselect is cancelled", async () => {
    const { DataPackCommand } = await import("../../src/cli/cmd/data/pack")
    clackState.multiselectResult = "cancel"
    await runHandler(DataPackCommand)(handlerArgs({ output: "" }) as never)
  })
})
