import { ConfigMarkdown } from "@/config/markdown"
import { Config } from "../config/config"
import { MCP } from "../mcp"
import { Provider } from "../provider/provider"
import { UI } from "./ui"

function summarizeConfigJsonError(message?: string) {
  if (!message) return
  const errorsSection = message.split("--- Errors ---\n")[1]?.split("\n--- End ---")[0]?.trim()
  if (errorsSection) return errorsSection
  return message
}

export function FormatError(input: unknown) {
  if (MCP.Failed.isInstance(input))
    return `MCP server "${input.data.name}" failed. Note, synergy does not support MCP authentication yet.`
  if (Provider.ModelNotFoundError.isInstance(input)) {
    const { providerID, modelID, suggestions } = input.data
    return [
      `Model not found: ${providerID}/${modelID}`,
      ...(Array.isArray(suggestions) && suggestions.length ? ["Did you mean: " + suggestions.join(", ")] : []),
      `Try: \`synergy models\` to list available models`,
      `Or check your config (synergy.json) provider/model names`,
    ].join("\n")
  }
  if (Provider.InitError.isInstance(input)) {
    return `Failed to initialize provider "${input.data.providerID}". Check credentials and configuration.`
  }
  if (Config.JsonError.isInstance(input)) {
    const details = summarizeConfigJsonError(input.data.message)
    return [
      `Config file at ${input.data.path} is not valid JSON(C).`,
      ...(details ? [details] : []),
      `Tip: fix the config syntax or move the invalid file aside, then rerun the command.`,
    ].join("\n")
  }
  if (Config.ConfigDirectoryTypoError.isInstance(input)) {
    return `Directory "${input.data.dir}" in ${input.data.path} is not valid. Rename the directory to "${input.data.suggestion}" or remove it. This is a common typo.`
  }
  if (ConfigMarkdown.FrontmatterError.isInstance(input)) {
    return `Failed to parse frontmatter in ${input.data.path}:\n${input.data.message}`
  }
  if (Config.InvalidError.isInstance(input))
    return [
      `Configuration is invalid${input.data.path && input.data.path !== "config" ? ` at ${input.data.path}` : ""}` +
        (input.data.message ? `: ${input.data.message}` : ""),
      ...(input.data.issues?.map(
        (issue) => "↳ " + issue.message + (issue.path.length ? ` (${issue.path.join(".")})` : ""),
      ) ?? []),
      `Tip: this often happens after upgrading from an older config format. Review the invalid fields and try again.`,
    ].join("\n")

  if (UI.CancelledError.isInstance(input)) return ""
}

export function FormatUnknownError(input: unknown): string {
  if (input instanceof Error) {
    return input.stack ?? `${input.name}: ${input.message}`
  }

  if (typeof input === "object" && input !== null) {
    try {
      return JSON.stringify(input, null, 2)
    } catch {
      return "Unexpected error (unserializable)"
    }
  }

  return String(input)
}
