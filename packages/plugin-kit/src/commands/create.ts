import path from "path"
import fs from "fs"
import { EOL } from "os"
import type { Argv } from "yargs"
import { cmd } from "../cmd"
import { UI } from "../ui"

type TemplateName = "tool-ui" | "workspace-panel" | "api-connector" | "theme-icon"

const TEMPLATES: TemplateName[] = ["tool-ui", "workspace-panel", "api-connector", "theme-icon"]

interface FileTemplate {
  relativePath: string
  content(name: string): string
}

function pluginJson(name: string, extra: (name: string) => object): string {
  const base = {
    name,
    version: "0.1.0",
    description: `${name} plugin`,
    permissions: {},
    contributes: {},
  }
  return JSON.stringify({ ...base, ...extra(name) }, null, 2) + EOL
}

function packageJson(name: string, templateName: TemplateName): string {
  const needsSolid = templateName !== "theme-icon"
  const pkg = {
    name,
    version: "0.1.0",
    type: "module",
    scripts: {
      dev: "synergy-plugin dev",
      validate: "synergy-plugin validate --runtime-discovery",
      build: "synergy-plugin build",
      pack: "synergy-plugin pack",
      sign: "synergy-plugin sign",
      "publish:market": "synergy-plugin publish-market",
      test: "synergy-plugin test",
    },
    dependencies: {
      "@ericsanchezok/synergy-plugin": "latest",
      zod: "^4.0.0",
      ...(needsSolid ? { "solid-js": "^1.9.0" } : {}),
    },
    devDependencies: {
      "@ericsanchezok/synergy-plugin-kit": "latest",
      typescript: "^5.8.0",
    },
  }
  return JSON.stringify(pkg, null, 2) + EOL
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

Synergy plugin generated with \`synergy-plugin create\`.

## Commands

\`\`\`bash
bun install
bun run validate
bun run build
bun run pack
bun run sign ${name}-0.1.0.synergy-plugin.tgz
bun run publish:market
\`\`\`
`
}

function indexToolUI(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"
import { greet } from "./tools"

export const plugin: PluginDescriptor = {
  id: "${name}",
  name: "${name}",
  async init(_input: PluginInput): Promise<PluginHooks> {
    return {
      tool: {
        greet,
      },
    }
  },
}

export default plugin
`
}

function indexWorkspacePanel(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"

export const plugin: PluginDescriptor = {
  id: "${name}",
  name: "${name}",
  async init(_input: PluginInput): Promise<PluginHooks> {
    return {}
  },
}

export default plugin
`
}

function indexApiConnector(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"
import { getJSON, postJSON } from "./tools"

export const plugin: PluginDescriptor = {
  id: "${name}",
  name: "${name}",
  async init(_input: PluginInput): Promise<PluginHooks> {
    return {
      tool: {
        getJSON,
        postJSON,
      },
    }
  },
}

export default plugin
`
}

function indexThemeIcon(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"

export const plugin: PluginDescriptor = {
  id: "${name}",
  name: "${name}",
  async init(_input: PluginInput): Promise<PluginHooks> {
    return {}
  },
}

export default plugin
`
}

function toolsToolUI(_name: string): string {
  return `import { tool } from "@ericsanchezok/synergy-plugin/tool"

export const greet = tool({
  description: "Greet a user by name",
  args: {
    name: tool.schema.string().describe("The name to greet"),
  },
  async execute(args) {
    return { output: \`Hello, \${args.name}!\` }
  },
})
`
}

