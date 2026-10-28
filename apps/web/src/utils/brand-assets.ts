import { assetPath } from "@/utils/proxy"

export const BRAND_ASSETS = {
  synergy: {
    productIcon: "/brand/synergy-product-icon.png",
    notificationIcon: "/favicon-96x96.png",
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
