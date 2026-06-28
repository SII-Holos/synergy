import { assetPath } from "@/utils/proxy"

export const BRAND_ASSETS = {
  synergy: {
    productIcon: "/brand/synergy-product-icon.png",
    notificationIcon: "/favicon-96x96.png",
  },
  holos: {
    logo: "/brand/holos-logo.svg",
    logoDark: "/brand/holos-logo-white.svg",
  },
  sii: {
    logo: "/brand/sii-logo.png",
    name: "Shanghai Innovation Institute",
    url: "https://www.sii.edu.cn",
  },
} as const

export function brandAssetPath(path: string) {
  return assetPath(path)
}

export function holosLogoPath(mode: string | undefined) {
  return brandAssetPath(mode === "dark" ? BRAND_ASSETS.holos.logoDark : BRAND_ASSETS.holos.logo)
}
