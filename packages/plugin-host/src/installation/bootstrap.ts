import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { InstallationPin } from "@ericsanchezok/synergy-util/installed-launcher"
import { InstallationGenerations, type InstalledGeneration } from "./generations"
import { prepareInstallation } from "./manager"
import { assertHarnessIdentity } from "./component-loader"

export async function prepareInstalledLaunch(
  root: string,
  options: {
    version: string
    pin?: string
    basePackages?: Record<string, string>
    seed?: string
  },
) {
  if (options.pin) {
    const generation = await InstallationGenerations.pin(root, InstallationPin.parse(JSON.parse(options.pin)))
    await assertHarnessIdentity(generation)
    return generation
  }
  let generation = await InstallationGenerations.current(root)
  if (!generation) {
    if (options.seed) {
      const seed = await InstallationGenerations.readSeed(options.seed)
      const directory = await InstallationGenerations.stage(root)
      try {
        await fs.cp(seed.directory, directory, {
          recursive: true,
          verbatimSymlinks: true,
          filter: (filename) => filename !== path.join(seed.directory, "generation.json"),
        })
        generation = await InstallationGenerations.commit(root, {
          directory,
          hostVersion: seed.hostVersion,
          roots: seed.roots,
          packages: seed.packages,
          trustHostCode: true,
        })
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    } else {
      await using prepared = await prepareInstallation(root, {
        hostVersion: options.version,
        basePackages: options.basePackages ?? { "@ericsanchezok/synergy-cli": options.version },
      })
      generation = await prepared.commit({ trustHostCode: true })
    }
  }
  const minimum = generation.minimumVersions["host:core"]
  if (options.version !== "local" && minimum && minimum !== "local" && Bun.semver.order(options.version, minimum) < 0)
    throw new Error(`This home requires Synergy ${minimum} or newer; upgrade the launcher before opening it`)
  await assertHarnessIdentity(generation)
  return generation
}

export async function verifyInstalledWorkerPlan(generation: InstalledGeneration, serialized: string | undefined) {
  if (!serialized) throw new Error("An installed component worker requires its pinned composition")
  const entry = z.object({ id: z.string(), version: z.string(), entry: z.url() }).strict()
  const plan = z
    .object({ apiVersion: z.literal(1), agent: z.array(entry), policy: z.array(entry) })
    .strict()
    .parse(JSON.parse(serialized))
  for (const item of [...plan.agent, ...plan.policy]) {
    const url = new URL(item.entry)
    if (url.protocol !== "file:") throw new Error("Worker entry must be a sealed local module")
    const filename = await fs.realpath(fileURLToPath(url))
    const relative = path.relative(generation.directory, filename).split(path.sep).join("/")
    if (generation.files[relative]?.kind !== "file") throw new Error("Worker entry escapes its pinned generation")
    const pkg = Object.values(generation.packages).find(
      (pkg) => pkg.metadata?.kind === "component" && pkg.metadata.id === item.id,
    )
    const version =
      pkg?.version ?? (["local-runtime", "plugin-host"].includes(item.id) ? generation.hostVersion : undefined)
    if (version !== item.version) throw new Error(`Worker component version is not installed: ${item.id}`)
  }
}
