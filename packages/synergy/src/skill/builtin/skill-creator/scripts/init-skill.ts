#!/usr/bin/env bun
/**
 * Skill Initializer - Creates a new skill from template
 *
 * Usage:
 *     init-skill.ts <skill-name> --path <path>
 *
 * Examples:
 *     init-skill.ts my-new-skill --path .synergy/skill
 *     init-skill.ts my-api-helper --path .synergy/skills
 *     init-skill.ts custom-skill --path ~/.synergy/config/skill
 */

import path from "path"
import fs from "fs/promises"

const SKILL_TEMPLATE = `---
name: {skill_name}
description: [TODO: Complete and informative explanation of what the skill does and when to use it. Include WHEN to use this skill - specific scenarios, file types, or tasks that trigger it.]
---

# {skill_title}

## Overview

[TODO: 1-2 sentences explaining what this skill enables]

## Structuring This Skill

[TODO: Choose the structure that best fits this skill's purpose. Common patterns:

**1. Workflow-Based** (best for sequential processes)
- Works well when there are clear step-by-step procedures
- Example: DOCX skill with "Workflow Decision Tree" → "Reading" → "Creating" → "Editing"
- Structure: ## Overview → ## Workflow Decision Tree → ## Step 1 → ## Step 2...

**2. Task-Based** (best for tool collections)
- Works well when the skill offers different operations/capabilities
- Example: PDF skill with "Quick Start" → "Merge PDFs" → "Split PDFs" → "Extract Text"
- Structure: ## Overview → ## Quick Start → ## Task Category 1 → ## Task Category 2...

**3. Reference/Guidelines** (best for standards or specifications)
- Works well for brand guidelines, coding standards, or requirements
- Example: Brand styling with "Brand Guidelines" → "Colors" → "Typography" → "Features"
- Structure: ## Overview → ## Guidelines → ## Specifications → ## Usage...

**4. Capabilities-Based** (best for integrated systems)
- Works well when the skill provides multiple interrelated features
- Example: Product Management with "Core Capabilities" → numbered capability list
- Structure: ## Overview → ## Core Capabilities → ### 1. Feature → ### 2. Feature...

Patterns can be mixed and matched as needed. Most skills combine patterns (e.g., start with task-based, add workflow for complex operations).

Delete this entire "Structuring This Skill" section when done - it's just guidance.]

## [TODO: Replace with the first main section based on chosen structure]

[TODO: Add content here. See examples in existing skills:
- Code samples for technical skills
- Decision trees for complex workflows
- Concrete examples with realistic user requests
- References to scripts/templates/references as needed]

## Resources

This skill includes example resource directories that demonstrate how to organize different types of bundled resources:

### scripts/
Executable code (Python/Bash/etc.) that can be run directly to perform specific operations.

**Examples from other skills:**
- PDF skill: \`fill_fillable_fields.py\`, \`extract_form_field_info.py\` - utilities for PDF manipulation
- DOCX skill: \`document.py\`, \`utilities.py\` - Python modules for document processing

**Appropriate for:** Python scripts, shell scripts, or any executable code that performs automation, data processing, or specific operations.

**Note:** Scripts may be executed without loading into context, but can still be read by Claude for patching or environment adjustments.

### references/
Documentation and reference material intended to be loaded into context to inform Claude's process and thinking.

**Examples from other skills:**
- Product management: \`communication.md\`, \`context_building.md\` - detailed workflow guides
- BigQuery: API reference documentation and query examples
- Finance: Schema documentation, company policies

**Appropriate for:** In-depth documentation, API references, database schemas, comprehensive guides, or any detailed information that Claude should reference while working.

### assets/
Files not intended to be loaded into context, but rather used within the output Claude produces.

**Examples from other skills:**
- Brand styling: PowerPoint template files (.pptx), logo files
- Frontend builder: HTML/React boilerplate project directories
- Typography: Font files (.ttf, .woff2)

**Appropriate for:** Templates, boilerplate code, document templates, images, icons, fonts, or any files meant to be copied or used in the final output.

---

**Any unneeded directories can be deleted.** Not every skill requires all three types of resources.
`

const EXAMPLE_SCRIPT = `#!/usr/bin/env python3
"""
Example helper script for {skill_name}

This is a placeholder script that can be executed directly.
Replace with actual implementation or delete if not needed.

Example real scripts from other skills:
- pdf/scripts/fill_fillable_fields.py - Fills PDF form fields
- pdf/scripts/convert_pdf_to_images.py - Converts PDF pages to images
"""

def main():
    print("This is an example script for {skill_name}")
    # TODO: Add actual script logic here
    # This could be data processing, file conversion, API calls, etc.

if __name__ == "__main__":
    main()
`

const EXAMPLE_REFERENCE = `# Reference Documentation for {skill_title}

This is a placeholder for detailed reference documentation.
Replace with actual reference content or delete if not needed.

Example real reference docs from other skills:
- product-management/references/communication.md - Comprehensive guide for status updates
- product-management/references/context_building.md - Deep-dive on gathering context
- bigquery/references/ - API references and query examples

## When Reference Docs Are Useful

Reference docs are ideal for:
- Comprehensive API documentation
- Detailed workflow guides
- Complex multi-step processes
- Information too lengthy for main SKILL.md
- Content that's only needed for specific use cases

## Structure Suggestions

### API Reference Example
- Overview
- Authentication
- Endpoints with examples
- Error codes
- Rate limits

### Workflow Guide Example
- Prerequisites
- Step-by-step instructions
- Common patterns
- Troubleshooting
- Best practices
`

