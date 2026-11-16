import { TOOL_TITLE_DESC } from "../tool-title-descriptors"
import { getToolIcon } from "./icons"

export function getOrganizationKnowledgeInfo(
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
) {
  const command =
    input.input && typeof input.input === "object" && !Array.isArray(input.input)
      ? (input.input as Record<string, unknown>)
      : {}
  const operation = metadata.operation ?? command.operation
  const title =
    operation === "search"
      ? TOOL_TITLE_DESC.organization_knowledge_search
      : operation === "read"
        ? TOOL_TITLE_DESC.organization_knowledge_read
        : operation === "files"
          ? TOOL_TITLE_DESC.organization_knowledge_files
          : TOOL_TITLE_DESC.organization_knowledge_list
  const subtitle =
    operation === "search" && typeof command.q === "string"
      ? command.q
      : typeof metadata.path === "string"
        ? metadata.path
        : typeof metadata.title === "string"
          ? metadata.title
          : undefined
  const version = metadata.version ?? command.version
  const args = typeof version === "number" && Number.isSafeInteger(version) && version > 0 ? [`v${version}`] : undefined
  return { icon: getToolIcon("organization_knowledge"), title, subtitle, args }
}
