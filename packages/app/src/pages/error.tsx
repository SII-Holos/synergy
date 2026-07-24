import { Component } from "solid-js"
import { usePlatform } from "@/context/platform"
import { ErrorPageContent } from "./error-page-content"

export type InitError = {
  name: string
  data: Record<string, unknown>
}

function isInitError(error: unknown): error is InitError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "data" in error &&
    typeof (error as InitError).data === "object"
  )
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString()
      if (typeof val === "object" && val) {
        if (seen.has(val)) return "[Circular]"
        seen.add(val)
      }
      return val
    },
    2,
  )
  return json ?? String(value)
}

function formatInitError(error: InitError): string {
  const data = error.data
  switch (error.name) {
    case "MCPFailed":
      return `MCP server "${data.name}" failed. Check the server configuration, authentication state, and connection details.`
    case "ProviderAuthError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : "unknown"
      const message = typeof data.message === "string" ? data.message : safeJson(data.message)
      return `Provider authentication failed (${providerID}): ${message}`
    }
    case "APIError": {
      const message = typeof data.message === "string" ? data.message : "API error"
      const lines: string[] = [message]

      if (typeof data.statusCode === "number") {
        lines.push(`Status: ${data.statusCode}`)
      }

      if (typeof data.isRetryable === "boolean") {
        lines.push(`Retryable: ${data.isRetryable}`)
      }

      if (typeof data.responseBody === "string" && data.responseBody) {
        lines.push(`Response body:\n${data.responseBody}`)
      }

      return lines.join("\n")
    }
    case "ProviderModelNotFoundError": {
      const { providerID, modelID, suggestions } = data as {
        providerID: string
        modelID: string
        suggestions?: string[]
      }
      return [
        `Model not found: ${providerID}/${modelID}`,
        ...(Array.isArray(suggestions) && suggestions.length ? ["Did you mean: " + suggestions.join(", ")] : []),
        `Check your Models and Providers configuration for provider/model names`,
      ].join("\n")
    }
    case "ProviderInitError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : "unknown"
      return `Failed to initialize provider "${providerID}". Check credentials and configuration.`
    }
    case "ConfigJsonError": {
      const message = typeof data.message === "string" ? data.message : ""
      return `Config file at ${data.path} is not valid JSON(C)` + (message ? `: ${message}` : "")
    }
    case "ConfigDirectoryTypoError":
      return `Directory "${data.dir}" in ${data.path} is not valid. Rename the directory to "${data.suggestion}" or remove it. This is a common typo.`
    case "ConfigFrontmatterError":
      return `Failed to parse frontmatter in ${data.path}:\n${data.message}`
    case "ConfigInvalidError": {
      const issues = Array.isArray(data.issues)
        ? data.issues.map(
            (issue: { message: string; path: string[] }) => "↳ " + issue.message + " " + issue.path.join("."),
          )
        : []
      const message = typeof data.message === "string" ? data.message : ""
      return [`Config file at ${data.path} is invalid` + (message ? `: ${message}` : ""), ...issues].join("\n")
    }
    case "UnknownError":
      return typeof data.message === "string" ? data.message : safeJson(data)
    default:
      if (typeof data.message === "string") return data.message
      return safeJson(data)
  }
}

function formatErrorChain(error: unknown, depth = 0, parentMessage?: string): string {
  if (!error) return "Unknown error"

  if (isInitError(error)) {
    const message = formatInitError(error)
    if (depth > 0 && parentMessage === message) return ""
    const indent = depth > 0 ? `\n${"─".repeat(40)}\nCaused by:\n` : ""
    return indent + `${error.name}\n${message}`
  }

  if (error instanceof Error) {
    const isDuplicate = depth > 0 && parentMessage === error.message
    const parts: string[] = []
    const indent = depth > 0 ? `\n${"─".repeat(40)}\nCaused by:\n` : ""

    const header = `${error.name}${error.message ? `: ${error.message}` : ""}`
    const stack = error.stack?.trim()

    if (stack) {
      const startsWithHeader = stack.startsWith(header)

      if (isDuplicate && startsWithHeader) {
        const trace = stack.split("\n").slice(1).join("\n").trim()
        if (trace) {
          parts.push(indent + trace)
        }
      }

      if (isDuplicate && !startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && !startsWithHeader) {
        parts.push(indent + `${header}\n${stack}`)
      }
    }

    if (!stack && !isDuplicate) {
      parts.push(indent + header)
    }

    if (error.cause) {
      const causeResult = formatErrorChain(error.cause, depth + 1, error.message)
      if (causeResult) {
        parts.push(causeResult)
      }
    }

    return parts.join("\n\n")
  }

  if (typeof error === "string") {
    if (depth > 0 && parentMessage === error) return ""
    const indent = depth > 0 ? `\n${"─".repeat(40)}\nCaused by:\n` : ""
    return indent + error
  }

  const indent = depth > 0 ? `\n${"─".repeat(40)}\nCaused by:\n` : ""
  return indent + safeJson(error)
}

function formatError(error: unknown): string {
  return formatErrorChain(error, 0)
}

interface ErrorPageProps {
  error: unknown
}

export const ErrorPage: Component<ErrorPageProps> = (props) => {
  const platform = usePlatform()

  return <ErrorPageContent details={formatError(props.error)} version={platform.version} onReload={platform.restart} />
}
