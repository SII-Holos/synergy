import z from "zod"
import { classifyNetworkError, isRetryableHttpStatus } from "@ericsanchezok/synergy-util/network-error"
import { retry, retryAfterMs } from "@ericsanchezok/synergy-util/retry"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { ToolTimeout } from "@ericsanchezok/synergy-harness/tool/timeout"
import { SearchGuard } from "@ericsanchezok/synergy-harness/tool/search-guard"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = ToolTimeout.DEFAULTS.webfetchMs
const MAX_TIMEOUT = ToolTimeout.DEFAULTS.webfetchMaxMs

class WebFetchHTTPError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseHeaders: Headers,
  ) {
    const failureType = SearchGuard.classifyHttpStatus(statusCode) ?? "blocked_or_unavailable"
    super(`Request failed with status code: ${statusCode} (${failureType})`)
  }
}

export const WebFetchTool = Tool.define("webfetch", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("The URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("The format to return the content in (text, markdown, or html). Defaults to markdown."),
    timeout: z.number().describe("Optional timeout in seconds (max 120)").optional(),
  }),
  async execute(params, ctx) {
    ctx.abort.throwIfAborted()
    // Validate URL
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    const searchScope = String((ctx.extra as any)?.userMessageID ?? ctx.sessionID)
    const duplicate = SearchGuard.checkDuplicate(searchScope, "webfetch", params)
    if (duplicate) {
      return {
        output: duplicate.output,
        title: `Web fetch skipped: ${params.url}`,
        metadata: {
          searchFailureType: "duplicate_query" as const,
          url: params.url,
          contentType: "",
          contentLength: 0,
        } as any,
      }
    }

    await ctx.ask({
      permission: "webfetch",
      patterns: [params.url],
      metadata: {
        url: params.url,
        format: params.format,
        timeout: params.timeout,
      },
    })
    SearchGuard.recordAttempt(searchScope, "webfetch", params)

    const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeout)
    const signal = AbortSignal.any([controller.signal, ctx.abort])

    // Build Accept header based on requested format with q parameters for fallbacks
    let acceptHeader = "*/*"
    switch (params.format) {
      case "markdown":
        acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
        break
      case "text":
        acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        break
      case "html":
        acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
        break
      default:
        acceptHeader =
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    }

    const page = await (async () => {
      try {
        return await retry(
          async () => {
            const response = await fetch(params.url, {
              signal,
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Accept: acceptHeader,
                "Accept-Language": "en-US,en;q=0.9",
              },
            })
            if (!response.ok) {
              await response.body?.cancel()
              throw new WebFetchHTTPError(response.status, response.headers)
            }
            const contentLength = response.headers.get("content-length")
            if (contentLength && Number(contentLength) > MAX_RESPONSE_SIZE) {
              await response.body?.cancel()
              throw new Error("Response too large (exceeds 5MB limit)")
            }
            const bytes = await readBody(response)
            return { bytes, contentType: response.headers.get("content-type") ?? "" }
          },
          {
            attempts: 3,
            signal,
            retryIf: (error) =>
              error instanceof WebFetchHTTPError
                ? isRetryableHttpStatus(error.statusCode)
                : classifyNetworkError(error)?.kind === "transient",
            retryDelay: (error) =>
              error instanceof WebFetchHTTPError ? retryAfterMs(error.responseHeaders) : undefined,
          },
        )
      } catch (error) {
        ctx.abort.throwIfAborted()
        if (controller.signal.aborted) throw new Error("Request timed out", { cause: error })
        throw error
      } finally {
        clearTimeout(timeoutId)
      }
    })()
    const content = new TextDecoder().decode(page.bytes)
    const contentType = page.contentType

    const title = `${params.url} (${contentType})`

    function result(output: string) {
      const quality = SearchGuard.assessWebContent(output, contentType)
      return {
        output: quality ? SearchGuard.appendQualityWarning(output, quality.reason) : output,
        title,
        metadata: {
          contentType,
          contentLength: page.bytes.byteLength,
          ...(quality
            ? {
                searchFailureType: quality.failureType,
                searchFailureReason: quality.reason,
              }
            : {}),
        },
      }
    }

    // Handle content based on requested format and actual content type
    switch (params.format) {
      case "markdown":
        if (contentType.includes("text/html")) {
          const markdown = convertHTMLToMarkdown(content)
          return result(markdown)
        }
        return result(content)

      case "text":
        if (contentType.includes("text/html")) {
          const text = await extractTextFromHTML(content)
          return result(text)
        }
        return result(content)

      case "html":
        return result(content)

      default:
        return result(content)
    }
  },
})

async function extractTextFromHTML(html: string) {
  let text = ""
  let skipContent = false

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true
      },
      text() {
        // Skip text content inside these elements
      },
    })
    .on("*", {
      element(element) {
        // Reset skip flag when entering other elements
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skipContent = false
        }
      },
      text(input) {
        if (!skipContent) {
          text += input.text
        }
      },
    })
    .transform(new Response(html))

  await rewriter.text()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}

async function readBody(response: Response) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit)")
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
