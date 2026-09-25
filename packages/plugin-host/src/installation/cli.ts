import * as prompts from "@clack/prompts"
import type { Argv } from "yargs"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import { UI } from "@ericsanchezok/synergy-util/terminal"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { prepareInstallation, listInstalledPackages } from "./manager"
import { InstallationGenerations } from "./generations"
import { preparePluginActivation, activateInstalledPlugins } from "./plugin-activation"
import * as Lockfile from "../plugin/lockfile"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageMaintenance } from "@ericsanchezok/synergy-harness/storage/maintenance"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"

interface ChangeOptions {
  sources?: readonly string[]
  remove?: readonly string[]
  update?: readonly string[]
  updateAll?: boolean
  trustHostCode?: boolean
  approvePlugin?: readonly string[]
  resume?: boolean
  pluginOnly?: boolean
}

export async function changeInstalledPackages(options: ChangeOptions) {
  if (Installation.isLocal())
    throw new Error(
      "Source runtimes compose components explicitly. Use an installed synergy CLI for package management, or plugin add for API4 development.",
    )
  const root = RuntimeContext.current().host.root
  await ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      if (options.resume) {
        const current = await InstallationGenerations.current(root)
        if (!current) throw new Error("There is no installation to resume")
        await using storage = Storage.available() ? undefined : await StorageMaintenance.open()
        await activateInstalledPlugins(current)
        UI.println("Installation activation completed.")
        return
      }
      const previous = await InstallationGenerations.current(root)
      const basePackages = previous
        ? Object.fromEntries(
            Object.entries(previous.packages)
              .filter(([, pkg]) => !pkg.metadata)
              .map(([name, pkg]) => [name, pkg.spec]),
          )
        : { "@ericsanchezok/synergy-cli": Installation.VERSION }
      await using plan = await prepareInstallation(root, {
        ...options,
        basePackages,
        hostVersion: Installation.VERSION,
      })
      if (
        options.pluginOnly &&
        Object.keys(plan.roots).some(
          (name) => !Object.hasOwn(previous?.roots ?? {}, name) && plan.packages[name]?.metadata?.kind !== "plugin",
        )
      )
        throw new Error("Use synergy install for components, presets and applications")
      for (const change of plan.changes)
        UI.println(
          `${change.action} ${change.kind} ${change.id} ${change.previousVersion ? change.previousVersion + " → " : ""}${change.version}`,
        )
      const hostPackages = Object.values(plan.packages).filter(
        (pkg) => pkg.metadata?.kind === "component" || pkg.metadata?.kind === "app",
      )
      if (hostPackages.length && !options.trustHostCode) {
        UI.println("Host code: " + hostPackages.map((pkg) => `${pkg.metadata!.id}@${pkg.version}`).join(", "))
        if (
          !process.stdin.isTTY ||
          (await prompts.confirm({ message: "Trust this component and application code with host privileges?" })) !==
            true
        )
          throw new Error("Host code trust is required; review the selection and pass --trust-host-code")
      }
      const plugins = [...Object.values(plan.packages), ...Object.values(previous?.packages ?? {})].some(
        (pkg) => pkg.metadata?.kind === "plugin",
      )
      await using storage = plugins && !Storage.available() ? await StorageMaintenance.open() : undefined
      if (plugins)
        await preparePluginActivation(plan, async (plugin) => {
          UI.println(
            `Plugin ${plugin.id}@${plugin.version} capability grant:\n${JSON.stringify(plugin.grant, null, 2)}`,
          )
          return (
            options.approvePlugin?.includes(plugin.id) === true ||
            (process.stdin.isTTY === true &&
              (await prompts.confirm({ message: `Approve these capabilities for ${plugin.id}?` })) === true)
          )
        })
      const { prepareApplications } = await import("./applications")
      await prepareApplications(plan.directory, plan.packages, { previous })
      const generation = await plan.commit({ trustHostCode: true })
      if (plugins) await activateInstalledPlugins(generation)
      UI.println("Installation completed. New component selections apply on the next start.")
    },
  })
}

export async function managedPackage(id: string) {
  return (await listInstalledPackages(RuntimeContext.current().host.root)).find(
    (pkg) => pkg.id === id || pkg.name === id,
  )
}

