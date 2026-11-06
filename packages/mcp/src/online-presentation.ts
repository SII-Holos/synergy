import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
import type { ToolMcpSource } from "@ericsanchezok/synergy-harness/tool/mcp-source"
import type { MCP } from "."

interface OnlineContract {
  title: string
  summary: string
  keywords: string[]
}

// Provenance: https://api.anysearch.com/mcp and https://scholight.sanchezcloud.net/api/mcp tools/list.
// Local adaptation: selection labels for the six built-in tools; model descriptions and remote contracts remain owned by the MCP adapter.
const contracts: Record<string, Record<string, OnlineContract>> = {
  anysearch: {
    search: {
      title: "Web search",
      summary: "Web facts, news and documentation",
      keywords: ["web", "search", "news", "联网", "搜索", "新闻", "文档"],
    },
    batch_search: {
      title: "Parallel web search",
      summary: "Parallel web queries",
      keywords: ["web", "search", "parallel", "联网", "搜索", "并行"],
    },
    get_sub_domains: {
      title: "Vertical search domains",
      summary: "Structured vertical search",
      keywords: ["domain", "finance", "weather", "结构化", "领域", "天气", "金融"],
    },
    extract: {
      title: "Read a web page",
      summary: "Ordinary web-page reading",
      keywords: ["url", "web", "read", "网页", "链接", "原文", "阅读"],
    },
  },
  scholight: {
    search_papers: {
      title: "AI paper search",
      summary: "AI paper discovery",
      keywords: [
        "paper",
        "papers",
        "AI",
        "literature",
        "related work",
        "论文",
        "查找论文",
        "搜索论文",
        "文献",
        "相关工作",
        "学术",
      ],
    },
    extract_url: {
      title: "Read rendered pages and PDFs",
      summary: "PDF and rendered-page reading",
      keywords: ["url", "pdf", "render", "read", "网页", "原文", "阅读", "渲染", "分页"],
    },
  },
}

function onlinePresentation(entry: MCP.ToolEntry, resident: boolean): ToolMcpSource.Entry["presentation"] {
  if (entry.source !== "builtin") return undefined
  if (!Object.hasOwn(contracts, entry.serverName)) return undefined
  const server = contracts[entry.serverName]!
  if (!Object.hasOwn(server, entry.toolName)) return undefined
  const contract = server[entry.toolName]!
  return {
    title: contract.title,
    exposure: resident
      ? { mode: "resident" }
      : {
          mode: "group",
          group: "online",
          title: "Online search and reading",
          description: "Online source search and reading.",
          summary: contract.summary,
          keywords: contract.keywords,
        },
  }
}

export function presentMcpEntry(entry: MCP.ToolEntry, resident: boolean): ToolMcpSource.Entry {
  return {
    ...entry,
    presentation: onlinePresentation(entry, resident) ?? {
      exposure: ToolExposure.mcpExposure(entry.serverName, resident),
    },
  }
}
