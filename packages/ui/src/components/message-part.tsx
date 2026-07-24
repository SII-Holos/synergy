import {
  Component,
  ErrorBoundary,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  onCleanup,
  type JSX,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { createStore, reconcile } from "solid-js/store"
import {
  AssistantMessage,
  AttachmentPart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  TextPart,
  ToolPart,
  ToolStateCompleted,
  ToolStateError,
  ToolStateGenerating,
  UserMessage,
  Todo,
} from "@ericsanchezok/synergy-sdk"
import { useData } from "../context"
import { useResourceOpen } from "../context/resource-open"
import { useDiffComponent } from "../context/diff"
import { useCodeComponent } from "../context/code"
import { BasicTool } from "./basic-tool"
import { SmartTool } from "./basic-tool"
import { Card } from "./card"
import { createCopyController } from "./clipboard"
import { Icon } from "./icon"
import { Tooltip } from "./tooltip"
import { Checkbox } from "./checkbox"
import { DagGraph } from "./dag-graph"
import { DiffChanges } from "./diff-changes"
import { Markdown } from "./markdown"
import { AttachmentGallery, type AttachmentFile } from "./attachment-card"
import { ErrorCard } from "./error-card"
import { getDirectory as _getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { parsePartialJson } from "@ericsanchezok/synergy-util/json"
import { createAutoScroll, createAnimatedNumber } from "../hooks"
import { getApprovalAudit } from "../utils/approval-audit"
import { getSemanticIcon } from "./semantic-icon"
import { isToolCardHidden } from "./tool-result-presentation"
import { hasVisibleUserMessageContent, shouldCollapseUserMessage, visibleUserMessageText } from "./user-message-utils"
import { CompactionCard } from "./compaction-card"
import { getAnysearchToolInfo, isAnysearchToolName } from "./tool/anysearch-info"
import { getTaskToolInfo } from "./tool/task-info"
import type { MessageDescriptor } from "@lingui/core"
import { TOOL_TITLE_DESC } from "./tool-title-descriptors"
import { MESSAGE_PART_DESC } from "./tool-title-descriptors"
import { useLingui } from "@lingui/solid"
import { createTextPartProjection, isTextPartTerminal } from "./text-part-render"
import { getLatticeToolPresentation } from "./tool/classifier"

export type UserMessageVariant = "default" | "turn-bubble"

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

export function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath] ?? []
  return diagnostics.filter((d) => d.severity === 1).slice(0, 3)
}

export function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const { _ } = useLingui()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{_(MESSAGE_PART_DESC.diagnosticError)}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
  userVariant?: UserMessageVariant
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

const TEXT_RENDER_THROTTLE_MS = 100

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function createThrottledValue(getValue: () => string) {
  const [value, setValue] = createSignal(getValue())
  let timeout: ReturnType<typeof setTimeout> | undefined
  let last = 0

  createEffect(() => {
    const next = getValue()
    const now = Date.now()
    const remaining = TEXT_RENDER_THROTTLE_MS - (now - last)
    if (remaining <= 0) {
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      last = now
      setValue(next)
      return
    }
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      last = Date.now()
      setValue(next)
      timeout = undefined
    }, remaining)
  })

  onCleanup(() => {
    if (timeout) clearTimeout(timeout)
  })

  return value
}

function relativizeProjectPaths(text: string, directory?: string) {
  if (!text) return ""
  if (!directory) return text
  return text.split(directory).join("")
}

export function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPaths(_getDirectory(path), data.directory)
}

export function getSessionToolParts(store: ReturnType<typeof useData>["store"], sessionId: string): ToolPart[] {
  const messages = store.message[sessionId]?.filter((m) => m.role === "assistant")
  if (!messages) return []

  const parts: ToolPart[] = []
  for (const m of messages) {
    const msgParts = store.part[m.id]
    if (msgParts) {
      for (const p of msgParts) {
        if (p && p.type === "tool") parts.push(p as ToolPart)
      }
    }
  }
  return parts
}

import type { IconName } from "./icon"

export type ToolInfo = {
  icon: IconName
  title: string | MessageDescriptor
  subtitle?: string
}

