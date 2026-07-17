import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Embedding } from "../../vector/embedding"

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function sourceName(source: Embedding.LocalStatus["source"]) {
  if (source === "huggingface") return "Hugging Face Hub"
  if (source === "hf-mirror") return "HF Mirror"
  return "custom source"
}

function progressMessage(status: Embedding.LocalStatus) {
  if (!status.progress) return status.asset === "cached" ? "Loading cached embedding model..." : "Preparing download..."
  const percent = Math.round(status.progress.percent)
  if (!status.progress.totalBytes) return `Downloading embedding model... ${percent}%`
  return `Downloading ${formatSize(status.progress.loadedBytes)} / ${formatSize(status.progress.totalBytes)} (${percent}%)`
}

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

    const initial = await Embedding.status()
    if (initial.mode === "remote") {
      prompts.log.info(`Remote embedding model configured: ${initial.model}`)
      prompts.log.info("The bundled local model is not used while a remote embedding API key is configured.")
      prompts.outro("No download needed")
      return
    }

    const spinner = prompts.spinner()
    spinner.start(`Downloading embedding model from ${sourceName(initial.source)}...`)

    let failure: unknown
    let settled = false
    const download = Embedding.warmup()
      .catch((error) => {
        failure = error
      })
      .finally(() => {
        settled = true
      })

    while (!settled) {
      await Bun.sleep(250)
      const status = await Embedding.status()
      if (status.mode === "local") spinner.message(progressMessage(status))
    }
    await download

    if (failure) {
      spinner.stop("✗ Download failed", 1)
      prompts.log.error(`Failed to download: ${failure instanceof Error ? failure.message : String(failure)}`)
      prompts.log.info("Troubleshooting:")
      prompts.log.info("  1. Check your network connection")
      prompts.log.info("  2. Check the configured local embedding download source")
      prompts.log.info("  3. Or configure a remote embedding API: synergy config embedding")
    } else {
      spinner.stop("✓ Embedding model ready")
      prompts.log.success("Local embedding model is downloaded and ready.")
    }

    prompts.outro("Done")
  },
})