function toolsApiConnector(_name: string): string {
  return `import { tool } from "@ericsanchezok/synergy-plugin/tool"

export const getJSON = tool({
  description: "Fetch and parse JSON from an API endpoint",
  args: {
    url: tool.schema.string().describe("The API endpoint URL"),
  },
  async execute(args) {
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
  async execute(args) {
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

function uiToolUI(_name: string): string {
  return `import type { Component } from "solid-js"

interface Props {
  tool: string
  output: string
  metadata?: Record<string, unknown>
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

function manifestToolUI(name: string): object {
  return {
    permissions: {
      tools: {
        invoke: true,
        shell: false,
        filesystem: "none",
        network: false,
        mcp: "none",
      },
    },
    contributes: {
      tools: [
        {
          name: "greet",
          title: "Greet",
          description: "Greet a user by name",
          capabilities: {
            filesystem: "none",
            network: false,
            shell: false,
          },
        },
      ],
      ui: {
        entry: "./dist/ui/index.js",
        toolRenderers: [{ tool: "greet" }],
      },
    },
  }
}

function manifestWorkspacePanel(name: string): object {
  return {
    contributes: {
      ui: {
        entry: "./dist/ui/index.js",
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

function manifestApiConnector(_name: string): object {
  return {
    permissions: {
      tools: {
        invoke: true,
        network: true,
        shell: false,
        filesystem: "none",
        mcp: "none",
      },
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
          capabilities: {
            network: true,
            filesystem: "none",
            shell: false,
          },
        },
        {
          name: "postJSON",
          title: "Post JSON",
          description: "POST JSON to an API endpoint",
          capabilities: {
            network: true,
            filesystem: "none",
            shell: false,
          },
        },
      ],
      ui: {
        entry: "./dist/ui/index.js",
        toolRenderers: [{ tool: "getJSON" }, { tool: "postJSON" }],
      },
    },
  }
}

function manifestThemeIcon(name: string): object {
  return {
    contributes: {
      ui: {
        themes: [{ id: `${name}-theme`, label: name, path: "./themes/default.css" }],
        icons: [{ name: `${name}-logo`, path: "./icons/logo.svg" }],
      },
    },
  }
}

interface TemplateDef {
  label: string
  manifest: (name: string) => object
  files: FileTemplate[]
}

const TEMPLATE_DEFS: Record<TemplateName, TemplateDef> = {
  "tool-ui": {
    label: "Tool UI - tool definitions with Solid tool renderer",
    manifest: manifestToolUI,
    files: [
      { relativePath: "src/index.ts", content: indexToolUI },
      { relativePath: "src/tools.ts", content: toolsToolUI },
      { relativePath: "src/ui.tsx", content: uiToolUI },
    ],
  },
  "workspace-panel": {
    label: "Workspace Panel - Solid workspace panel with no tools",
    manifest: manifestWorkspacePanel,
    files: [
      { relativePath: "src/index.ts", content: indexWorkspacePanel },
      { relativePath: "src/ui.tsx", content: uiWorkspacePanel },
    ],
  },
  "api-connector": {
    label: "API Connector - network-enabled tools for API integration",
    manifest: manifestApiConnector,
    files: [
      { relativePath: "src/index.ts", content: indexApiConnector },
      { relativePath: "src/tools.ts", content: toolsApiConnector },
      { relativePath: "src/ui.tsx", content: uiToolUI },
    ],
  },
  "theme-icon": {
    label: "Theme & Icon - themes and icon contributions",
    manifest: manifestThemeIcon,
    files: [
      { relativePath: "src/index.ts", content: indexThemeIcon },
      { relativePath: "themes/default.css", content: () => ":root { --plugin-accent: #2563eb; }\n" },
      {
        relativePath: "icons/logo.svg",
        content: () =>
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>\n',
      },
    ],
  },
}

function scaffold(name: string, templateName: TemplateName, template: TemplateDef, targetDir: string): string[] {
  const created: string[] = []
  fs.mkdirSync(targetDir, { recursive: true })

  const files: FileTemplate[] = [
    { relativePath: "plugin.json", content: (pluginName) => pluginJson(pluginName, template.manifest) },
    { relativePath: "package.json", content: (pluginName) => packageJson(pluginName, templateName) },
    { relativePath: "tsconfig.json", content: tsconfigJson },
    { relativePath: "README.md", content: readmeMd },
    ...template.files,
  ]

  for (const file of files) {
    const filePath = path.join(targetDir, file.relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, file.content(name))
    created.push(filePath)
  }

  return created
}

export const PluginCreateCommand = cmd({
  command: "create <name>",
  describe: "scaffold a new Synergy plugin project",
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

    if (!/^[a-z0-9][-a-z0-9]*$/.test(name)) {
      UI.error(`Invalid plugin name "${name}". Use lowercase letters, digits, and hyphens.`)
      process.exitCode = 1
      return
    }

    if (fs.existsSync(targetDir)) {
      UI.error(`Directory "${targetDir}" already exists. Remove it first or use a different name.`)
      process.exitCode = 1
      return
    }

    const created = scaffold(name, templateName, template, targetDir)

    UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Created plugin "${name}" (${template.label})`)
    UI.println()
    for (const filePath of created) {
      UI.println(`  ${UI.Style.TEXT_DIM}${path.relative(process.cwd(), filePath)}${UI.Style.TEXT_NORMAL}`)
    }
    UI.println()
    UI.println(`${UI.Style.TEXT_DIM}Next: cd ${name} && bun install && bun run validate${UI.Style.TEXT_NORMAL}`)
  },
})
