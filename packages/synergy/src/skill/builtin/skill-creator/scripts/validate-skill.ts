#!/usr/bin/env bun
/**
 * Quick validation script for Synergy skills - minimal version
 */

import path from "path"
import matter from "gray-matter"

const ALLOWED_PROPERTIES = new Set(["name", "description", "license", "allowed-tools", "metadata"])

export async function validateSkill(skillPath: string): Promise<{ valid: boolean; message: string }> {
  const resolvedPath = path.resolve(skillPath)

  // Check SKILL.md exists
  const skillMdPath = path.join(resolvedPath, "SKILL.md")
  const skillMdFile = Bun.file(skillMdPath)
  if (!(await skillMdFile.exists())) {
    return { valid: false, message: "SKILL.md not found" }
  }

  // Read and validate frontmatter
  const content = await skillMdFile.text()
  if (!content.startsWith("---")) {
    return { valid: false, message: "No YAML frontmatter found" }
  }

  // Extract frontmatter
  const match = content.match(/^---\n(.*?)\n---/s)
  if (!match) {
    return { valid: false, message: "Invalid frontmatter format" }
  }

  // Parse YAML frontmatter
  let frontmatter: Record<string, unknown>
  try {
    const parsed = matter(content)
    if (typeof parsed.data !== "object" || parsed.data === null) {
      return { valid: false, message: "Frontmatter must be a YAML dictionary" }
    }
    frontmatter = parsed.data as Record<string, unknown>
  } catch (e) {
    return { valid: false, message: `Invalid YAML in frontmatter: ${e}` }
  }

  // Check for unexpected properties (excluding nested keys under metadata)
  const unexpectedKeys = Object.keys(frontmatter).filter((key) => !ALLOWED_PROPERTIES.has(key))
  if (unexpectedKeys.length > 0) {
    return {
      valid: false,
      message:
        `Unexpected key(s) in SKILL.md frontmatter: ${unexpectedKeys.sort().join(", ")}. ` +
        `Allowed properties are: ${Array.from(ALLOWED_PROPERTIES).sort().join(", ")}`,
    }
  }

  // Check required fields
  if (!("name" in frontmatter)) {
    return { valid: false, message: "Missing 'name' in frontmatter" }
  }
  if (!("description" in frontmatter)) {
    return { valid: false, message: "Missing 'description' in frontmatter" }
  }

  // Extract name for validation
  const rawName = frontmatter.name
  if (typeof rawName !== "string") {
    return { valid: false, message: `Name must be a string, got ${typeof rawName}` }
  }
  const name = rawName.trim()
  if (name) {
    // Check naming convention (hyphen-case: lowercase with hyphens)
    if (!/^[a-z0-9-]+$/.test(name)) {
      return {
        valid: false,
        message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`,
      }
    }
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
      return { valid: false, message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens` }
    }
    // Check name length (max 64 characters per spec)
    if (name.length > 64) {
      return { valid: false, message: `Name is too long (${name.length} characters). Maximum is 64 characters.` }
    }
  }

  // Extract and validate description
  const rawDescription = frontmatter.description
  if (typeof rawDescription !== "string") {
    return { valid: false, message: `Description must be a string, got ${typeof rawDescription}` }
  }
  const description = rawDescription.trim()
  if (description) {
    // Check for angle brackets
    if (description.includes("<") || description.includes(">")) {
      return { valid: false, message: "Description cannot contain angle brackets (< or >)" }
    }
    // Check description length (max 1024 characters per spec)
    if (description.length > 1024) {
      return {
        valid: false,
        message: `Description is too long (${description.length} characters). Maximum is 1024 characters.`,
      }
    }
  }

  return { valid: true, message: "Skill is valid!" }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    console.log("Usage: bun run validate-skill.ts <skill_directory>")
    process.exit(1)
  }

  const result = await validateSkill(args[0])
  console.log(result.message)
  process.exit(result.valid ? 0 : 1)
}
