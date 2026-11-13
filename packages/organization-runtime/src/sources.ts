import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { OrganizationHostedPublication } from "./backup/publication"
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
import { registerOrganizationToolPolicy } from "./tool-policy"
import { registerOrganizationSessionTools } from "./session-tool-source"

export function registerMemberSources(identity: RuntimeIdentity, restoration?: HomeOwnershipFile.RestorationInfo) {
  registerSessionSchema({ orgID: identity.orgID })
  if (restoration) {
    const selected = HomeOwnershipFile.RestorationInfo.parse(structuredClone(restoration))
    if (
      selected.owner !== "organization-runtime" ||
      selected.identity !== runtimeIdentityDigest(identity) ||
      selected.readerContract !== NativeHomeReaderContract
    )
      throw new Error("Restored Runtime ownership does not match its verified native identity")
    HomeOwnership.select(selected)
  } else
    HomeOwnership.select({
      owner: "organization-runtime",
      identity: runtimeIdentityDigest(identity),
      readerContract: NativeHomeReaderContract,
    })
  OrganizationHostedPublication.register()
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
  registerOrganizationToolPolicy(identity)
  registerOrganizationSessionTools(identity)
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
