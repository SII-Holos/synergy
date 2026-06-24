import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Embedding } from "../../vector/embedding"

export const EmbedCommand = cmd({
  command: "embed",
  describe: "manage the local embedding model",
  builder: (yargs) => yargs.command(EmbedDownloadCommand).demandCommand(),
  async handler() {},
})

export const EmbedDownloadCommand = cmd({
  command: "download",
  describe: "download the local embedding model (used when no remote embedding API is configured)",
  async handler() {
    UI.empty()
    prompts.intro("Embedding Model Download")

    prompts.log.info("Model: Xenova/all-MiniLM-L6-v2")
    prompts.log.info("Size:  ~80 MB")
    prompts.log.info(
      "This model runs locally and is used automatically when no remote embedding API key is configured.",
    )
    prompts.log.info("After a successful download, subsequent sessions start instantly.")
    UI.empty()

    const spinner = prompts.spinner()
    spinner.start("Downloading embedding model from Hugging Face Hub...")

    try {
      await Embedding.warmup()
      spinner.stop("✓ Embedding model ready")
      prompts.log.success("Local embedding model is downloaded and ready.")
    } catch (err) {
      spinner.stop("✗ Download failed", 1)
      prompts.log.error(`Failed to download: ${err instanceof Error ? err.message : String(err)}`)
      prompts.log.info("Troubleshooting:")
      prompts.log.info("  1. Check your network connection")
      prompts.log.info("  2. Ensure Hugging Face Hub (huggingface.co) is reachable")
      prompts.log.info("  3. Or configure a remote embedding API: synergy config embedding")
    }

    prompts.outro("Done")
  },
})
