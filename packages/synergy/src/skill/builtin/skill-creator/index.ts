import CONTENT from "./content.txt"
import OUTPUT_PATTERNS from "./references/output-patterns.txt"
import WORKFLOWS from "./references/workflows.txt"

export const skillCreator = {
  name: "skill-creator",
  description:
    "Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Claude's capabilities with specialized knowledge, workflows, or tool integrations.",
  content: CONTENT,
  builtin: true as const,
  references: {
    "references/output-patterns.txt": OUTPUT_PATTERNS,
    "references/workflows.txt": WORKFLOWS,
  },
  scripts: {
    init_skill: "./scripts/init-skill.ts",
    package_skill: "./scripts/package-skill.ts",
    validate_skill: "./scripts/validate-skill.ts",
  },
}
