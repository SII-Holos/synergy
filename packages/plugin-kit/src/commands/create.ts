import path from "path"
import fs from "fs"
import { EOL } from "os"
import type { Argv } from "yargs"
import {
  PLUGIN_PROTOCOL_MIN_SYNERGY_RANGE,
  PLUGIN_STRUCTURED_THEME_MIN_SYNERGY_RANGE,
  PLUGIN_UI_API_VERSION,
} from "@ericsanchezok/synergy-plugin"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"

type TemplateName = "tool-ui" | "workbench-panel" | "navigation" | "api-connector" | "theme-icon"

const TEMPLATES: TemplateName[] = ["tool-ui", "workbench-panel", "navigation", "api-connector", "theme-icon"]

function currentPackageRange(): string {
  const pkgPath = path.resolve(import.meta.dir, "..", "..", "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string }
  return pkg.version ? `^${pkg.version}` : "latest"
}

interface FileTemplate {
  relativePath: string
  content(name: string): string
}

function pluginJson(name: string, extra: (name: string) => object, minSynergyRange: string): string {
  const base = {
    name,
    version: "0.1.0",
    description: `${name} plugin`,
    engines: {
      synergy: minSynergyRange,
    },
    permissions: {},
    contributes: {},
  }
  return JSON.stringify({ ...base, ...extra(name) }, null, 2) + EOL
}

function packageJson(name: string, templateName: TemplateName): string {
  const needsSolid = templateName !== "theme-icon"
  const toolkitRange = currentPackageRange()
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
      "@ericsanchezok/synergy-plugin": toolkitRange,
      zod: "^4.0.0",
    },
    devDependencies: {
      "@ericsanchezok/synergy-plugin-kit": toolkitRange,
      typescript: "^5.8.0",
      ...(needsSolid ? { "solid-js": "^1.9.0" } : {}),
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

function themeJson(name: string): string {
  const seeds = {
    neutral: "#64748B",
    primary: "#0EA5E9",
    success: "#22C55E",
    warning: "#F59E0B",
    error: "#EF4444",
    info: "#38BDF8",
    interactive: "#0EA5E9",
    diffAdd: "#22C55E",
    diffDelete: "#EF4444",
  }
  return (
    JSON.stringify(
      {
        name,
        id: `${name}-theme`,
        light: { seeds },
        dark: { seeds },
      },
      null,
      2,
    ) + EOL
  )
}

function indexToolUI(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"
import { greet } from "./tools.js"

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

function indexWorkbenchPanel(name: string): string {
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

function indexNavigation(name: string): string {
  return indexWorkbenchPanel(name)
}

function indexApiConnector(name: string): string {
  return `import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"
import { getJSON, postJSON } from "./tools.js"

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

const ALLOWED_API_HOST = "api.example.com"

function allowedApiUrl(input: string) {
  const url = new URL(input)
  if (url.protocol !== "https:") {
    throw new Error("Only https API endpoints are allowed by this template")
  }
  if (url.hostname !== ALLOWED_API_HOST) {
    throw new Error(\`This template only allows \${ALLOWED_API_HOST}. Update plugin.json permissions.network.connectDomains before using another API host.\`)
  }
  return url.toString()
}

export const getJSON = tool({
  description: "Fetch and parse JSON from an API endpoint",
  args: {
    url: tool.schema.string().describe("The API endpoint URL"),
  },
  async execute(args) {
    const res = await fetch(allowedApiUrl(args.url))
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
    const res = await fetch(allowedApiUrl(args.url), {
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

function uiWorkbenchPanel(_name: string): string {
  return `import type { Component } from "solid-js"

const WorkbenchPanel: Component = () => {
  return <div>Workbench panel content</div>
}

export default WorkbenchPanel
`
}

function uiNavigation(_name: string): string {
  return `import type { Component } from "solid-js"

const NavigationView: Component = () => {
  return <div>Navigation content</div>
}

export default NavigationView
`
}

function manifestToolUI(name: string): object {
  return {
    permissions: {
      tools: {
        shell: false,
        filesystem: "none",
        network: false,
        mcp: "none",
      },
      ui: true,
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
        minUIApiVersion: PLUGIN_UI_API_VERSION,
        toolRenderers: [{ tool: "greet" }],
      },
    },
  }
}

function manifestWorkbenchPanel(name: string): object {
  return {
    permissions: {
      ui: true,
    },
    contributes: {
      ui: {
        entry: "./dist/ui/index.js",
        minUIApiVersion: PLUGIN_UI_API_VERSION,
        workbenchPanels: [
          {
            id: `${name}-panel`,
            label: name,
            icon: "layout-panel-left",
            surface: "side",
            cardinality: "singleton",
          },
        ],
      },
    },
  }
}

function manifestNavigation(name: string): object {
  return {
    permissions: {
      ui: true,
    },
    contributes: {
      ui: {
        entry: "./dist/ui/index.js",
        minUIApiVersion: PLUGIN_UI_API_VERSION,
        navigation: [
          {
            id: `${name}-nav`,
            label: name,
            icon: "package",
            placement: "sidebar",
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
        network: true,
        shell: false,
        filesystem: "none",
        mcp: "none",
      },
      network: {
        connectDomains: ["api.example.com"],
      },
      ui: true,
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
        minUIApiVersion: PLUGIN_UI_API_VERSION,
        toolRenderers: [{ tool: "getJSON" }, { tool: "postJSON" }],
      },
    },
  }
}

function manifestThemeIcon(name: string): object {
  return {
    permissions: {
      ui: true,
    },
    contributes: {
      ui: {
        themes: [{ id: `${name}-theme`, label: name, path: "./themes/default.json" }],
        icons: [{ name: `${name}-logo`, path: "./icons/logo.svg" }],
      },
    },
  }
}

interface TemplateDef {
  label: string
  manifest: (name: string) => object
  files: FileTemplate[]
  minSynergyRange?: string
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
  "workbench-panel": {
    label: "Workbench Panel - Solid workbench panel with no tools",
    manifest: manifestWorkbenchPanel,
    files: [
      { relativePath: "src/index.ts", content: indexWorkbenchPanel },
      { relativePath: "src/ui.tsx", content: uiWorkbenchPanel },
    ],
  },
  navigation: {
    label: "Navigation - Solid sidebar navigation with no tools",
    manifest: manifestNavigation,
    files: [
      { relativePath: "src/index.ts", content: indexNavigation },
      { relativePath: "src/ui.tsx", content: uiNavigation },
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
    minSynergyRange: PLUGIN_STRUCTURED_THEME_MIN_SYNERGY_RANGE,
    files: [
      { relativePath: "src/index.ts", content: indexThemeIcon },
      { relativePath: "themes/default.json", content: themeJson },
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
    {
      relativePath: "plugin.json",
      content: (pluginName) =>
        pluginJson(pluginName, template.manifest, template.minSynergyRange ?? PLUGIN_PROTOCOL_MIN_SYNERGY_RANGE),
    },
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
