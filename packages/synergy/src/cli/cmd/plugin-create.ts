import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"
import path from "path"
import fs from "fs"
import type { Argv } from "yargs"

type TemplateName = "tool-ui" | "workspace-panel" | "api-connector" | "theme-icon"

const TEMPLATES: TemplateName[] = ["tool-ui", "workspace-panel", "api-connector", "theme-icon"]

// ---------------------------------------------------------------------------
// Template data
// ---------------------------------------------------------------------------

interface FileTemplate {
  relativePath: string
  content(name: string): string
}

function pluginJson(name: string, extra: (n: string) => object): string {
  const base = {
    name,
    version: "0.1.0",
    description: `${name} plugin`,
    permissions: {},
    contributes: {},
  }
  return JSON.stringify({ ...base, ...extra(name) }, null, 2) + EOL
}

function packageJson(name: string): string {
  return (
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        scripts: {
          build: "tsc",
          dev: "tsc --watch",
        },
        dependencies: {
          "@ericsanchezok/synergy-plugin": "workspace:*",
        },
        devDependencies: {
          typescript: "^5.0.0",
        },
      },
      null,
      2,
    ) + EOL
  )
}

function tsconfigJson(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: "dist",
          rootDir: "src",
          jsx: "preserve",
          jsxImportSource: "solid-js",
        },
        include: ["src"],
      },
      null,
      2,
    ) + EOL
  )
}

function readmeMd(name: string): string {
  return `# ${name}

Synergy plugin generated with \`synergy plugin create\`.
`
}

// ---------------------------------------------------------------------------
// Index templates per variant
// ---------------------------------------------------------------------------

function indexToolUI(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"

export const plugin: PluginDescriptor = {
  id: "${name}",
  name: "${name}",
  async init(input: PluginInput): Promise<PluginHooks> {
    const tools = {
      // Add your tools here
    }
    return { tools, hooks: {} }
  }
}
`
}

function indexWorkspacePanel(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"

export const plugin: PluginDescriptor = {
  id: "${name}",
  name: "${name}",
  async init(input: PluginInput): Promise<PluginHooks> {
    return { tools: {}, hooks: {} }
  }
}
`
}

function indexApiConnector(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin"

export const plugin: PluginDescriptor = {
  id: "${name}",
  name: "${name}",
  async init(input: PluginInput): Promise<PluginHooks> {
    const fetchData = tool({
      description: "Fetch data from an API endpoint",
      args: {
        url: tool.schema.string().describe("The API endpoint URL"),
      },
      async execute(args, ctx) {
        const res = await fetch(args.url)
        const text = await res.text()
        return { output: text }
      },
    })

    const tools = { fetchData }
    return { tools, hooks: {} }
  }
}
`
}

function indexThemeIcon(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"

export const plugin: PluginDescriptor = {
  id: "${name}",
  name: "${name}",
  async init(input: PluginInput): Promise<PluginHooks> {
    return { tools: {}, hooks: {} }
  }
}
`
}

// ---------------------------------------------------------------------------
// Tools templates
// ---------------------------------------------------------------------------

function toolsToolUI(_name: string): string {
  return `import { tool } from "@ericsanchezok/synergy-plugin"

export const greet = tool({
  description: "Greet a user by name",
  args: {
    name: tool.schema.string().describe("The name to greet"),
  },
  async execute(args, ctx) {
    return { output: \`Hello, \${args.name}!\` }
  },
})
`
}

function toolsApiConnector(_name: string): string {
  return `import { tool } from "@ericsanchezok/synergy-plugin"

export const getJSON = tool({
  description: "Fetch and parse JSON from an API endpoint",
  args: {
    url: tool.schema.string().describe("The API endpoint URL"),
  },
  async execute(args, ctx) {
    const res = await fetch(args.url)
    const json = await res.json()
    return { output: JSON.stringify(json, null, 2) }
  },
})

export const postJSON = tool({
  description: "POST JSON to an API endpoint",
  args: {
    url: tool.schema.string().describe("The API endpoint URL"),
    body: tool.schema.string().describe("The JSON request body"),
  },
  async execute(args, ctx) {
    const res = await fetch(args.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: args.body,
    })
    const text = await res.text()
    return { output: text }
  },
})
`
}

// ---------------------------------------------------------------------------
// UI templates
// ---------------------------------------------------------------------------

function uiToolUI(_name: string): string {
  return `import type { Component } from "solid-js"

interface Props {
  tool: string
  output: string
  metadata?: Record<string, any>
}

const ToolRenderer: Component<Props> = (props) => {
  return <div>{props.output}</div>
}

export default ToolRenderer
`
}

function uiWorkspacePanel(_name: string): string {
  return `import type { Component } from "solid-js"

const WorkspacePanel: Component = () => {
  return <div>Workspace panel content</div>
}

export default WorkspacePanel
`
}

// ---------------------------------------------------------------------------
// Template manifests
// ---------------------------------------------------------------------------

function manifestToolUI(name: string): object {
  return {
    contributes: {
      tools: [
        {
          name: "greet",
          title: "Greet",
          description: "Greet a user by name",
        },
      ],
      ui: {
        entry: "./src/ui.tsx",
        toolRenderers: [
          {
            tool: "greet",
          },
        ],
      },
    },
  }
}

