import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { InstallationPin } from "@ericsanchezok/synergy-util/installed-launcher"
import { InstallationGenerations, type InstalledGeneration } from "./generations"
import { prepareInstallation } from "./manager"
import { assertHarnessIdentity } from "./component-loader"
import { seedInstalledCore, canSeedInstalledCore } from "./seed"
import { initializeInstallationSelection } from "./selection"
import { upgradeInstallationRoots, preservePluginActivation } from "./upgrade"

export async function prepareInstalledLaunch(
  root: string,
  options: {
    version: string
    pin?: string
    basePackages?: Record<string, string>
    seed?: string
    installedCore?: string
    resume?: boolean
  },
) {
  if (options.pin) {
    const generation = await InstallationGenerations.pin(root, InstallationPin.parse(JSON.parse(options.pin)))
    await assertHarnessIdentity(generation)
    return generation
  }
  let generation = await InstallationGenerations.current(root)
  const minimum = generation?.minimumVersions["host:core"]
  if (options.version !== "local" && minimum && minimum !== "local" && Bun.semver.order(options.version, minimum) < 0)
    throw new Error(`This home requires Synergy ${minimum} or newer; upgrade the launcher before opening it`)
  if (!generation || (!options.resume && Bun.semver.order(options.version, generation.hostVersion) > 0)) {
    const seed = options.seed ? await InstallationGenerations.readSeed(options.seed) : undefined
    if (seed && seed.hostVersion !== options.version)
      throw new Error("The bundled modules do not match the launcher version")
    const roots = generation
      ? upgradeInstallationRoots(generation, options.version)
      : Object.fromEntries(
          (await initializeInstallationSelection(root, Object.keys(seed?.roots ?? {}))).map((name) => [
            name,
            options.version,
          ]),
        )
    const cliDirectory = seed
      ? path.join(seed.directory, "node_modules/@ericsanchezok/synergy-cli")
      : options.installedCore
    const hasActivation = Object.values(generation?.packages ?? {}).some(
      (pkg) => pkg.metadata?.kind === "plugin" || pkg.metadata?.kind === "app",
    )
    if (cliDirectory && !hasActivation && (await canSeedInstalledCore(cliDirectory, roots))) {
      generation = await seedInstalledCore(root, cliDirectory, options.version, { roots, previous: generation?.id })
    } else {
      await using prepared = await prepareInstallation(root, {
        hostVersion: options.version,
        basePackages: options.basePackages ?? { "@ericsanchezok/synergy-cli": options.version },
        sources: Object.entries(roots)
          .filter(([name, spec]) => generation?.roots[name] !== spec)
          .map(([name, spec]) => `${name}@${spec}`),
      })
      await preservePluginActivation(prepared, options.version)
      await (
        await import("./applications")
      ).prepareApplications(prepared.directory, prepared.packages, { previous: prepared.previous })
      generation = await prepared.commit({ trustHostCode: true })
    }
  }
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
