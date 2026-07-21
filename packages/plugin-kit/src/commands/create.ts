import fs from "fs"
import path from "path"
import type { Argv } from "yargs"
import { renderThemeSchemaJson } from "@ericsanchezok/synergy-plugin/theme"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"

type TemplateName = "tool-ui" | "workbench-panel" | "navigation" | "api-connector" | "theme-icon"

const templates: TemplateName[] = ["tool-ui", "workbench-panel", "navigation", "api-connector", "theme-icon"]

function currentPackageRange(): string {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "..", "..", "package.json"), "utf-8")) as {
    version?: string
  }
  return pkg.version ? `^${pkg.version}` : "latest"
}

function packageJson(name: string, usesSolid: boolean) {
  const version = currentPackageRange()
  return JSON.stringify(
    {
      name,
      version: "0.1.0",
      type: "module",
      source: "./src/index.ts",
      scripts: {
        dev: "synergy-plugin dev",
        validate: "synergy-plugin validate --runtime-discovery",
        build: "synergy-plugin build",
        pack: "synergy-plugin pack",
        test: "synergy-plugin test",
      },
      dependencies: {
        "@ericsanchezok/synergy-plugin": version,
        zod: "^4.0.0",
        ...(usesSolid ? { "solid-js": "^1.9.0" } : {}),
      },
      devDependencies: { "@ericsanchezok/synergy-plugin-kit": version, typescript: "^5.8.0" },
    },
    null,
    2,
  )
}

function tsconfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        jsx: "preserve",
        jsxImportSource: "solid-js",
      },
      include: ["src"],
    },
    null,
    2,
  )
}

function definition(name: string, template: TemplateName): string {
  if (template === "tool-ui") {
    return `import z from "zod"
import { definePlugin, messageRenderer, tool } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "${name}",
  version: "0.1.0",
  description: "${name} plugin",
  contributions: [
    tool({
      id: "greet",
      description: "Greet a user by name",
      input: z.object({ name: z.string() }),
      handler: async ({ name }) => ({ output: \`Hello, \${name}!\` }),
    }),
    messageRenderer({
      id: "greet-result",
      label: "Greeting",
      messageType: "tool:greet",
      component: { source: "./src/ui.tsx" },
    }),
  ],
})
`
  }
  if (template === "workbench-panel") {
    return `import { definePlugin, workbenchPanel } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "${name}",
  version: "0.1.0",
  description: "${name} plugin",
  contributions: [workbenchPanel({
    id: "main",
    label: "${name}",
    icon: "layout-panel-left",
    surface: "side",
    cardinality: "singleton",
    component: { source: "./src/ui.tsx" },
  })],
})
`
  }
  if (template === "navigation") {
    return `import { definePlugin, navigationItem } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "${name}",
  version: "0.1.0",
  description: "${name} plugin",
  contributions: [navigationItem({
    id: "main",
    label: "${name}",
    icon: "package",
    placement: "sidebar",
    component: { source: "./src/ui.tsx" },
  })],
})
`
  }
  if (template === "api-connector") {
    return `import z from "zod"
import { definePlugin, tool } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "${name}",
  version: "0.1.0",
  description: "${name} plugin",
  contributions: [tool({
    id: "get-json",
    description: "Fetch JSON from a trusted API",
    input: z.object({ url: z.string().url() }),
    handler: async ({ url }) => ({ output: JSON.stringify(await fetch(url).then((response) => response.json()), null, 2) }),
  })],
})
`
  }
  return `import { definePlugin, icon, theme } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "${name}",
  version: "0.1.0",
  description: "${name} plugin",
  contributions: [
    theme({ id: "default", label: "${name}", path: "themes/default.json" }),
    icon({ id: "logo", path: "icons/logo.svg" }),
  ],
})
`
}

function ui(template: TemplateName): string | undefined {
  if (!(["tool-ui", "workbench-panel", "navigation"] as TemplateName[]).includes(template)) return undefined
  return `import type { Component } from "solid-js"
import type { PluginSurfaceContext } from "@ericsanchezok/synergy-plugin/ui"

const PluginSurface: Component<{ context: PluginSurfaceContext }> = (props) => (
  <section aria-label={props.context.surface.id}>Plugin content</section>
)

export default PluginSurface
`
}

export function scaffoldPluginProject(name: string, template: TemplateName, targetDir: string): string[] {
  const usesSolid = Boolean(ui(template))
  const files = new Map<string, string>([
    ["package.json", packageJson(name, usesSolid)],
    ["tsconfig.json", tsconfig()],
    [".gitignore", "dist/\n*.tgz\n"],
    ["src/index.ts", definition(name, template)],
    ["README.md", `# ${name}\n\nThe installable plugin.json is generated by \`bun run build\`.\n`],
  ])
  const uiSource = ui(template)
  if (uiSource) files.set("src/ui.tsx", uiSource)
  if (template === "theme-icon") {
    files.set("themes/theme.schema.json", renderThemeSchemaJson())
    files.set(
      "themes/default.json",
      JSON.stringify(
        {
          $schema: "./theme.schema.json",
          name,
          id: "default",
          light: {
            seeds: {
              neutral: "#6B7280",
              primary: "#2563EB",
              success: "#16A34A",
              warning: "#D97706",
              error: "#DC2626",
              info: "#0284C7",
              interactive: "#2563EB",
              diffAdd: "#16A34A",
              diffDelete: "#DC2626",
            },
          },
          dark: {
            seeds: {
              neutral: "#9CA3AF",
              primary: "#60A5FA",
              success: "#4ADE80",
              warning: "#FBBF24",
              error: "#F87171",
              info: "#38BDF8",
              interactive: "#60A5FA",
              diffAdd: "#4ADE80",
              diffDelete: "#F87171",
            },
          },
        },
        null,
        2,
      ),
    )
    files.set(
      "icons/logo.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>\n',
    )
  }

  const created: string[] = []
  for (const [relative, content] of files) {
    const file = path.join(targetDir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${content.trimEnd()}\n`)
    created.push(file)
  }
  return created
}

export const PluginCreateCommand = cmd({
  command: "create <name>",
  describe: "scaffold a definePlugin() project",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("template", { type: "string", choices: templates, default: "tool-ui" }),
  async handler(args) {
    const name = String(args.name)
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      UI.error(`Invalid plugin id "${name}"`)
      process.exitCode = 1
      return
    }
    const target = path.resolve(process.cwd(), name)
    if (fs.existsSync(target)) {
      UI.error(`Directory already exists: ${target}`)
      process.exitCode = 1
      return
    }
    const created = scaffoldPluginProject(name, args.template as TemplateName, target)
    UI.println(`${UI.Style.TEXT_SUCCESS}Created${UI.Style.TEXT_NORMAL} ${name}`)
    for (const file of created) UI.println(`  ${path.relative(process.cwd(), file)}`)
  },
})