export type ToolTriggerInfo = ToolInfo & {
  args?: string[]
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function shortToken(value: unknown, max = 16) {
  if (typeof value !== "string" || !value) return undefined
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function pushArg(args: string[], value: unknown) {
  if (!value) return
  args.push(String(value))
}

function isBlueprintToolKind(input: any = {}, metadata: any = {}) {
  if ((metadata.kind || input.kind) === "blueprint") return true
  const kinds = metadata.kinds
  return Array.isArray(kinds) && kinds.length > 0 && kinds.every((kind) => kind === "blueprint")
}

const BLUEPRINT_ICON = getSemanticIcon("blueprint.main")

export const browserToolLabels: Record<string, { icon: IconName; title: MessageDescriptor }> = {
  browser_navigation: { icon: "route", title: TOOL_TITLE_DESC["browser_navigation"] },
  browser_snapshot: { icon: "binoculars", title: TOOL_TITLE_DESC["browser_snapshot"] },
  browser_action: { icon: "mouse-pointer-click", title: TOOL_TITLE_DESC["browser_action"] },
  browser_wait: { icon: "hourglass", title: TOOL_TITLE_DESC["browser_wait"] },
  browser_read: { icon: "glasses", title: TOOL_TITLE_DESC["browser_read"] },
  browser_inspect: { icon: "scan-eye", title: TOOL_TITLE_DESC["browser_inspect"] },
  browser_screenshot: { icon: "image", title: TOOL_TITLE_DESC["browser_screenshot"] },
  browser_eval: { icon: "braces", title: TOOL_TITLE_DESC["browser_eval"] },
  browser_console: { icon: "file-terminal", title: TOOL_TITLE_DESC["browser_console"] },
  browser_network: { icon: "network", title: TOOL_TITLE_DESC["browser_network"] },
  browser_performance: { icon: "gauge", title: TOOL_TITLE_DESC["browser_performance"] },
  browser_audit: { icon: "shield-check", title: TOOL_TITLE_DESC["browser_audit"] },
  browser_emulate: { icon: "sliders-horizontal", title: TOOL_TITLE_DESC["browser_emulate"] },
  browser_dialog: { icon: "message-square-more", title: TOOL_TITLE_DESC["browser_dialog"] },
  browser_upload: { icon: "upload", title: TOOL_TITLE_DESC["browser_upload"] },
  browser_downloads: { icon: "download-cloud", title: TOOL_TITLE_DESC["browser_downloads"] },
  browser_clipboard: { icon: "clipboard-list", title: TOOL_TITLE_DESC["browser_clipboard"] },
  browser_assets: { icon: "package", title: TOOL_TITLE_DESC["browser_assets"] },
  browser_annotate: { icon: "square-pen", title: TOOL_TITLE_DESC["browser_annotate"] },
  browser_view: { icon: "panel-right", title: TOOL_TITLE_DESC["browser_view"] },
}

function getBrowserToolInfo(tool: string, input: any = {}, metadata: any = {}): ToolTriggerInfo | undefined {
  const info = browserToolLabels[tool]
  if (!info) return undefined

  const args: string[] = []
  pushArg(args, metadata?.entryCount != null ? `${metadata.entryCount} console` : undefined)
  pushArg(args, metadata?.requestCount != null ? `${metadata.requestCount} requests` : undefined)
  pushArg(args, metadata?.assetCount != null ? `${metadata.assetCount} assets` : undefined)
  pushArg(args, metadata?.elementsCount != null ? `${metadata.elementsCount} elements` : undefined)
  pushArg(args, metadata?.captureKind)

  return {
    icon: info.icon,
    title: info.title,
    subtitle: firstString(metadata?.url, input?.url, metadata?.title, input?.action, input?.type),
    args: args.length ? args : undefined,
  }
}

function qzScopeLabel(input: any = {}) {
  return input.workspace || input.workspace_id || (input.all_workspaces ? "All workspaces" : undefined)
}

function titleFromToolResult(metadata: any = {}) {
  return firstString(metadata.title, metadata.resultTitle, metadata.display?.title)
}

function subtitleFromToolResult(metadata: any = {}, fallback?: unknown) {
  return firstString(
    metadata.display?.subtitle,
    metadata.title,
    metadata.summary,
    metadata.name,
    metadata.label,
    fallback,
  )
}

function pushUniqueArg(args: string[], value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : value == null ? "" : String(value)
  if (!normalized || args.includes(normalized)) return
  args.push(normalized)
}

function researchObjectSubtitle(input: any = {}, metadata: any = {}) {
  return subtitleFromToolResult(metadata, firstString(input.title, input.id))
}

function researchStateSubtitle(input: any = {}, metadata: any = {}) {
  return subtitleFromToolResult(
    metadata,
    firstString(input.summary, input.reason, input.blocked_on, input.target_phase),
  )
}

function researchWikiSubtitle(input: any = {}, metadata: any = {}) {
  const action = input.action as string | undefined
  if (action === "ingest_paper") {
    const ingestedTitle = titleFromToolResult(metadata)?.replace(/^Paper ingested:\s*/, "")
    return firstString(input.title, metadata.paperTitle, ingestedTitle, input.arxiv, input.doi, metadata.slug)
  }
  if (action === "link") {
    return firstString(metadata.title, input.evidence, [input.from, input.to].filter(Boolean).join(" → "))
  }
  if (action === "register_gap") {
    return firstString(input.description, titleFromToolResult(metadata), metadata.id)
  }
  if (action === "update_entry") {
    return firstString(input.target_id, titleFromToolResult(metadata))
  }
  if (action === "query") {
    return firstString(titleFromToolResult(metadata), "LIT_CONTEXT.md")
  }
  return subtitleFromToolResult(
    metadata,
    firstString(input.title, input.query, input.target_id, input.source_paper, input.arxiv, input.doi),
  )
}

function researchWikiArgs(input: any = {}, metadata: any = {}) {
  const args: string[] = []
  pushUniqueArg(args, input.action)
  pushUniqueArg(args, input.relevance)
  pushUniqueArg(args, metadata.source)
  if (input.action === "link") pushUniqueArg(args, input.edge_type ?? metadata.type)
  if (input.action === "update_entry") pushUniqueArg(args, input.field ?? metadata.field)
  if (input.action === "query") {
    const papers = metadata.papers
    const gaps = metadata.gaps
    const edges = metadata.edges
    if (typeof papers === "number") pushUniqueArg(args, `${papers} papers`)
    if (typeof gaps === "number") pushUniqueArg(args, `${gaps} gaps`)
    if (typeof edges === "number") pushUniqueArg(args, `${edges} edges`)
  }
  return args
}

// TODO: legacy qzcli tool info — remove when qzcli MCP integration is fully replaced by native inspire tools
export function getQzToolInfo(tool: string, input: any = {}, _metadata: any = {}): ToolTriggerInfo | undefined {
  switch (tool) {
    case "qzcli_qz_auth_login": {
      const args: string[] = []
      pushArg(args, input.workspace_id ? `ws ${input.workspace_id}` : undefined)
      return {
        icon: "key-round",
        title: TOOL_TITLE_DESC["qz_login"],
        subtitle: input.username,
        args,
      }
    }
    case "qzcli_qz_set_cookie": {
      const args: string[] = []
      pushArg(args, input.test === false ? "save only" : "validate")
      pushArg(args, input.workspace_id ? `ws ${input.workspace_id}` : undefined)
      return {
        icon: "fingerprint",
        title: TOOL_TITLE_DESC["qz_set_cookie"],
        subtitle: input.workspace_id || "Local auth",
        args,
      }
    }
    case "qzcli_qz_list_workspaces":
      return {
        icon: "building-2",
        title: TOOL_TITLE_DESC["qz_workspaces"],
        subtitle: input.refresh === false ? "Cached" : "Refresh",
      }
    case "qzcli_qz_refresh_resources": {
      const args: string[] = []
      pushArg(args, input.all_workspaces ? "all" : undefined)
      return {
        icon: "refresh-ccw",
        title: TOOL_TITLE_DESC["qz_refresh_resources"],
        subtitle: qzScopeLabel(input) || "Default workspace",
        args,
      }
    }
    case "qzcli_qz_get_availability": {
      const args: string[] = []
      pushArg(args, input.required_nodes ? `${input.required_nodes}+ nodes` : undefined)
      pushArg(args, input.include_low_priority ? "low priority" : undefined)
      return {
        icon: "signal",
        title: TOOL_TITLE_DESC["qz_availability"],
        subtitle: input.group || qzScopeLabel(input) || "Default target",
        args,
      }
    }
    case "qzcli_qz_list_jobs": {
      const args: string[] = []
      pushArg(args, input.running_only ? "running" : undefined)
      pushArg(args, input.limit ? `limit ${input.limit}` : undefined)
      return {
        icon: "boxes",
        title: TOOL_TITLE_DESC["qz_jobs"],
        subtitle: qzScopeLabel(input) || "Default workspace",
        args,
      }
    }
    case "qzcli_qz_get_job_detail":
      return {
        icon: "scan",
        title: TOOL_TITLE_DESC["qz_job_detail"],
        subtitle: shortToken(input.job_id, 20),
      }
    case "qzcli_qz_stop_job":
      return {
        icon: "circle-stop",
        title: TOOL_TITLE_DESC["qz_stop_job"],
        subtitle: shortToken(input.job_id, 20),
      }
    case "qzcli_qz_get_usage":
      return {
        icon: "gauge",
        title: TOOL_TITLE_DESC["qz_gpu_usage"],
        subtitle: qzScopeLabel(input) || "All workspaces",
      }
    case "qzcli_qz_inspect_status_catalog": {
      const args: string[] = []
      pushArg(args, input.limit_per_workspace ? `limit ${input.limit_per_workspace}` : undefined)
      pushArg(args, input.sample_limit ? `sample ${input.sample_limit}` : undefined)
      return {
        icon: "table",
        title: TOOL_TITLE_DESC["qz_status_catalog"],
        subtitle: qzScopeLabel(input) || "Default workspace",
        args,
      }
    }
    case "qzcli_qz_track_job": {
      const args: string[] = []
      pushArg(args, input.source)
      pushArg(args, input.workspace_id ? `ws ${input.workspace_id}` : undefined)
      return {
        icon: "pin",
        title: TOOL_TITLE_DESC["qz_track_job"],
        subtitle: input.name || shortToken(input.job_id, 20),
        args,
      }
    }
    case "qzcli_qz_list_tracked_jobs": {
      const args: string[] = []
      pushArg(args, input.limit ? `limit ${input.limit}` : undefined)
      pushArg(args, input.refresh === false ? "cached" : "refresh")
      return {
        icon: "binoculars",
        title: TOOL_TITLE_DESC["qz_tracked_jobs"],
        subtitle: input.running_only ? "Running only" : "All tracked",
        args,
      }
    }
    case "qzcli_qz_create_job": {
      const args: string[] = []
      pushArg(args, input.workspace)
      pushArg(args, input.compute_group)
      pushArg(args, input.instances ? `${input.instances}x` : undefined)
      return {
        icon: "rocket",
        title: TOOL_TITLE_DESC["qz_submit_job"],
        subtitle: input.name,
        args,
      }
    }
    case "qzcli_qz_create_hpc_job": {
      const args: string[] = []
      pushArg(args, input.workspace)
      pushArg(args, input.compute_group)
      pushArg(args, input.instances ? `${input.instances} node${input.instances === 1 ? "" : "s"}` : undefined)
      pushArg(args, input.cpu && input.mem_gi ? `${input.cpu} CPU / ${input.mem_gi}Gi` : undefined)
      return {
        icon: "cpu",
        title: TOOL_TITLE_DESC["qz_submit_hpc"],
        subtitle: input.name,
        args,
      }
    }
    case "qzcli_qz_get_hpc_usage": {
      const args: string[] = []
      pushArg(args, input.compute_group)
      pushArg(args, input.verbose ? `top ${input.top || 30}` : undefined)
      return {
        icon: "server",
        title: TOOL_TITLE_DESC["qz_hpc_usage"],
        subtitle: qzScopeLabel(input) || "All workspaces",
        args,
      }
    }
    default:
      return undefined
  }
}

export function getToolInfo(tool: string, input: any = {}, metadata: any = {}): ToolTriggerInfo {
  const qz = getQzToolInfo(tool, input, metadata)
  if (qz) return qz
  const browser = getBrowserToolInfo(tool, input, metadata)
  if (browser) return browser
  const lattice = getLatticeToolPresentation(tool, input, metadata)
  if (lattice) return lattice

  if (isAnysearchToolName(tool)) return getAnysearchToolInfo(tool, input)

  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: TOOL_TITLE_DESC["read"],
        subtitle: input.filePath ? getDirectory(input.filePath) + getFilename(input.filePath) : undefined,
      }
    case "view_image":
      return {
        icon: "image",
        title: TOOL_TITLE_DESC["view_image"],
        subtitle: input.filePath ? getDirectory(input.filePath) + getFilename(input.filePath) : undefined,
      }
    case "view_file":
      return {
        icon: "scan-eye",
        title: TOOL_TITLE_DESC["view_file"],
        subtitle: input.filePath ? getDirectory(input.filePath) + getFilename(input.filePath) : undefined,
      }
    case "list":
      return {
        icon: "folder",
        title: TOOL_TITLE_DESC["list"],
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon: "funnel",
        title: TOOL_TITLE_DESC["glob"],
        subtitle: input.pattern,
      }
    case "grep":
      return {
        icon: "regex",
        title: TOOL_TITLE_DESC["grep"],
        subtitle: input.pattern,
      }
    case "file_search":
      return {
        icon: "scan-document",
        title: TOOL_TITLE_DESC["file_search"],
        subtitle: input.query,
      }
    case "scan_files":
      return {
        icon: "scan-search",
        title: TOOL_TITLE_DESC["scan_files"],
        subtitle: input.pattern,
      }
    case "webfetch":
      return {
        icon: "mouse-pointer-2",
        title: TOOL_TITLE_DESC["webfetch"],
        subtitle: input.url,
      }
    case "task":
      return getTaskToolInfo(input)
    case "bash":
      return {
        icon: "terminal",
        title: TOOL_TITLE_DESC["bash"],
        subtitle: input.description,
      }
    case "edit":
      return {
        icon: "pen-line",
        title: TOOL_TITLE_DESC["edit"],
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "revise_file": {
      const path = metadata.path || metadata.filepath || input.input?.match?.(/^\[([^#\]]+)/)?.[1]
      return {
        icon: "file-pen",
        title: TOOL_TITLE_DESC["revise_file"],
        subtitle: path ? getDirectory(path) + getFilename(path) : undefined,
      }
    }
    case "multiedit":
      return {
        icon: "pen-line",
        title: TOOL_TITLE_DESC["multiedit"],
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "patch":
      return {
        icon: "diff",
        title: TOOL_TITLE_DESC["patch"],
      }
    case "write":
      return {
        icon: "file-pen",
        title: TOOL_TITLE_DESC["write"],
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "save_file": {
      const path = metadata.path || metadata.filepath || input.filePath
      return {
        icon: "file-pen",
        title: metadata.exists === false ? TOOL_TITLE_DESC["create_file"] : TOOL_TITLE_DESC["save_file"],
        subtitle: path ? getDirectory(path) + getFilename(path) : undefined,
      }
    }
    case "todowrite":
      return {
        icon: "clipboard-check",
        title: TOOL_TITLE_DESC["todowrite"],
      }
    case "todoread":
      return {
        icon: "list-filter",
        title: TOOL_TITLE_DESC["todoread"],
      }
    case "dagwrite":
      return {
        icon: "route",
        title: TOOL_TITLE_DESC["dagwrite"],
      }
    case "dagread":
      return {
        icon: "spline",
        title: TOOL_TITLE_DESC["dagread"],
      }
    case "dagpatch":
      return {
        icon: "git-merge",
        title: TOOL_TITLE_DESC["dagwrite"],
      }
    case "question":
      return {
        icon: "message-circle",
        title: TOOL_TITLE_DESC["question"],
      }
    case "websearch":
      return {
        icon: "globe",
        title: TOOL_TITLE_DESC["websearch"],
        subtitle: input.query,
      }
    case "look_at":
      return {
        icon: "scan-eye",
        title: TOOL_TITLE_DESC["look_at"],
        subtitle: input.file_path
          ? getFilename(Array.isArray(input.file_path) ? input.file_path[0] : input.file_path)
          : undefined,
      }
    case "scan_document":
      return {
        icon: "scan-document",
        title: TOOL_TITLE_DESC["scan_document"],
        subtitle: input.filePath ? getDirectory(input.filePath) + getFilename(input.filePath) : undefined,
      }
    case "ast_grep":
      return {
        icon: "braces",
        title: TOOL_TITLE_DESC["ast_grep"],
        subtitle: input.pattern,
      }
    case "parse_code":
      return {
        icon: "braces",
        title: TOOL_TITLE_DESC["parse_code"],
        subtitle: input.pattern,
      }
    case "lsp":
      return {
        icon: "circuit-board",
        title: TOOL_TITLE_DESC["lsp"],
        subtitle: input.operation,
      }
    case "skill":
      return {
        icon: "sparkles",
        title: TOOL_TITLE_DESC["skill"],
        subtitle: input.name + (input.reference ? ` (${input.reference})` : ""),
      }
    case "search_tools":
      return {
        icon: "tool-search",
        title: TOOL_TITLE_DESC["search_tools"],
        subtitle: input.query,
      }
    case "expand_tools":
      return {
        icon: "tool-expand",
        title: TOOL_TITLE_DESC["expand_tools"],
        subtitle: [...(input.groups ?? []), ...(input.tools ?? [])].join(", ") || input.reason,
      }
    case "arxiv_search":
      return {
        icon: "book-open",
        title: TOOL_TITLE_DESC["arxiv_search"],
        subtitle: input.query,
      }
    case "arxiv_download":
      return {
        icon: "book-down",
        title: TOOL_TITLE_DESC["arxiv_download"],
        subtitle: input.arxivId,
      }
    case "process":
      return {
        icon: "activity",
        title: TOOL_TITLE_DESC["process"],
        subtitle: input.action,
      }
    case "attach":
      return {
        icon: "paperclip",
        title: TOOL_TITLE_DESC["attach"],
        subtitle: input.filename || input.file_path,
      }
    case "openai_image_gen":
      return {
        icon: "image",
        title: TOOL_TITLE_DESC["generate_image"],
        subtitle: input.output_path ? getDirectory(input.output_path) + getFilename(input.output_path) : input.prompt,
      }
    case "openai_image_edit":
      return {
        icon: "image",
        title: TOOL_TITLE_DESC["edit_image"],
        subtitle: input.output_path ? getDirectory(input.output_path) + getFilename(input.output_path) : input.prompt,
      }
    case "diagram":
      return {
        icon: "workflow",
        title: TOOL_TITLE_DESC["diagram"],
        subtitle: input.title,
      }
    case "render":
      return {
        icon: "code",
        title: TOOL_TITLE_DESC["render"],
        subtitle: input.title,
      }
    case "note_list":
      if (isBlueprintToolKind(input, metadata)) {
        return {
          icon: BLUEPRINT_ICON,
          title: TOOL_TITLE_DESC["blueprints"],
          subtitle: input.scope,
        }
      }
      return {
        icon: "notebook-pen",
        title: TOOL_TITLE_DESC["note_list"],
        subtitle: input.scope,
      }
    case "note_read":
      if (isBlueprintToolKind(input, metadata)) {
        return {
          icon: BLUEPRINT_ICON,
          title: TOOL_TITLE_DESC["read_blueprint"],
          subtitle: Array.isArray(input.ids)
            ? input.ids.length === 1
              ? input.ids[0]
              : `${input.ids.length} blueprints`
            : undefined,
        }
      }
      return {
        icon: "notebook-pen",
        title: TOOL_TITLE_DESC["note_read"],
        subtitle: Array.isArray(input.ids)
          ? input.ids.length === 1
            ? input.ids[0]
            : `${input.ids.length} notes`
          : undefined,
      }
    case "note_search":
      if (isBlueprintToolKind(input, metadata)) {
        return {
          icon: BLUEPRINT_ICON,
          title: TOOL_TITLE_DESC["blueprint_search"],
          subtitle: input.pattern,
        }
      }
      return {
        icon: "notebook-pen",
        title: TOOL_TITLE_DESC["note_search"],
        subtitle: input.pattern,
      }
    case "note_write":
      if (isBlueprintToolKind(input, metadata)) {
        return {
          icon: BLUEPRINT_ICON,
          title: TOOL_TITLE_DESC["write_blueprint"],
          subtitle: input.title || input.mode,
        }
      }
      return {
        icon: "notebook-pen",
        title: TOOL_TITLE_DESC["note_write"],
        subtitle: input.title || input.mode,
      }
    case "note_edit":
      if (isBlueprintToolKind(input, metadata)) {
        return {
          icon: BLUEPRINT_ICON,
          title: TOOL_TITLE_DESC["edit_blueprint"],
          subtitle: input.title || input.id,
        }
      }
      return {
        icon: "notebook-pen",
        title: TOOL_TITLE_DESC["note_edit"],
        subtitle: input.title || input.id,
      }
    case "note_archive": {
      const unarchive = input.unarchive as boolean | undefined
      return {
        icon: "archive",
        title: unarchive ? TOOL_TITLE_DESC["note_unarchive"] : TOOL_TITLE_DESC["note_archive"],
        subtitle: Array.isArray(input.ids)
          ? input.ids.length === 1
            ? input.ids[0]
            : `${input.ids.length} notes`
          : undefined,
      }
    }
    case "note_delete":
      return {
        icon: "trash-2",
        title: TOOL_TITLE_DESC["note_delete"],
        subtitle: input.id,
      }
    case "blueprint_loop_stop":
      return {
        icon: "circle-pause",
        title: TOOL_TITLE_DESC["blueprint_loop_stop"],
        subtitle: input.summary,
      }
    case "blueprint_loop_approve":
      return {
        icon: "file-check-2",
        title: TOOL_TITLE_DESC["blueprint_loop_approve"],
        subtitle: (input.summary as string) || (input.sessionID as string) || "",
      }
    case "blueprint_loop_reject":
      return {
        icon: "clipboard-x",
        title: TOOL_TITLE_DESC["blueprint_loop_reject"],
        subtitle: (input.reason as string) || (input.sessionID as string) || "",
      }
    case "task_list":
      return {
        icon: "list-todo",
        title: TOOL_TITLE_DESC["task_list"],
        subtitle: undefined,
      }
    case "task_output":
      return {
        icon: "list-todo",
        title: TOOL_TITLE_DESC["task_output"],
        subtitle: input.task_id,
      }
    case "task_cancel":
      return {
        icon: "circle-x",
        title: TOOL_TITLE_DESC["task_cancel"],
        subtitle: input.task_id,
      }
    case "loop_stop":
      return {
        icon: "flag",
        title: TOOL_TITLE_DESC["loop_stop"],
        subtitle: (input.summary as string) || "",
      }
    case "light_loop_approve":
      return {
        icon: "circle-check",
        title: TOOL_TITLE_DESC["light_loop_approve"],
        subtitle: (input.summary as string) || (input.sessionID as string) || "",
      }
    case "light_loop_reject":
      return {
        icon: "rotate-ccw",
        title: TOOL_TITLE_DESC["light_loop_reject"],
        subtitle: (input.reason as string) || (input.sessionID as string) || "",
      }
    case "context7_resolve-library-id":
      return {
        icon: "tag",
        title: TOOL_TITLE_DESC["context7_resolve_library"],
        subtitle: input.libraryName,
      }
    case "context7_query-docs":
      return {
        icon: "scroll-text",
        title: TOOL_TITLE_DESC["context7_query_docs"],
        subtitle: input.query,
      }
    case "session_list":
      return {
        icon: "list",
        title: TOOL_TITLE_DESC["session_list"],
        subtitle: input.scope,
      }
    case "scope_list":
      return {
        icon: "folder-tree",
        title: TOOL_TITLE_DESC["scope_list"],
        subtitle: (input.query as string) || undefined,
      }
    case "session_read":
      return {
        icon: "message-square",
        title: TOOL_TITLE_DESC["session_read"],
        subtitle: input.target,
      }
    case "session_search":
      return {
        icon: "quote",
        title: TOOL_TITLE_DESC["session_search"],
        subtitle: input.pattern,
      }
    case "session_send":
      return {
        icon: "share",
        title: TOOL_TITLE_DESC["session_send"],
        subtitle: input.target,
      }
    case "session_control": {
      const action = input.action as string | undefined
      switch (action) {
        case "status":
          return {
            icon: "radar",
            title: TOOL_TITLE_DESC["session_status"],
            subtitle: input.target,
          }
        case "compact":
          return {
            icon: "layers",
            title: TOOL_TITLE_DESC["session_compact"],
            subtitle: input.target,
          }
        case "abort":
          return {
            icon: "circle-stop",
            title: TOOL_TITLE_DESC["session_abort"],
            subtitle: input.target,
          }
        case "question_reply":
          return {
            icon: "message-circle",
            title: TOOL_TITLE_DESC["session_answer_question"],
            subtitle: input.target,
          }
        case "question_reject":
          return {
            icon: "circle-x",
            title: TOOL_TITLE_DESC["session_dismiss_question"],
            subtitle: input.target,
          }
        case "permission_reply":
          return {
            icon: input.reply === "reject" ? "shield-alert" : "shield-check",
            title:
              input.reply === "reject"
                ? TOOL_TITLE_DESC["session_deny_permission"]
                : TOOL_TITLE_DESC["session_approve_permission"],
            subtitle: input.target,
          }
        default:
          return {
            icon: "radar",
            title: TOOL_TITLE_DESC["session_control"],
            subtitle: input.target,
          }
      }
    }
    // research — holos-research plugin
    case "research_init": {
      const args: string[] = []
      pushArg(args, input.venue)
      pushArg(args, input.participation_mode)
      return { icon: "flask-conical", title: TOOL_TITLE_DESC["research_init"], subtitle: input.project, args }
    }
    case "research_state": {
      const args: string[] = []
      pushArg(args, input.action)
      pushArg(args, input.target_phase)
      pushArg(args, input.participation_mode)
      return {
        icon: "sigma",
        title: TOOL_TITLE_DESC["research_state"],
        subtitle: researchStateSubtitle(input, metadata),
        args,
      }
    }
    case "research_idea": {
      const args: string[] = []
      pushArg(args, input.action)
      pushArg(args, input.round ? `round ${input.round}` : undefined)
      return {
        icon: "lightbulb",
        title: TOOL_TITLE_DESC["research_idea"],
        subtitle: researchObjectSubtitle(input, metadata),
        args,
      }
    }
    case "research_plan": {
      const args: string[] = []
      pushArg(args, input.action)
      pushArg(args, input.idea)
      return {
        icon: "map",
        title: TOOL_TITLE_DESC["research_plan"],
        subtitle: researchObjectSubtitle(input, metadata),
        args,
      }
    }
    case "research_experiment": {
      const args: string[] = []
      pushArg(args, input.action)
      pushArg(args, input.group)
      pushArg(args, input.backend)
      return {
        icon: "microscope",
        title: TOOL_TITLE_DESC["research_experiment"],
        subtitle: researchObjectSubtitle(input, metadata),
        args,
      }
    }
    case "research_claim": {
      const args: string[] = []
      pushArg(args, input.action)
      pushArg(args, input.paper_section)
      return {
        icon: "scale",
        title: TOOL_TITLE_DESC["research_claim"],
        subtitle: researchObjectSubtitle(input, metadata),
        args,
      }
    }
    case "research_exhibit": {
      const args: string[] = []
      pushArg(args, input.action)
      pushArg(args, input.kind)
      return {
        icon: "image",
        title: TOOL_TITLE_DESC["research_exhibit"],
        subtitle: researchObjectSubtitle(input, metadata),
        args,
      }
    }
    case "research_paper": {
      const args: string[] = []
      pushArg(args, input.action)
      pushArg(args, input.venue)
      return {
        icon: "scroll-text",
        title: TOOL_TITLE_DESC["research_paper"],
        subtitle: researchObjectSubtitle(input, metadata),
        args,
      }
    }
    case "research_submission": {
      const args: string[] = []
      pushArg(args, input.action)
      pushArg(args, input.venue)
      pushArg(args, input.outcome)
      return {
        icon: "send",
        title: TOOL_TITLE_DESC["research_submission"],
        subtitle: researchObjectSubtitle(input, metadata),
        args,
      }
    }
    case "research_wiki": {
      const args = researchWikiArgs(input, metadata)
      return {
        icon: "telescope",
        title: TOOL_TITLE_DESC["research_wiki"],
        subtitle: researchWikiSubtitle(input, metadata),
        args,
      }
    }
    case "research_timeline": {
      const args: string[] = []
      pushArg(args, input.action)
      pushArg(args, input.last ? `last ${input.last}` : undefined)
      pushArg(args, input.event_type)
      return {
        icon: "clock",
        title: TOOL_TITLE_DESC["research_timeline"],
        subtitle: subtitleFromToolResult(metadata, input.summary),
        args,
      }
    }
    case "profile_get":
      return {
        icon: "scan",
        title: TOOL_TITLE_DESC["profile_get"],
        subtitle: input.name,
      }
    case "profile_update":
      return {
        icon: "user-round-pen",
        title: TOOL_TITLE_DESC["profile_update"],
        subtitle: input.name,
      }
    case "agenda_schedule":
      return {
        icon: "calendar-days",
        title: TOOL_TITLE_DESC["agenda_schedule"],
        subtitle: input.title,
      }
    case "agenda_watch":
      return {
        icon: "eye",
        title: TOOL_TITLE_DESC["agenda_watch"],
        subtitle: input.title,
      }
    case "agenda_list":
      return {
        icon: "clipboard-list",
        title: TOOL_TITLE_DESC["agenda_list"],
        subtitle: input.status,
      }
    case "agenda_update":
      return {
        icon: "pencil",
        title: TOOL_TITLE_DESC["agenda_update"],
        subtitle: input.id,
      }
    case "agenda_cancel":
      return {
        icon: "trash-2",
        title: TOOL_TITLE_DESC["agenda_cancel"],
        subtitle: input.id,
      }
    case "agenda_trigger":
      return {
        icon: "zap",
        title: TOOL_TITLE_DESC["agenda_trigger"],
        subtitle: input.id,
      }
    case "agenda_logs":
      return {
        icon: "clock",
        title: TOOL_TITLE_DESC["agenda_logs"],
        subtitle: input.id,
      }
    //    case "agora_search":
    //      return {
    //        icon: "compass",
    //        title: "Agora Search",
    //        subtitle: input.keyword,
    //      }
    //    case "agora_read":
    //      return {
    //        icon: "compass",
    //        title: "Agora Read",
    //        subtitle: input.post_id,
    //      }
    //    case "agora_post":
    //      return {
    //        icon: "megaphone",
    //        title: "Agora Post",
    //        subtitle: input.title,
    //      }
    //    case "agora_join":
    //      return {
    //        icon: "log-in",
    //        title: "Agora Join",
    //        subtitle: input.post_id,
    //      }
    //    case "agora_sync":
    //      return {
    //        icon: "arrow-down-to-line",
    //        title: "Agora Sync",
    //        subtitle: input.directory,
    //      }
    //    case "agora_submit":
    //      return {
    //        icon: "upload",
    //        title: "Agora Submit",
    //        subtitle: input.comment,
    //      }
    //    case "agora_accept":
    //      return {
    //        icon: "git-merge",
    //        title: "Agora Accept",
    //        subtitle: input.answer_id,
    //      }
    //    case "agora_comment":
    //      return {
    //        icon: "compass",
    //        title: "Agora Comment",
    //        subtitle: input.post_id,
    //      }
    case "memory_search":
      return {
        icon: "brain",
        title: TOOL_TITLE_DESC["memory_search"],
        subtitle: input.query,
      }
    case "memory_get":
      return {
        icon: "brain",
        title: TOOL_TITLE_DESC["memory_get"],
      }
    case "memory_write":
      return {
        icon: "brain",
        title: TOOL_TITLE_DESC["memory_write"],
        subtitle: input.title,
      }
    case "memory_edit":
      return {
        icon: "brain",
        title: TOOL_TITLE_DESC["memory_edit"],
        subtitle: input.title,
      }
    case "email_send":
      return {
        icon: "mail",
        title: TOOL_TITLE_DESC["email_send"],
        subtitle: input.to ? `To: ${Array.isArray(input.to) ? input.to.join(", ") : input.to}` : input.subject,
      }
    case "email_read": {
      const args: string[] = []
      pushArg(args, input.folder && input.folder !== "INBOX" ? input.folder : undefined)
      pushArg(args, input.search?.unseen ? "unread" : undefined)
      return {
        icon: "mail-search",
        title:
          input.action === "search"
            ? TOOL_TITLE_DESC["email_search"]
            : input.action === "read"
              ? TOOL_TITLE_DESC["email_read"]
              : input.action === "markSeen"
                ? TOOL_TITLE_DESC["email_mark_read"]
                : TOOL_TITLE_DESC["email_inbox"],
        subtitle: input.search?.from || input.search?.subject || input.folder || "INBOX",
        args,
      }
    }
    case "runtime_reload": {
      const target = Array.isArray(input.target)
        ? input.target.length <= 3
          ? input.target.join(", ")
          : `${input.target.length} targets`
        : input.target
      return {
        icon: "rotate-cw",
        title: TOOL_TITLE_DESC["runtime_reload"],
        subtitle: target || input.reason,
      }
    }
    case "worktree_enter": {
      const args: string[] = []
      pushArg(args, input?.target)
      pushArg(args, input?.baseRef !== "current" ? input?.baseRef : undefined)
      pushArg(args, input?.force ? "force" : undefined)
      return {
        icon: "worktree-enter",
        title: TOOL_TITLE_DESC["worktree_enter"],
        subtitle: (input?.target as string) ?? "New worktree",
        args,
      }
    }
    case "worktree_leave": {
      const args: string[] = []
      pushArg(args, input?.cleanup === "remove_if_clean" ? "remove if clean" : undefined)
      return {
        icon: "worktree-leave",
        title: TOOL_TITLE_DESC["worktree_leave"],
        subtitle: metadata?.previous?.name ?? metadata?.previous?.path ?? "",
        args,
      }
    }
    case "worktree_list": {
      const args: string[] = []
      pushArg(args, metadata?.worktrees ? `${metadata.worktrees.length} total` : undefined)
      return {
        icon: "worktree-list",
        title: TOOL_TITLE_DESC["worktree_list"],
        subtitle: metadata?.active?.name ?? "",
        args,
      }
    }
    case "connect":
      return {
        icon: "cable",
        title: TOOL_TITLE_DESC["connect"],
        subtitle: input.linkID,
      }
    // TODO: legacy qzcli — remove when replaced by native inspire tools
    case "qzcli_qz_auth_login":
      return {
        icon: "key-round",
        title: TOOL_TITLE_DESC["qz_login"],
        subtitle: input.username,
      }
    case "qzcli_qz_set_cookie":
      return {
        icon: "fingerprint",
        title: TOOL_TITLE_DESC["qz_set_cookie"],
      }
    case "qzcli_qz_list_workspaces":
      return {
        icon: "building-2",
        title: TOOL_TITLE_DESC["qz_workspaces"],
      }
    case "qzcli_qz_refresh_resources":
      return {
        icon: "refresh-ccw",
        title: TOOL_TITLE_DESC["qz_refresh_resources"],
        subtitle: input.workspace || (input.all_workspaces ? "All" : undefined),
      }
    case "qzcli_qz_get_availability":
      return {
        icon: "signal",
        title: TOOL_TITLE_DESC["qz_availability"],
        subtitle: input.group || input.workspace,
      }
    case "qzcli_qz_list_jobs":
      return {
        icon: "boxes",
        title: TOOL_TITLE_DESC["qz_jobs"],
        subtitle: input.workspace,
      }
    case "qzcli_qz_get_job_detail":
      return {
        icon: "scan",
        title: TOOL_TITLE_DESC["qz_job_detail"],
        subtitle: input.job_id,
      }
    case "qzcli_qz_stop_job":
      return {
        icon: "circle-stop",
        title: TOOL_TITLE_DESC["qz_stop_job"],
        subtitle: input.job_id,
      }
    case "qzcli_qz_get_usage":
      return {
        icon: "gauge",
        title: TOOL_TITLE_DESC["qz_gpu_usage"],
        subtitle: input.workspace,
      }
    case "qzcli_qz_inspect_status_catalog":
      return {
        icon: "stethoscope",
        title: TOOL_TITLE_DESC["qz_status_catalog"],
        subtitle: input.workspace,
      }
    case "qzcli_qz_track_job":
      return {
        icon: "crosshair",
        title: TOOL_TITLE_DESC["qz_track_job"],
        subtitle: input.name || input.job_id,
      }
    case "qzcli_qz_list_tracked_jobs":
      return {
        icon: "binoculars",
        title: TOOL_TITLE_DESC["qz_tracked_jobs"],
      }
    case "qzcli_qz_create_job":
      return {
        icon: "rocket",
        title: TOOL_TITLE_DESC["qz_submit_job"],
        subtitle: input.name,
      }
    case "qzcli_qz_create_hpc_job":
      return {
        icon: "cpu",
        title: TOOL_TITLE_DESC["qz_submit_hpc"],
        subtitle: input.name,
      }
    case "qzcli_qz_get_hpc_usage":
      return {
        icon: "hard-drive",
        title: TOOL_TITLE_DESC["qz_hpc_usage"],
        subtitle: input.workspace,
      }
    // inspire — SII 启智平台 (native tools)
    case "inspire_status": {
      const args: string[] = []
      pushArg(args, input.workspace)
      pushArg(args, input.refresh ? "refresh" : undefined)
      return {
        icon: "satellite",
        title: TOOL_TITLE_DESC["inspire_platform_status"],
        subtitle: input.project || metadata?.project_names?.[0] || "All",
        args,
      }
    }
    case "inspire_config": {
      const args: string[] = []
      pushArg(args, input.action === "set" && input.value !== undefined ? String(input.value) : undefined)
      return {
        icon: "sliders-horizontal",
        title:
          input.action === "set"
            ? TOOL_TITLE_DESC["inspire_config_set_default"]
            : TOOL_TITLE_DESC["inspire_config_sii_defaults"],
        subtitle: input.key,
        args,
      }
    }
    case "inspire_login": {
      const args: string[] = []
      pushArg(args, input.target)
      pushArg(args, input.target === "harbor" ? input.registry : undefined)
      return {
        icon: "lock-keyhole",
        title:
          input.target === "harbor" ? TOOL_TITLE_DESC["inspire_login_harbor"] : TOOL_TITLE_DESC["inspire_login_sii"],
        subtitle: input.username,
        args,
      }
    }
    case "inspire_images": {
      const args: string[] = []
      pushArg(args, input.limit ? `limit ${input.limit}` : undefined)
      return {
        icon: "disc",
        title: input.repo ? TOOL_TITLE_DESC["inspire_images_detail"] : TOOL_TITLE_DESC["inspire_images_search"],
        subtitle: input.repo || input.search || "Recent",
        args,
      }
    }
    case "inspire_image_push": {
      const args: string[] = []
      pushArg(args, input.name)
      pushArg(args, input.tag)
      return { icon: "archive", title: TOOL_TITLE_DESC["inspire_image_push"], subtitle: input.image, args }
    }
    case "inspire_submit": {
      const args: string[] = []
      pushArg(args, input.workspace)
      pushArg(args, input.compute_group)
      pushArg(args, input.image ? shortToken(input.image, 30) : undefined)
      pushArg(args, input.instances ? `${input.instances}× nodes` : undefined)
      return { icon: "gpu", title: TOOL_TITLE_DESC["inspire_submit_gpu"], subtitle: input.name, args }
    }
    case "inspire_submit_hpc": {
      const args: string[] = []
      pushArg(args, input.workspace)
      pushArg(args, input.cpu && input.mem_gi ? `${input.cpu} CPU / ${input.mem_gi}Gi` : undefined)
      return { icon: "cpu", title: TOOL_TITLE_DESC["qz_submit_hpc"], subtitle: input.name, args }
    }
    case "inspire_stop": {
      const args: string[] = []
      pushArg(args, input.workspace)
      pushArg(args, input.status && input.status !== "running" ? input.status : undefined)
      return {
        icon: "circle-stop",
        title: input.job_id ? TOOL_TITLE_DESC["inspire_stop_job"] : TOOL_TITLE_DESC["inspire_stop_batch"],
        subtitle: input.job_id ? shortToken(input.job_id, 20) : input.workspace,
        args,
      }
    }
    case "inspire_jobs": {
      const args: string[] = []
      pushArg(args, input.workspace)
      pushArg(args, input.status && input.status !== "all" ? input.status : undefined)
      pushArg(args, input.type && input.type !== "all" ? input.type : undefined)
      pushArg(args, input.limit ? `limit ${input.limit}` : undefined)
      return {
        icon: "list-filter",
        title: TOOL_TITLE_DESC["qz_jobs"],
        subtitle: metadata?.total !== undefined ? `${metadata.total} tasks` : input.workspace || "All",
        args,
      }
    }
    case "inspire_job_detail":
      return { icon: "scan-search", title: TOOL_TITLE_DESC["qz_job_detail"], subtitle: shortToken(input.job_id, 20) }
    case "inspire_logs": {
      const args: string[] = []
      pushArg(args, input.keyword)
      pushArg(args, input.download ? "download" : undefined)
      return {
        icon: "file-terminal",
        title: input.download ? TOOL_TITLE_DESC["inspire_logs_download"] : TOOL_TITLE_DESC["inspire_logs_view"],
        subtitle: shortToken(input.job_id, 20),
        args,
      }
    }
    case "inspire_metrics":
      return { icon: "heart-pulse", title: TOOL_TITLE_DESC["inspire_metrics"], subtitle: shortToken(input.job_id, 20) }
    case "inspire_inference":
      return {
        icon: "square-play",
        title:
          input.action === "create"
            ? TOOL_TITLE_DESC["inspire_inference_deploy"]
            : input.action === "stop"
              ? TOOL_TITLE_DESC["inspire_inference_stop"]
              : TOOL_TITLE_DESC["inspire_inference_detail"],
        subtitle: input.name || input.serving_id,
      }
    case "inspire_models": {
      const args: string[] = []
      pushArg(args, input.keyword)
      pushArg(args, input.model_source_path ? "registered" : undefined)
      return {
        icon: "boxes",
        title:
          input.action === "detail"
            ? TOOL_TITLE_DESC["inspire_models_detail"]
            : input.action === "create"
              ? TOOL_TITLE_DESC["inspire_models_register"]
              : input.action === "delete"
                ? TOOL_TITLE_DESC["inspire_models_delete"]
                : TOOL_TITLE_DESC["inspire_models_list"],
        subtitle: input.keyword || input.name || input.model_id,
        args,
      }
    }
    case "inspire_notebook": {
      const args: string[] = []
      pushArg(args, input.compute_group)
      pushArg(args, input.gpu_count ? `${input.gpu_count}× GPU` : undefined)
      pushArg(args, input.priority)
      return {
        icon: "code",
        title:
          input.action === "start"
            ? TOOL_TITLE_DESC["inspire_notebook_start"]
            : input.action === "stop"
              ? TOOL_TITLE_DESC["inspire_notebook_stop"]
              : input.action === "create"
                ? TOOL_TITLE_DESC["inspire_notebook_create"]
                : input.action === "detail"
                  ? TOOL_TITLE_DESC["inspire_notebook_detail"]
                  : TOOL_TITLE_DESC["inspire_notebook_list"],
        subtitle: input.name || input.notebook_id,
        args,
      }
    }
    default:
      return {
        icon: "settings",
        title: tool,
      }
  }
}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={props.message.role === "user" && props.message}>
        {(userMessage) => (
          <UserMessageDisplay message={userMessage() as UserMessage} parts={props.parts} variant={props.userVariant} />
        )}
      </Match>
      <Match when={props.message.role === "assistant" && props.message}>
        {(assistantMessage) => (
          <AssistantMessageDisplay message={assistantMessage() as AssistantMessage} parts={props.parts} />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: { message: AssistantMessage; parts: PartType[] }) {
  const emptyParts: PartType[] = []
  const filteredParts = createMemo(
    () =>
      props.parts.filter((x) => {
        return x.type !== "tool" || ((x as ToolPart).tool !== "todoread" && (x as ToolPart).tool !== "dagread")
      }),
    emptyParts,
    { equals: same },
  )
  return <For each={filteredParts()}>{(part) => <Part part={part} message={props.message} />}</For>
}

const SEARCH_REFLECTION_MARKER = "[Search failure reflection]"
const SEARCH_EARLY_STOP_MARKER = "[Search early stop]"

type SearchReflectionNoticeData = {
  id: string
  kind: "reflection" | "early-stop"
  titleDescriptor: MessageDescriptor
  text: string
}

function parseSearchReflectionNotice(part: TextPart): SearchReflectionNoticeData | undefined {
  if (!part.synthetic) return undefined

  const kind = part.text.includes(SEARCH_EARLY_STOP_MARKER)
    ? "early-stop"
    : part.text.includes(SEARCH_REFLECTION_MARKER)
      ? "reflection"
      : undefined
  if (!kind) return undefined

  return {
    id: part.id,
    kind,
    titleDescriptor: kind === "early-stop" ? MESSAGE_PART_DESC.searchEarlyStop : MESSAGE_PART_DESC.searchReflection,
    text: part.text,
  }
}

function SearchReflectionNoticeView(props: { notice: SearchReflectionNoticeData }) {
  const { _ } = useLingui()
  const title = () =>
    props.notice.kind === "early-stop" ? _(MESSAGE_PART_DESC.searchEarlyStop) : _(MESSAGE_PART_DESC.searchReflection)
  return (
    <div data-slot="user-message-search-reflection" data-kind={props.notice.kind}>
      <div data-slot="user-message-search-reflection-header">
        <Icon name="search" size="small" />
        <span>{title()}</span>
      </div>
      <div data-slot="user-message-search-reflection-body">{props.notice.text}</div>
    </div>
  )
}

function formatMessageTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = date.getHours().toString().padStart(2, "0")
  const minutes = date.getMinutes().toString().padStart(2, "0")
  return `${hours}:${minutes}`
}

export function UserMessageDisplay(props: { message: UserMessage; parts: PartType[]; variant?: UserMessageVariant }) {
  const { _ } = useLingui()
  const data = useData()
  const [expanded, setExpanded] = createSignal(false)

  const text = createMemo(() => visibleUserMessageText(props.parts))
  const isTurnBubble = createMemo(() => props.variant === "turn-bubble")
  const canCollapse = createMemo(() => isTurnBubble() && shouldCollapseUserMessage(text()))
  const collapsed = createMemo(() => canCollapse() && !expanded())
  const timestamp = createMemo(() => {
    const created = props.message.time?.created
    return typeof created === "number" ? formatMessageTimestamp(created) : undefined
  })

  const searchReflections = createMemo(
    () =>
      ((props.parts?.filter((p) => p.type === "text") as TextPart[] | undefined) ?? [])
        .map(parseSearchReflectionNotice)
        .filter((notice): notice is SearchReflectionNoticeData => !!notice),
    [] as SearchReflectionNoticeData[],
    { equals: same },
  )
  const files = createMemo(() => (props.parts?.filter((p) => p.type === "attachment") as AttachmentPart[]) ?? [])

  const isNoteAttachment = (file: AttachmentPart) => file.metadata?.kind === "note"
  const isSessionAttachment = (file: AttachmentPart) => file.metadata?.kind === "session"

  const noteAttachments = createMemo(() => files().filter(isNoteAttachment))
  const sessionAttachments = createMemo(() => files().filter(isSessionAttachment))

  const attachments = createMemo(() =>
    files().filter((f) => {
      if (isNoteAttachment(f) || isSessionAttachment(f)) return false
      if (f.source?.text?.start !== undefined) return false
      return true
    }),
  )

  const hasVisibleContent = createMemo(() => hasVisibleUserMessageContent(props.parts))
  const inlineFiles = createMemo(() =>
    files().filter((f) => {
      if (isNoteAttachment(f) || isSessionAttachment(f)) return false
      return f.source?.text?.start !== undefined
    }),
  )

  const copy = createCopyController({
    text,
    copyLabel: _(MESSAGE_PART_DESC.copyMessage),
    copiedLabel: _(MESSAGE_PART_DESC.messageCopied),
    failureDescription: _(MESSAGE_PART_DESC.copyFailure),
  })

  return (
    <div data-component="user-message" data-variant={props.variant ?? "default"}>
      <Show when={attachments().length > 0 || noteAttachments().length > 0 || sessionAttachments().length > 0}>
        <div data-slot="user-message-attachments">
          <AttachmentGallery files={attachments()} serverUrl={data.serverUrl} align="end" />
          <For each={noteAttachments()}>{(file) => <SpecialFileAttachment file={file} kind="note" />}</For>
          <For each={sessionAttachments()}>{(file) => <SpecialFileAttachment file={file} kind="session" />}</For>
        </div>
      </Show>
      <Show when={text()}>
        <div
          data-slot="user-message-text"
          data-collapsed={collapsed() ? "" : undefined}
          data-collapsible={canCollapse() ? "" : undefined}
        >
          <HighlightedText text={text()} references={inlineFiles()} />
          <Show when={collapsed()}>
            <div data-slot="user-message-fade">
              <button type="button" data-slot="user-message-expand" onClick={() => setExpanded(true)}>
                {_(MESSAGE_PART_DESC.showMore)}
              </button>
            </div>
          </Show>
          <For each={searchReflections()}>{(notice) => <SearchReflectionNoticeView notice={notice} />}</For>
          <Show when={canCollapse() && expanded()}>
            <button
              type="button"
              data-slot="user-message-expand"
              data-position="inline"
              onClick={() => setExpanded(false)}
            >
              {_(MESSAGE_PART_DESC.showLess)}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={isTurnBubble() && hasVisibleContent()}>
        <div data-slot="user-message-meta">
          <Show keyed when={timestamp()}>
            {(value) => <span data-slot="user-message-time">{value}</span>}
          </Show>
          <Show when={text()}>
            <Tooltip value={copy.tooltip()} placement="top" gutter={4} class="user-message-copy-trigger">
              <button
                type="button"
                data-slot="user-message-copy"
                data-copy-state={copy.state()}
                aria-label={copy.tooltip()}
                disabled={copy.disabled()}
                onClick={() => void copy.copy()}
              >
                <Icon name={copy.copied() ? getSemanticIcon("state.success") : copy.icon()} size="small" />
              </button>
            </Tooltip>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function SpecialFileAttachment(props: { file: AttachmentPart; kind: "note" | "session" }) {
  const { _ } = useLingui()
  const title = createMemo(
    () => (props.file.metadata?.title as string | undefined) || props.file.filename || _(MESSAGE_PART_DESC.untitled),
  )
  return (
    <div data-slot="user-message-attachment" data-type={props.kind}>
      <div data-slot="user-message-note-attachment">
        <Icon name={props.kind === "note" ? "notebook-pen" : "message-square"} data-slot="user-message-note-icon" />
        <div data-slot="user-message-note-copy">
          <span data-slot="user-message-note-title">{title()}</span>
          <span data-slot="user-message-note-subtitle">
            {props.kind === "note" ? _(MESSAGE_PART_DESC.noteLabel) : _(MESSAGE_PART_DESC.sessionLabel)}
          </span>
        </div>
      </div>
    </div>
  )
}

type HighlightSegment = { text: string; type?: "file"; file?: AttachmentPart }

function fileReferencePath(file: AttachmentPart) {
  const source = file.source as { path?: unknown } | undefined
  return typeof source?.path === "string" && source.path ? source.path : file.url
}

function HighlightedText(props: { text: string; references: AttachmentPart[] }) {
  const resourceOpen = useResourceOpen()
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file"; file: AttachmentPart }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({
          start: r.source!.text!.start,
          end: r.source!.text!.end,
          type: "file" as const,
          file: r,
        })),
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type, file: ref.file })
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return (
    <For each={segments()}>
      {(segment) => (
        <Show
          keyed
          when={resourceOpen ? segment.file : undefined}
          fallback={
            <span
              classList={{
                "text-syntax-property": segment.type === "file",
              }}
            >
              {segment.text}
            </span>
          }
        >
          {(file) => (
            <button
              type="button"
              class="inline text-left align-baseline text-syntax-property hover:underline decoration-dotted"
              onClick={() =>
                resourceOpen?.open(
                  {
                    kind: "workspace-file",
                    path: fileReferencePath(file),
                    mime: file.mime,
                    filename: file.filename,
                  },
                  { prefer: "workspace" },
                )
              }
            >
              {segment.text}
            </button>
          )}
        </Show>
      )}
    </For>
  )
}
export function Part(props: MessagePartProps) {
  const { _ } = useLingui()
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <ErrorBoundary
        fallback={(err) => (
          <div class="plugin-error-card">
            <div class="plugin-error-header">
              <Icon name="alert-triangle" />
              <span>
                {_(MESSAGE_PART_DESC.partRenderError)} {props.part.type}
              </span>
            </div>
            <div class="plugin-error-message">{err?.message || String(err)}</div>
          </div>
        )}
      >
        <Dynamic
          component={component()}
          part={props.part}
          message={props.message}
          hideDetails={props.hideDetails}
          defaultOpen={props.defaultOpen}
        />
      </ErrorBoundary>
    </Show>
  )
}

// ── Re-exported from tool-registry-lazy.ts for testability ────
import type { ToolProps, ToolComponent as _ToolComponent } from "./tool-registry-lazy"
export type { ToolProps }
export type ToolComponent = _ToolComponent
import {
  registerTool,
  getTool,
  ToolRegistry,
  setExternalToolLookup,
  setExternalFallbackLookup,
  notifyExternalToolLoaded,
  resolveToolRenderer,
  externalLookup,
  externalFallbackLookup,
  externalLoadNotify,
} from "./tool-registry-lazy"
export {
  registerTool,
  getTool,
  ToolRegistry,
  setExternalToolLookup,
  setExternalFallbackLookup,
  notifyExternalToolLoaded,
  resolveToolRenderer,
}

function ToolAttachments(props: { attachments: AttachmentPart[] }) {
  const data = useData()
  const files = createMemo(() =>
    props.attachments.map(
      (f): AttachmentFile => ({
        id: f.id,
        sessionID: f.sessionID,
        messageID: f.messageID,
        mime: f.mime,
        filename: f.filename,
        url: f.url,
        localPath: f.localPath,
        presentation: f.presentation,
        metadata: f.metadata,
        source: f.source,
      }),
    ),
  )
  return <AttachmentGallery files={files()} serverUrl={data.serverUrl} />
}

PART_MAPPING["attachment"] = function AttachmentPartDisplay(props) {
  const data = useData()
  const file = createMemo(() => props.part as AttachmentPart)
  const isInlineReference = createMemo(() => file().source?.text?.start !== undefined)
  const isNoteAttachment = createMemo(() => file().metadata?.kind === "note")
  const isSessionAttachment = createMemo(() => file().metadata?.kind === "session")

  return (
    <Show when={!isInlineReference()}>
      <div data-component="attachment-part">
        <Switch>
          <Match when={isNoteAttachment()}>
            <div data-component="user-message">
              <div data-slot="user-message-attachments">
                <SpecialFileAttachment file={file()} kind="note" />
              </div>
            </div>
          </Match>
          <Match when={isSessionAttachment()}>
            <div data-component="user-message">
              <div data-slot="user-message-attachments">
                <SpecialFileAttachment file={file()} kind="session" />
              </div>
            </div>
          </Match>
          <Match when={true}>
            <AttachmentGallery files={[file()]} serverUrl={data.serverUrl} />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const part = () => props.part as ToolPart
  if (isToolCardHidden(part())) return null

  const permission = createMemo(() => {
    const next = data.store.permission?.[props.message.sessionID]?.[0]
    if (!next || !next.tool) return undefined
    if (next.tool!.callID !== part().callID) return undefined
    return next
  })

  const throttledRaw = createThrottledValue(() => {
    const s = part().state
    return s.status === "pending" ? s.raw : s.status === "generating" ? s.raw : ""
  })
  const [streamInput, setStreamInput] = createStore<Record<string, any>>({})
  createEffect(() => {
    const raw = throttledRaw()
    if (raw) {
      const parsed = parsePartialJson(raw)
      setStreamInput(reconcile(parsed))
    }
  })
  const input = () => {
    const raw = throttledRaw()
    if (raw) return streamInput
    return part().state?.input ?? {}
  }
  const metadata = () => part().state?.metadata ?? {}
  const approval = createMemo(() => metadata().approval as Record<string, any> | undefined)
  const audit = createMemo(() => getApprovalAudit(approval()))

  const render = createMemo(() =>
    resolveToolRenderer(part().tool, ToolRegistry, { externalLookup, externalLoadNotify }),
  )

  // Smoothly animate charsReceived so tool cards don't jump
  const charsAnimated = createAnimatedNumber(() => {
    const s = part().state
    return s.status === "generating" ? (s as ToolStateGenerating).charsReceived : 0
  })

  // For unregistered tools (external agents, MCP, etc.), use SmartTool
  // which classifies by semantic category for appropriate icon/title/subtitle.
  // When plugin Tier 1 declarative fallback metadata is available, it overrides
  // the auto-classified icon/title/subtitle.
  const fallbackRender = (p: any) => (
    <SmartTool
      tool={p.tool}
      input={p.input}
      title={p.title}
      output={p.output}
      status={p.status}
      charsReceived={p.charsReceived}
      metadata={p.metadata}
      time={p.time}
      hideDetails={p.hideDetails}
      fallbackMeta={externalFallbackLookup?.(p.tool)}
    />
  )

  const component = createMemo(() => render() ?? fallbackRender)

  return (
    <div data-component="tool-part-wrapper" data-permission={!!permission()}>
      <Show when={audit().icon}>
        <Tooltip
          placement="right"
          value={
            <div class="max-w-72">
              <div class="text-12-medium text-text-base">{audit().tooltip.split("\n")[0]}</div>
              <Show when={audit().tooltip.includes("\n")}>
                <div class="mt-1 text-11-regular text-text-weak">{audit().tooltip.split("\n").slice(1).join("\n")}</div>
              </Show>
            </div>
          }
        >
          <div data-component="tool-audit-icon">
            <Icon name={audit().icon as IconName} size="small" class={audit().iconClass} />
          </div>
        </Tooltip>
      </Show>
      <div data-component="tool-card-area">
        <Switch>
          <Match when={part().state.status === "error" && (part().state as ToolStateError).error}>
            {(error) => (
              <ErrorCard
                error={error()}
                input={(part().state as ToolStateError).input as Record<string, unknown> | undefined}
              />
            )}
          </Match>
          <Match when={true}>
            <Dynamic
              component={component()}
              input={input()}
              tool={part().tool}
              metadata={metadata()}
              title={part().state.status === "completed" ? (part().state as ToolStateCompleted).title : undefined}
              // @ts-expect-error — output exists on completed state
              output={part().state.output}
              status={part().state.status}
              // @ts-expect-error — time exists on running/completed/error states
              time={part().state.time}
              raw={part().state.status === "generating" ? (part().state as ToolStateGenerating).raw : undefined}
              charsReceived={charsAnimated()}
              hideDetails={props.hideDetails}
              defaultOpen={props.defaultOpen}
            />
          </Match>
        </Switch>
        <Show
          when={
            part().tool !== "attach" &&
            part().state.status === "completed" &&
            (part().state as ToolStateCompleted).attachments?.length
          }
        >
          <ToolAttachments attachments={(part().state as ToolStateCompleted).attachments!} />
        </Show>
      </div>
    </div>
  )
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const part = () => props.part as TextPart
  const isTerminal = createMemo(() =>
    isTextPartTerminal({
      partEnd: part().time?.end,
      messageCompleted: (props.message as AssistantMessage).time.completed,
    }),
  )

  const projection = createTextPartProjection()
  const renderedText = createMemo(() =>
    projection.project({
      key: part().id,
      source: part().text ?? "",
      completed: isTerminal(),
      remove: data.directory,
    }),
  )

  return (
    <Show when={renderedText()}>
      <div data-component="text-part">
        <Markdown text={renderedText()} streaming={!isTerminal()} cacheKey={part().id} />
      </div>
    </Show>
  )
}

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const part = () => props.part as ReasoningPart
  const isTerminal = createMemo(() =>
    isTextPartTerminal({
      partEnd: part().time?.end,
      messageCompleted: (props.message as AssistantMessage).time.completed,
    }),
  )

  const projection = createTextPartProjection()
  const renderedText = createMemo(() =>
    projection.project({
      key: part().id,
      source: part().text,
      completed: isTerminal(),
    }),
  )

  return (
    <Show when={renderedText()}>
      <div data-component="reasoning-part">
        <Markdown text={renderedText()} streaming={!isTerminal()} cacheKey={part().id} />
      </div>
    </Show>
  )
}

PART_MAPPING["compaction_recovery"] = CompactionCard
