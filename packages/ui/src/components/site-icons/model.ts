import type { IconName } from "./types"

// Hostname to brand mark. Entries are registered on the site's own domain; the
// parent-domain walk in siteIcon() extends each one to its subdomains, so
// "en.wikipedia.org" and "www.notion.so" resolve without an entry per subdomain.
// A host that is absent here intentionally falls back to the neutral globe.
export const siteIconHosts: Record<string, IconName> = {
  "anthropic.com": "anthropic",
  "claude.ai": "anthropic",
  "arxiv.org": "arxiv",
  "bilibili.com": "bilibili",
  "bitbucket.org": "bitbucket",
  "bun.sh": "bun",
  "cloudflare.com": "cloudflare",
  "deno.com": "deno",
  "deno.land": "deno",
  "discord.com": "discord",
  "discord.gg": "discord",
  "docker.com": "docker",
  "figma.com": "figma",
  "github.com": "github",
  "gitlab.com": "gitlab",
  // Search results are a distinct destination from the provider's own site.
  "scholar.google.com": "googlescholar",
  "huggingface.co": "huggingface",
  "ieee.org": "ieee",
  "juejin.cn": "juejin",
  "kubernetes.io": "kubernetes",
  "linear.app": "linear",
  "linkedin.com": "linkedin",
  "developer.mozilla.org": "mdnwebdocs",
  "medium.com": "medium",
  "netlify.com": "netlify",
  "nodejs.org": "nodedotjs",
  "notion.site": "notion",
  "notion.so": "notion",
  "npmjs.com": "npm",
  "obsidian.md": "obsidian",
  "chatgpt.com": "openai",
  "openai.com": "openai",
  "paperswithcode.com": "paperswithcode",
  "pypi.org": "pypi",
  "python.org": "python",
  "pytorch.org": "pytorch",
  "react.dev": "react",
  "reactjs.org": "react",
  "reddit.com": "reddit",
  "rust-lang.org": "rust",
  "semanticscholar.org": "semanticscholar",
  "slack.com": "slack",
  "spotify.com": "spotify",
  "stackoverflow.com": "stackoverflow",
  "substack.com": "substack",
  "svelte.dev": "svelte",
  "twitch.tv": "twitch",
  "vercel.com": "vercel",
  "vite.dev": "vite",
  "vitejs.dev": "vite",
  "vuejs.org": "vuedotjs",
  "wikipedia.org": "wikipedia",
  "twitter.com": "x",
  "x.com": "x",
  "youtu.be": "youtube",
  "youtube.com": "youtube",
  "zhihu.com": "zhihu",
}

/** Resolves a hostname to its brand mark. Matching is exact per label-suffix,
 *  never a string comparison, so `github.example.org` and `github.com@evil.test`
 *  cannot borrow the GitHub mark through a lookalike host. */
export function siteIcon(hostname: string): IconName | undefined {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".")
  // The bare top-level domain is never a site identity.
  for (let index = 0; index < labels.length - 1; index++) {
    const icon = siteIconHosts[labels.slice(index).join(".")]
    if (icon) return icon
  }
}
