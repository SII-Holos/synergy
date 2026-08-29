import { InstructionRegistry } from "../instruction/registry"
import { Skill } from "./skill"
import { SkillRenderer } from "./renderer"
import { SkillReferences } from "./references"

function toEntry(skill: Skill.Info): InstructionRegistry.Entry {
  const sourceScope =
    skill.origin.kind === "filesystem"
      ? { source: skill.origin.source, scope: skill.origin.scope }
      : { source: skill.origin.kind, scope: skill.origin.kind }
  return {
    name: skill.name,
    description: skill.description,
    source: sourceScope.source,
    scope: sourceScope.scope,
    compatibility: Skill.runtimeCompatibility(skill),
    directory: skill.backing.kind === "file" ? skill.backing.baseDir : skill.origin.kind,
    model: skill.invocation.model,
    warnings: skill.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").map((d) => d.message),
    unsupported: skill.diagnostics
      .filter((diagnostic) => diagnostic.code === "skill.vendor_field_unsupported")
      .map((d) => d.message),
    content: () => Skill.content(skill),
    references: () => SkillReferences.names(skill),
    reference: (name) => SkillReferences.resolve(skill, name),
  }
}

/**
 * H7 skill domain registration: mounts the skill instruction source (engine
 * append semantics, placeholder hints) and its catalog so the session loop
 * and the generic skill tool render and load skills through the L1 registry
 * instead of importing this domain. Plugin skill entries arrive through
 * SkillSourceProviders, registered by the L4 product manifest.
 */
export function registerSkillDomain() {
  InstructionRegistry.register({
    kind: "skill",
    render: (input) => Promise.resolve(SkillRenderer.render(input)),
    hints: () => SkillRenderer.hints(),
    list: async () => (await Skill.all()).map((skill) => skill.name),
    entries: async () => (await Skill.all()).map(toEntry),
    entry: async (name) => {
      const skill = await Skill.get(name)
      return skill ? toEntry(skill) : undefined
    },
    diagnostics: () => Skill.diagnostics(),
  })
}