export const InstallCommand = cmd({
  command: "install [spec..]",
  describe: "install components, presets, plugins or applications",
  builder: (yargs: Argv) =>
    yargs
      .option("trust-host-code", {
        type: "boolean",
        default: false,
        describe: "trust the resolved component and application code to run with host privileges",
      })
      .option("approve-plugin", {
        type: "array",
        string: true,
        describe: "approve the displayed API4 capability grant for these plugin ids",
      })
      .positional("spec", {
        type: "string",
        array: true,
        describe: "built-in name, npm spec, Git URL, local directory or archive",
      })
      .option("resume", { type: "boolean", default: false, describe: "finish an interrupted plugin activation" }),
  async handler(args) {
    if (!args.resume && !(args.spec as string[] | undefined)?.length)
      throw new Error("Provide a package source or --resume")
    await changeInstalledPackages({
      sources: args.spec as string[] | undefined,
      resume: args.resume,
      trustHostCode: args.trustHostCode,
      approvePlugin: args.approvePlugin as string[] | undefined,
    })
  },
})

async function legacyPlugins() {
  if (Storage.available()) return (await Lockfile.read()).plugins
  const runtime = RuntimeContext.current()
  const handle = await StorageBootstrap.inspect(runtime.host.root)
  if (!handle) return {}
  runtime.storage = handle
  try {
    return (await Lockfile.read()).plugins
  } finally {
    runtime.storage = undefined
    await handle.store.close()
  }
}

export const PackageUpdateCommand = cmd({
  command: "update [name..]",
  describe: "update explicitly installed packages (all when no name is given)",
  builder: (yargs: Argv) =>
    yargs
      .option("trust-host-code", {
        type: "boolean",
        default: false,
        describe: "trust the resolved component and application code to run with host privileges",
      })
      .option("approve-plugin", {
        type: "array",
        string: true,
        describe: "approve the displayed API4 capability grant for these plugin ids",
      })
      .positional("name", { type: "string", array: true }),
  async handler(args) {
    const names = args.name as string[] | undefined
    await changeInstalledPackages({
      update: names,
      updateAll: !names?.length,
      trustHostCode: args.trustHostCode,
      approvePlugin: args.approvePlugin as string[] | undefined,
    })
  },
})

export const PackageRemoveCommand = cmd({
  command: "remove <name..>",
  describe: "remove explicitly installed packages and unused dependencies",
  builder: (yargs: Argv) => yargs.positional("name", { type: "string", array: true, demandOption: true }),
  async handler(args) {
    await changeInstalledPackages({ remove: args.name as string[], trustHostCode: true })
  },
})

export const PackageListCommand = cmd({
  command: "list",
  describe: "list installed packages and legacy plugins",
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    const packages = await listInstalledPackages(RuntimeContext.current().host.root)
    const plugins = await legacyPlugins()
    const legacy = Object.entries(plugins)
      .filter(([id]) => !packages.some((pkg) => pkg.kind === "plugin" && pkg.id === id))
      .map(([id, entry]) => ({ name: id, id, kind: "plugin", version: entry.version, explicit: true, requiredBy: [] }))
    const installed = [...packages, ...legacy]
    if (args.json) console.log(JSON.stringify(installed, null, 2))
    else if (!installed.length) UI.println(`core ${Installation.VERSION}`)
    else
      for (const pkg of installed)
        UI.println(
          `${pkg.kind} ${pkg.id}@${pkg.version}${pkg.explicit ? "" : ` (required by ${pkg.requiredBy.join(", ")})`}`,
        )
  },
})

export const DesktopCommand = cmd({
  command: "desktop",
  describe: "open the installed Synergy Desktop application",
  async handler() {
    const generation = await InstallationGenerations.current(RuntimeContext.current().host.root)
    if (
      !generation ||
      !Object.values(generation.packages).some(
        (pkg) => pkg.metadata?.kind === "app" && pkg.metadata.id === "desktop-app",
      )
    )
      throw new Error("Desktop is not installed; run synergy install desktop")
    await (await import("./applications")).launchInstalledApplication(generation, "desktop-app")
  },
})