function manifestWorkspacePanel(name: string): object {
  return {
    contributes: {
      ui: {
        entry: "./src/ui.tsx",
        workspacePanels: [
          {
            id: `${name}-panel`,
            label: name,
            icon: "layout-panel-left",
          },
        ],
      },
    },
  }
}

function manifestApiConnector(name: string): object {
  return {
    permissions: {
      network: {
        connectDomains: ["*"],
      },
    },
    contributes: {
      tools: [
        {
          name: "getJSON",
          title: "Get JSON",
          description: "Fetch and parse JSON from an API endpoint",
        },
        {
          name: "postJSON",
          title: "Post JSON",
          description: "POST JSON to an API endpoint",
        },
      ],
      ui: {
        entry: "./src/ui.tsx",
        toolRenderers: [{ tool: "getJSON" }, { tool: "postJSON" }],
      },
    },
  }
}

function manifestThemeIcon(name: string): object {
  return {
    contributes: {
      ui: {
        themes: [
          {
            id: `${name}-theme`,
            label: name,
            path: "./themes/default.css",
          },
        ],
        icons: [
          {
            name: `${name}-logo`,
            path: "./icons/logo.svg",
          },
        ],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

interface TemplateDef {
  label: string
  manifest: (name: string) => object
  files: FileTemplate[]
}

const TEMPLATE_DEFS: Record<TemplateName, TemplateDef> = {
  "tool-ui": {
    label: "Tool UI — tool definitions with Solid tool renderer",
    manifest: manifestToolUI,
    files: [
      { relativePath: "src/index.ts", content: indexToolUI },
      { relativePath: "src/tools.ts", content: toolsToolUI },
      { relativePath: "src/ui.tsx", content: uiToolUI },
    ],
  },
  "workspace-panel": {
    label: "Workspace Panel — Solid workspace panel with no tools",
    manifest: manifestWorkspacePanel,
    files: [
      { relativePath: "src/index.ts", content: indexWorkspacePanel },
      { relativePath: "src/ui.tsx", content: uiWorkspacePanel },
    ],
  },
  "api-connector": {
    label: "API Connector — network-enabled tools for API integration",
    manifest: manifestApiConnector,
    files: [
      { relativePath: "src/index.ts", content: indexApiConnector },
      { relativePath: "src/tools.ts", content: toolsApiConnector },
      { relativePath: "src/ui.tsx", content: uiToolUI },
    ],
  },
  "theme-icon": {
    label: "Theme & Icon — themes and icon contributions",
    manifest: manifestThemeIcon,
    files: [{ relativePath: "src/index.ts", content: indexThemeIcon }],
  },
}

// ---------------------------------------------------------------------------
// Common boot files
// ---------------------------------------------------------------------------

const COMMON_FILES: FileTemplate[] = [
  { relativePath: "package.json", content: packageJson },
  { relativePath: "tsconfig.json", content: tsconfigJson },
  { relativePath: "README.md", content: readmeMd },
]

// ---------------------------------------------------------------------------
// Creation logic
// ---------------------------------------------------------------------------

function scaffold(name: string, template: TemplateDef, targetDir: string): string[] {
  const created: string[] = []

  fs.mkdirSync(targetDir, { recursive: true })

  // Write plugin.json
  const manifestPath = path.join(targetDir, "plugin.json")
  const manifestContent = pluginJson(name, template.manifest)
  fs.writeFileSync(manifestPath, manifestContent)
  created.push(manifestPath)

  // Write common files
  for (const file of COMMON_FILES) {
    const filePath = path.join(targetDir, file.relativePath)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, file.content(name))
    created.push(filePath)
  }

  // Write template-specific files
  for (const file of template.files) {
    const filePath = path.join(targetDir, file.relativePath)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, file.content(name))
    created.push(filePath)
  }

  return created
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const PluginCreateCommand = cmd({
  command: "create <name>",
  describe: "scaffold a new plugin project",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "plugin name (used as directory name and plugin id)",
        demandOption: true,
      })
      .option("template", {
        type: "string",
        describe: "template to scaffold",
        choices: [...TEMPLATES],
        default: "tool-ui" as const,
      }),
  async handler(args) {
    const name = args.name as string
    const templateName = (args.template as TemplateName) ?? "tool-ui"
    const template = TEMPLATE_DEFS[templateName]
    const targetDir = path.resolve(process.cwd(), name)

    // Validate name
    if (!/^[a-z0-9][-a-z0-9]*$/.test(name)) {
      UI.error(
        `Invalid plugin name "${name}". Use lowercase letters, digits, and hyphens. Must start with a letter or digit.`,
      )
      return
    }

    // Check for existing directory
    if (fs.existsSync(targetDir)) {
      UI.error(`Directory "${targetDir}" already exists. Remove it first or use a different name.`)
      return
    }

    // Scaffold
    const created = scaffold(name, template, targetDir)

    UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Created plugin "${name}" (${template.label})`)
    UI.println()
    for (const p of created) {
      const relative = path.relative(process.cwd(), p)
      UI.println(`  ${UI.Style.TEXT_DIM}${relative}${UI.Style.TEXT_NORMAL}`)
    }
    UI.println()
    UI.println(`${UI.Style.TEXT_DIM}Next: cd ${name} && bun install${UI.Style.TEXT_NORMAL}`)
  },
})
