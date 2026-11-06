declare module "babel-preset-solid" {
  import type { PresetAPI, PresetObject } from "@babel/core"

  export default function solid(api: PresetAPI, options: { generate?: "dom" | "ssr" }): PresetObject
}
