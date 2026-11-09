import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { ProviderCatalogSource } from "@ericsanchezok/synergy-harness/provider/catalog-source"
import { InstructionSource } from "@ericsanchezok/synergy-harness/session/instruction-source"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { SkillSelection } from "@ericsanchezok/synergy-local-runtime/skill/selection"
import { memberIdentityDigest, type MemberIdentity } from "./home"
import { registerSessionSchema } from "./session-schema"
import { registerMemberProviderSdks } from "./model-provider"

export function registerMemberSources(identity: MemberIdentity) {
  registerSessionSchema({ orgID: identity.orgID })
  HomeOwnership.select({ owner: "organization-runtime", identity: memberIdentityDigest(identity) })
  ConfigSource.register({
    resolve: async ({ scope }) =>
      (await import("@ericsanchezok/synergy-harness/config/project-source")).ProjectConfig.fields(scope, [
        "project_doc_max_bytes",
        "project_doc_fallback_filenames",
      ]),
  })
  ProviderCatalogSource.register({ providers: async () => ({}) })
  registerMemberProviderSdks(identity)
  InstructionSource.register({
    load: async () =>
      (await import("@ericsanchezok/synergy-harness/session/instruction-files")).InstructionFiles.project(),
  })
  SkillSelection.select({ builtins: [], filesystem: false })
  SessionExecutionSource.register({
    authorize: async () => {
      throw new Error("Organization command admission is unavailable")
    },
  })
}
