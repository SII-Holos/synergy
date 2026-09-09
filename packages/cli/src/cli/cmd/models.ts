import type { Argv } from "yargs"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ModelsCatalog } from "@ericsanchezok/synergy-harness/provider/models"
import { cmd } from "./cmd"
import { UI } from "../../util/ui"
import { EOL } from "os"
import { ProviderCatalog } from "@ericsanchezok/synergy-harness/provider/catalog"

export const ModelsCommand = cmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs: Argv) => {
    return yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      })
  },
  handler: async (args) => {
    if (args.refresh) {
      const result = await ModelsCatalog.refresh()
      if (result.status !== "refreshed") {
        UI.error(
          result.status === "disabled"
            ? "Provider catalog refresh is disabled by SYNERGY_DISABLE_MODELS_FETCH."
            : "Provider catalog refresh failed: no source returned a usable catalog. The existing cache was kept.",
        )
        process.exitCode = 1
        return
      }
      await ProviderCatalog.resolve({ forceRefresh: true, includeLive: true })
      if (result.rejectedProviders || result.rejectedModels) {
        UI.println(`Skipped ${result.rejectedProviders} invalid providers and ${result.rejectedModels} invalid models.`)
      }
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Provider catalog refreshed" + UI.Style.TEXT_NORMAL)
    }

    await ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const providers = await Provider.list()

        function printModels(providerID: string, verbose?: boolean) {
          const provider = providers[providerID]
          const sortedModels = Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))
          for (const [modelID, model] of sortedModels) {
            process.stdout.write(`${providerID}/${modelID}`)
            process.stdout.write(EOL)
            if (verbose) {
              process.stdout.write(JSON.stringify(model, null, 2))
              process.stdout.write(EOL)
            }
          }
        }

        if (args.provider) {
          const provider = providers[args.provider]
          if (!provider) {
            UI.error(`Provider not found: ${args.provider}`)
            return
          }

          printModels(args.provider, args.verbose)
          return
        }

        const providerIDs = Object.keys(providers).sort((a, b) => {
          const aIsSii = a.startsWith("sii-")
          const bIsSii = b.startsWith("sii-")
          if (aIsSii && !bIsSii) return -1
          if (!aIsSii && bIsSii) return 1
          return a.localeCompare(b)
        })

        for (const providerID of providerIDs) {
          printModels(providerID, args.verbose)
        }
      },
    })
  },
})
