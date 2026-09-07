import { SnapshotArchive } from "../../../session/snapshot-archive"
import fs from "fs/promises"
import path from "path"
import os from "os"
import * as prompts from "@clack/prompts"
import { cmd } from "../cmd"
import { UI } from "../../../util/ui"
import {
  archiveExclusions,
  copyDirSkipExisting,
  CATEGORIES,
  scanCategories,
  formatSize,
  shortenPath,
  dataRoot,
  getLibraryInfo,
  resolveLibraryDB,
} from "./shared"

export const DataPackCommand = cmd({
  command: "pack [output]",
  describe: "pack synergy data into a zip archive",
  builder: (yargs) =>
    yargs.positional("output", {
      type: "string",
      describe: "output zip file path",
      default: "",
    }),
  handler: async (args) => {
    const root = dataRoot()
    const outputArg = args.output as string

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Pack Synergy Data")

    const catStats = await scanCategories(root)
    let totalSize = 0
    for (const stats of catStats.values()) totalSize += stats.size

    prompts.log.info(`Location: ${shortenPath(root)} (${formatSize(totalSize)})`)

    // Step 1: Select categories
    const selectable = CATEGORIES.filter((c) => !c.required)
    const selected = await prompts.multiselect({
      message: "What should be packed? (Space to toggle, Enter to confirm)",
      options: selectable.map((cat) => ({
        value: cat.key,
        label: cat.label,
        hint: formatSize(catStats.get(cat.key)?.size ?? 0),
      })),
      initialValues: selectable.filter((c) => c.defaultValue).map((c) => c.key),
      required: false,
    })
    if (prompts.isCancel(selected)) {
      prompts.cancel("Cancelled")
      return
    }

    const selectedKeys = new Set([...(selected as string[]), ...CATEGORIES.filter((c) => c.required).map((c) => c.key)])
    const selectedCategories = CATEGORIES.filter((c) => selectedKeys.has(c.key))

    // Step 2: Determine output path
    const dateStr = new Date().toISOString().slice(0, 10)
    const defaultName = `synergy-data-${dateStr}.zip`
    const outputPath = outputArg
      ? path.resolve(outputArg.endsWith(".zip") ? outputArg : `${outputArg}.zip`)
      : path.join(os.homedir(), defaultName)

    // Step 3: Build manifest
    const libraryInfo = await getLibraryInfo(await resolveLibraryDB(root))
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      library: libraryInfo.exists
        ? {
            dimensions: libraryInfo.dimensions,
            embeddingModel: libraryInfo.embeddingModel,
            memoryCount: libraryInfo.memoryCount,
            experienceCount: libraryInfo.experienceCount,
          }
        : null,
    }

    // Step 4: Pack
    const spinner = prompts.spinner()
    spinner.start("Packing data...")

    try {
      const packed = await createDataArchive(
        root,
        outputPath,
        selectedCategories.flatMap((category) => category.subdirs),
        manifest,
      )
      const packedSize = (await fs.stat(packed)).size
      spinner.stop(`Packed to ${shortenPath(packed)} (${formatSize(packedSize)})`)
    } catch (e) {
      spinner.stop("Packing failed", 1)
      prompts.log.error(`Failed to pack: ${e instanceof Error ? e.message : String(e)}`)
      prompts.outro("Failed")
      return
    }

    prompts.outro("Done")
  },
})

export async function createDataArchive(root: string, output: string, directories: string[], manifest: unknown) {
  await using homes = await SnapshotArchive.lockHomes([root])
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-pack-"))
  try {
    await Bun.write(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2))
    const included = ["manifest.json"]
    for (const directory of directories) {
      const source = path.join(root, directory)
      const exists = await fs.stat(source).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false
          throw error
        },
      )
      if (!exists) continue
      const destination = path.join(stage, directory)
      if (directory === "data") await SnapshotArchive.merge(source, destination)
      await copyDirSkipExisting(source, destination, undefined, undefined, undefined, archiveExclusions(directory))
      included.push(directory)
    }
    const zip = Bun.which("zip")
    const filename = zip ? output : output.replace(/\.zip$/, ".tar.gz")
    await fs.mkdir(path.dirname(filename), { recursive: true })
    const temporary = path.join(
      path.dirname(filename),
      `.synergy-pack-${crypto.randomUUID()}${zip ? ".zip" : ".tar.gz"}`,
    )
    try {
      const command = zip ? [zip, "-q", "-r", temporary, ...included] : ["tar", "-czf", temporary, ...included]
      const child = Bun.spawn(command, { cwd: stage, stdout: "ignore", stderr: "pipe" })
      const errors = new Response(child.stderr).text()
      if ((await child.exited) !== 0) throw new Error(`Archive creation failed: ${await errors}`)
      await errors
      await fs.rename(temporary, filename)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return filename
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}