const EXAMPLE_ASSET = `# Example Asset File

This placeholder represents where asset files would be stored.
Replace with actual asset files (templates, images, fonts, etc.) or delete if not needed.

Asset files are NOT intended to be loaded into context, but rather used within
the output Claude produces.

Example asset files from other skills:
- Brand guidelines: logo.png, slides_template.pptx
- Frontend builder: hello-world/ directory with HTML/React boilerplate
- Typography: custom-font.ttf, font-family.woff2
- Data: sample_data.csv, test_dataset.json

## Common Asset Types

- Templates: .pptx, .docx, boilerplate directories
- Images: .png, .jpg, .svg, .gif
- Fonts: .ttf, .otf, .woff, .woff2
- Boilerplate code: Project directories, starter files
- Icons: .ico, .svg
- Data files: .csv, .json, .xml, .yaml

Note: This is a text placeholder. Actual assets can be any file type.
`

/**
 * Convert hyphenated skill name to Title Case for display.
 */
function titleCaseSkillName(skillName: string): string {
  return skillName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * Initialize a new skill directory with template SKILL.md.
 *
 * @param skillName - Name of the skill
 * @param outputPath - Path where the skill directory should be created
 * @returns Path to created skill directory, or null if error
 */
export async function initSkill(skillName: string, outputPath: string): Promise<string | null> {
  // Determine skill directory path
  const skillDir = path.join(path.resolve(outputPath), skillName)

  // Check if directory already exists
  const skillDirFile = Bun.file(skillDir)
  try {
    const stat = await fs.stat(skillDir)
    if (stat) {
      console.log(`❌ Error: Skill directory already exists: ${skillDir}`)
      return null
    }
  } catch {
    // Directory doesn't exist, which is what we want
  }

  // Create skill directory
  try {
    await fs.mkdir(skillDir, { recursive: true })
    console.log(`✅ Created skill directory: ${skillDir}`)
  } catch (e) {
    console.log(`❌ Error creating directory: ${e}`)
    return null
  }

  // Create SKILL.md from template
  const skillTitle = titleCaseSkillName(skillName)
  const skillContent = SKILL_TEMPLATE.replace(/{skill_name}/g, skillName).replace(/{skill_title}/g, skillTitle)

  const skillMdPath = path.join(skillDir, "SKILL.md")
  try {
    await Bun.write(skillMdPath, skillContent)
    console.log("✅ Created SKILL.md")
  } catch (e) {
    console.log(`❌ Error creating SKILL.md: ${e}`)
    return null
  }

  // Create resource directories with example files
  try {
    // Create scripts/ directory with example script
    const scriptsDir = path.join(skillDir, "scripts")
    await fs.mkdir(scriptsDir, { recursive: true })
    const exampleScriptPath = path.join(scriptsDir, "example.py")
    const exampleScriptContent = EXAMPLE_SCRIPT.replace(/{skill_name}/g, skillName)
    await Bun.write(exampleScriptPath, exampleScriptContent)
    await fs.chmod(exampleScriptPath, 0o755)
    console.log("✅ Created scripts/example.py")

    // Create references/ directory with example reference doc
    const referencesDir = path.join(skillDir, "references")
    await fs.mkdir(referencesDir, { recursive: true })
    const exampleReferencePath = path.join(referencesDir, "api_reference.md")
    const exampleReferenceContent = EXAMPLE_REFERENCE.replace(/{skill_title}/g, skillTitle)
    await Bun.write(exampleReferencePath, exampleReferenceContent)
    console.log("✅ Created references/api_reference.md")

    // Create assets/ directory with example asset placeholder
    const assetsDir = path.join(skillDir, "assets")
    await fs.mkdir(assetsDir, { recursive: true })
    const exampleAssetPath = path.join(assetsDir, "example_asset.txt")
    await Bun.write(exampleAssetPath, EXAMPLE_ASSET)
    console.log("✅ Created assets/example_asset.txt")
  } catch (e) {
    console.log(`❌ Error creating resource directories: ${e}`)
    return null
  }

  // Print next steps
  console.log(`\n✅ Skill '${skillName}' initialized successfully at ${skillDir}`)
  console.log("\nNext steps:")
  console.log("1. Edit SKILL.md to complete the TODO items and update the description")
  console.log("2. Customize or delete the example files in scripts/, references/, and assets/")
  console.log("3. Run the validator when ready to check the skill structure")

  return skillDir
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length < 3 || args[1] !== "--path") {
    console.log("Usage: init-skill.ts <skill-name> --path <path>")
    console.log("\nSkill name requirements:")
    console.log("  - Hyphen-case identifier (e.g., 'data-analyzer')")
    console.log("  - Lowercase letters, digits, and hyphens only")
    console.log("  - Max 40 characters")
    console.log("  - Must match directory name exactly")
    console.log("\nExamples:")
    console.log("  init-skill.ts my-new-skill --path .synergy/skill")
    console.log("  init-skill.ts my-api-helper --path .synergy/skills")
    console.log("  init-skill.ts custom-skill --path ~/.synergy/config/skill")
    process.exit(1)
  }

  const skillName = args[0]
  const outputPath = args[2]

  console.log(`🚀 Initializing skill: ${skillName}`)
  console.log(`   Location: ${outputPath}`)
  console.log()

  const result = await initSkill(skillName, outputPath)

  if (result) {
    process.exit(0)
  } else {
    process.exit(1)
  }
}
