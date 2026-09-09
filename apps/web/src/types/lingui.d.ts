declare module "*.po" {
  export const messages: Record<string, string>
}

declare module "*.po?lingui" {
  export const messages: Record<string, string>
}
