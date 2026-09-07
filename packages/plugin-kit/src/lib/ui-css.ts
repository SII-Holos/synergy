import type { CssNode } from "css-tree"

// The CommonJS export uses static JSON requires, which Bun embeds in compiled CLIs.
const { generate, ident, parse, walk }: typeof import("css-tree") = require("css-tree")

const localRules = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "starting-style",
  "font-face",
  "keyframes",
  "-webkit-keyframes",
])
const animationKeywords = new Set([
  "none",
  "initial",
  "inherit",
  "unset",
  "revert",
  "revert-layer",
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
  "infinite",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
  "auto",
])

function name(node: CssNode | null | undefined): string | undefined {
  return node?.type === "Identifier" ? ident.decode(node.name) : node?.type === "String" ? node.value : undefined
}

function rename(node: CssNode, value: string) {
  if (node.type === "Identifier") node.name = ident.encode(value)
  if (node.type === "String") node.value = value
}

// CSS AST transformation follows https://github.com/csstree/csstree. Native
// scope limits keep nested host views and other plugins outside this sheet:
// https://drafts.csswg.org/css-cascade-6/#scoped-styles
export function scopePluginCSS(source: string, pluginId: string): string {
  const prefix = `p_${Array.from(new TextEncoder().encode(pluginId), (value) => value.toString(16).padStart(2, "0")).join("")}_`
  const ast = parse(source, {
    parseCustomProperty: true,
    onParseError(error) {
      throw error
    },
  })
  const animations = new Map<string, string>()
  const fonts = new Map<string, string>()
  walk(ast, {
    enter(node: CssNode) {
      if (node.type === "Raw") throw new Error("Plugin CSS contains unparsed syntax")
      if (node.type === "TypeSelector" && ["html", "body"].includes(ident.decode(node.name).toLowerCase()))
        throw new Error("Plugin CSS cannot target the host document")
      if (
        node.type === "PseudoClassSelector" &&
        ["root", "global", "host", "host-context"].includes(ident.decode(node.name).toLowerCase())
      )
        throw new Error("Plugin CSS must use :scope for its own root")
      if (node.type === "Url" && /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(node.value) && !node.value.startsWith("data:"))
        throw new Error("Plugin CSS resources must be packaged relative assets")
      if (node.type !== "Atrule") return
      const rule = node.name.toLowerCase()
      if (!localRules.has(rule)) throw new Error(`Plugin CSS does not support @${rule}`)
      if (rule.endsWith("keyframes")) {
        const token = node.prelude?.type === "AtrulePrelude" ? node.prelude.children.first : undefined
        const value = name(token)
        if (!value || animationKeywords.has(value))
          throw new Error("Plugin keyframes require an unambiguous custom name")
        animations.set(value, prefix + value)
        rename(token!, prefix + value)
      }
      if (rule === "font-face") {
        const family = node.block?.children
          .toArray()
          .find((child) => child.type === "Declaration" && child.property === "font-family")
        const tokens =
          family?.type === "Declaration" && family.value.type === "Value" ? family.value.children.toArray() : []
        const value = name(tokens[0])
        if (tokens.length !== 1 || !value)
          throw new Error("Plugin font-family names must be a single identifier or quoted string")
        fonts.set(value, prefix + value)
      }
      if (rule === "layer" && node.prelude) {
        walk(node.prelude, (child) => {
          if (child.type === "Layer") child.name = prefix + child.name
        })
      }
    },
  })
  walk(ast, {
    visit: "Declaration",
    enter(node) {
      const property = node.property.toLowerCase()
      const names = property.includes("animation")
        ? animations
        : property === "font" || property === "font-family"
          ? fonts
          : undefined
      if (!names) return
      walk(node.value, (token) => {
        const value = name(token)
        const scoped = value && names.get(value)
        if (scoped) rename(token, scoped)
      })
    },
  })
  return `@scope ([data-plugin-ui=${JSON.stringify(pluginId)}]) to ([data-plugin-ui]){${generate(ast)}}`
}
