import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { InstructionSource } from "@ericsanchezok/synergy-harness/session/instruction-source"
import { SkillSelection } from "@ericsanchezok/synergy-local-runtime/skill/selection"
import { NativeHomeReaderContract, runtimeIdentityDigest, type RuntimeIdentity } from "./home"
import { registerSessionSchema } from "./session-schema"
import { registerMemberProviderSdks } from "./model-provider"
import { registerMemberExecution } from "./execution-source"
import { createMemberConnectionTool } from "./connection-tool"
import { createMemberMcpTool } from "./mcp-tool"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { registerOrganizationKnowledge } from "./knowledge-source"
import { createMemberKnowledgeTool } from "./tools/knowledge"
import { registerOrganizationHomeMigration } from "./home-migration"
import { registerOrganizationNamespaceIdentity } from "./namespace-identity"

export function registerMemberSources(identity: RuntimeIdentity) {
  registerSessionSchema({ orgID: identity.orgID })
  HomeOwnership.select({
    owner: "organization-runtime",
    identity: runtimeIdentityDigest(identity),
    readerContract: NativeHomeReaderContract,
  })
  registerOrganizationHomeMigration(identity)
  registerOrganizationNamespaceIdentity(identity)
  ConfigSource.register({
    resolve: async ({ scope }) =>
      (await import("@ericsanchezok/synergy-harness/config/project-source")).ProjectConfig.fields(scope, [
        "project_doc_max_bytes",
        "project_doc_fallback_filenames",
      ]),
  })
  registerMemberExecution(identity)
  registerMemberProviderSdks(identity)
  ToolRegistry.registerToolProvider("organization-runtime", () => [
    createMemberConnectionTool(identity),
    createMemberMcpTool(identity),
    createMemberKnowledgeTool(identity),
  ])
  InstructionSource.register({
    load: async () =>
      (await import("@ericsanchezok/synergy-harness/session/instruction-files")).InstructionFiles.project(),
  })
  SkillSelection.select({ builtins: [], filesystem: false })
  registerOrganizationKnowledge(identity)
}
