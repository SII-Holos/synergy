import { Link, Meta } from "@solidjs/meta"

export const Favicon = (props: { assetPrefix?: string }) => {
  const resolve = (path: string) => (props.assetPrefix ? `${props.assetPrefix}${path}` : path)

  return (
    <>
      <Link rel="icon" type="image/png" href={resolve("/favicon-96x96.png")} sizes="96x96" />
      <Link rel="shortcut icon" href={resolve("/favicon.ico")} />
      <Link rel="apple-touch-icon" sizes="180x180" href={resolve("/apple-touch-icon.png")} />
      <Link rel="manifest" href={resolve("/site.webmanifest")} />
      <Meta name="apple-mobile-web-app-title" content="Synergy" />
    </>
  )
}
