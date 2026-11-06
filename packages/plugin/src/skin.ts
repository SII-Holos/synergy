import { z } from "zod"

export const PLUGIN_VISUAL_PARTS = [
  "workbench",
  "navigation",
  "content",
  "session",
  "conversation",
  "composer",
  "resource-panel",
  "toolbar",
] as const
export const PluginVisualPart = z.enum(PLUGIN_VISUAL_PARTS)
export type PluginVisualPart = z.infer<typeof PluginVisualPart>

const Identifier = z.string().regex(/^[a-z][a-z0-9-]*$/)
const AssetPath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/[\\\x00-\x1f?#:]/.test(value) &&
      !value.startsWith("/") &&
      value.split("/").every((segment) => segment !== ".." && segment !== "." && segment !== ""),
    "Skin assets must use package-relative paths",
  )
const Asset = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), path: AssetPath.regex(/\.(png|jpe?g|webp|avif|svg)$/i) }).strict(),
  z
    .object({
      kind: z.literal("font"),
      path: AssetPath.regex(/\.(woff2?|ttf|otf)$/i),
      weight: z.number().int().min(100).max(900).default(400),
      style: z.enum(["normal", "italic"]).default("normal"),
    })
    .strict(),
])
const Image = z
  .object({
    asset: Identifier,
    fit: z.enum(["cover", "contain", "auto"]).default("cover"),
    repeat: z.enum(["no-repeat", "repeat"]).default("no-repeat"),
    x: z.number().min(0).max(100).default(50),
    y: z.number().min(0).max(100).default(50),
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict()
const Decoration = z
  .object({
    asset: Identifier,
    anchor: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("bottom-right"),
    width: z.number().min(1).max(100),
    height: z.number().min(1).max(100),
    opacity: z.number().min(0).max(1).default(1),
    narrow: z.enum(["show", "hide"]).default("hide"),
  })
  .strict()
const Material = z
  .object({
    radius: z.number().min(0).max(48).optional(),
    borderWidth: z.number().min(0).max(4).optional(),
    shadow: z.enum(["none", "soft", "raised"]).optional(),
    background: Image.optional(),
    decoration: Decoration.optional(),
  })
  .strict()
const Appearance = z
  .object({
    density: z.enum(["comfortable", "compact"]).optional(),
    typography: z.object({ sans: Identifier.optional(), mono: Identifier.optional() }).strict().optional(),
    parts: z.partialRecord(PluginVisualPart, Material).default({}),
  })
  .strict()

export const Skin = z
  .object({
    version: z.literal(1),
    id: Identifier,
    theme: z.string().min(1).optional(),
    assets: z.record(Identifier, Asset).default({}),
    light: Appearance,
    dark: Appearance,
    narrow: Appearance,
    reducedMotion: z.object({ decorations: z.enum(["show", "hide"]) }).strict(),
  })
  .strict()
  .superRefine((skin, context) => {
    for (const mode of ["light", "dark", "narrow"] as const) {
      const appearance = skin[mode]
      for (const [part, material] of Object.entries(appearance.parts)) {
        for (const kind of ["background", "decoration"] as const) {
          const reference = material?.[kind]?.asset
          if (reference && skin.assets[reference]?.kind !== "image")
            context.addIssue({
              code: "custom",
              path: [mode, "parts", part, kind, "asset"],
              message: `Unknown image asset ${reference}`,
            })
        }
      }
      for (const [kind, reference] of Object.entries(appearance.typography ?? {})) {
        if (reference && skin.assets[reference]?.kind !== "font")
          context.addIssue({
            code: "custom",
            path: [mode, "typography", kind],
            message: `Unknown font asset ${reference}`,
          })
      }
    }
  })

export type Skin = z.infer<typeof Skin>
export type SkinAppearance = z.infer<typeof Appearance>
export function parseSkin(input: unknown): Skin {
  return Skin.parse(input)
}
export function resolveSkinAppearance(skin: Skin, mode: "light" | "dark", narrow: boolean): SkinAppearance {
  const base = skin[mode]
  if (!narrow) return base
  return {
    ...base,
    ...skin.narrow,
    typography: { ...base.typography, ...skin.narrow.typography },
    parts: Object.fromEntries(
      PLUGIN_VISUAL_PARTS.map((part) => [part, { ...base.parts[part], ...skin.narrow.parts[part] }]),
    ),
  }
}
