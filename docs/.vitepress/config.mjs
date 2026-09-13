import { defineConfig } from "vitepress";

const base = process.env.DOCS_BASE || "/docs/";

export default defineConfig({
  title: "Navigator",
  description:
    "MCP server for web search, page extraction, screenshots, and browser automation",

  base,
  outDir: "../docs-dist",

  ignoreDeadLinks: true,

  head: [
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    [
      "link",
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: "",
      },
    ],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap",
      },
    ],
    ["link", { rel: "icon", href: `${base}navigator-logo.png` }],
    [
      "meta",
      {
        property: "og:title",
        content: "Navigator — MCP Browser Server",
      },
    ],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Give your MCP client a real browser for web search, readable page extraction, screenshots, and browser automation.",
      },
    ],
    [
      "meta",
      {
        property: "og:image",
        content: "https://craftpip.github.io/navigator/og-image.png",
      },
    ],
  ],

  themeConfig: {
    logo: "/navigator-logo.png",
    siteTitle: "Navigator",

    nav: [
      { text: "Home", link: "/" },
      { text: "Docs", link: "/guides/getting-started" },
      { text: "Changelog", link: "/changelog" },
    ],

    sidebar: [
      {
        text: "Getting Started",
        collapsible: true,
        collapsed: true,
        items: [
          { text: "Getting Started", link: "/guides/getting-started" },
          { text: "First Search", link: "/guides/first-search" },
          { text: "Development Tools", link: "/guides/dev-tools" },
          { text: "Agent Instructions", link: "/guides/agent-instructions" },
        ],
      },
      {
        text: "Web Search Tool",
        collapsible: true,
        collapsed: true,
        items: [
          { text: "Overview", link: "/guides/search/overview" },
          { text: "Search Queue", link: "/guides/search/routing" },
          { text: "Engines", link: "/guides/search/engines" },
          { text: "Results", link: "/guides/search/results" },
          { text: "Tips", link: "/guides/search/tips" },
        ],
      },
      {
        text: "Web Fetch Tool",
        collapsible: true,
        collapsed: true,
        items: [
          { text: "Overview", link: "/guides/extraction/overview" },
          { text: "Extractors", link: "/guides/extraction/formats" },
          { text: "Domain Hints", link: "/guides/extraction/domain-hints" },
        ],
      },
      {
        text: "Post-processors",
        collapsible: true,
        collapsed: true,
        items: [
          { text: "Overview", link: "/guides/extraction/ai-extractors" },
          { text: "OpenAI Compatible APIs", link: "/guides/extraction/openai-compatible" },
          { text: "MinerU", link: "/guides/extraction/mineru" },
          { text: "Custom API", link: "/guides/extraction/custom-api" },
        ],
      },
      {
        text: "Screenshots",
        collapsible: true,
        collapsed: true,
        items: [
          { text: "Overview", link: "/guides/screenshots/overview" },
          { text: "Output Options", link: "/guides/screenshots/output" },
          { text: "ASCII Renders", link: "/guides/screenshots/ascii" },
          { text: "SVG Renders", link: "/guides/screenshots/svg" },
        ],
      },
      {
        text: "DevTools",
        collapsible: true,
        collapsed: true,
        items: [
          { text: "Overview", link: "/guides/devtools/overview" },
          { text: "Tabs & Navigation", link: "/guides/devtools/tabs" },
          { text: "DOM", link: "/guides/devtools/dom" },
          { text: "Network", link: "/guides/devtools/network" },
          { text: "Interaction", link: "/guides/devtools/interaction" },
        ],
      },
      {
        text: "Browsers",
        collapsible: true,
        collapsed: true,
        items: [
          { text: "Overview", link: "/guides/browsers/overview" },
          { text: "External CDP Browsers", link: "/guides/browsers/cdp-addons" },
          { text: "CloakBrowser", link: "/guides/browsers/cloakbrowser" },
          { text: "Lightpanda", link: "/guides/browsers/lightpanda" },
          { text: "Chrome Extension", link: "/guides/browsers/chrome-extension" },
          { text: "Firefox Extension", link: "/guides/browsers/firefox-extension" },
          { text: "CDP Sharing", link: "/guides/browsers/cdp-sharing" },
        ],
      },
      {
        text: "Self-Hosting",
        collapsible: true,
        collapsed: true,
        items: [
          { text: "Overview", link: "/guides/self-hosting/overview" },
          { text: "Environment Variables", link: "/guides/self-hosting/env-vars" },
          { text: "Operations", link: "/guides/self-hosting/operations" },
        ],
      },
      {
        text: "Reference Content",
        collapsible: true,
        collapsed: true,
        items: [
          {
            text: "API",
            collapsible: true,
            collapsed: true,
            items: [
              { text: "MCP and HTTP", link: "/api/mcp-and-http" },
              { text: "Tool Reference", link: "/api/tool-reference" },
            ],
          },
          {
            text: "Architecture",
            collapsible: true,
            collapsed: true,
            items: [
              { text: "Overview", link: "/architecture/overview" },
              { text: "Browser Runtime and DevTools", link: "/architecture/browser-runtime" },
            ],
          },
          {
            text: "Code",
            collapsible: true,
            collapsed: true,
            items: [
              { text: "Core Server and Search", link: "/code/core-server-search" },
              { text: "Browser and DevTools", link: "/code/browser-and-devtools" },
              { text: "Search Drivers", link: "/code/search-drivers" },
              { text: "Support Modules", link: "/code/support-modules" },
              { text: "Runtime and Tests", link: "/code/runtime-and-tests" },
            ],
          },
          {
            text: "Operations",
            collapsible: true,
            collapsed: true,
            items: [
              { text: "Operations and Configuration", link: "/operations/operations-and-configuration" },
            ],
          },
          {
            text: "Browsers",
            collapsible: true,
            collapsed: true,
            items: [
              { text: "BROWSERS Array", link: "/reference/browsers/browser-array" },
              { text: "External CDP", link: "/reference/browsers/external-cdp" },
              { text: "CDP Sharing", link: "/reference/browsers/cdp-sharing" },
              { text: "CloakBrowser", link: "/reference/browsers/cloakbrowser" },
              { text: "Lightpanda", link: "/reference/browsers/lightpanda" },
              { text: "Relay Extensions", link: "/reference/browsers/extensions" },
            ],
          },
          {
            text: "Reference",
            collapsible: true,
            collapsed: true,
            items: [
              { text: "Source Map", link: "/reference/source-reference" },
            ],
          },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/craftpip/navigator" },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern:
        "https://github.com/craftpip/navigator/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the Apache-2.0 License.",
      copyright: "Copyright © 2026 craftpip",
    },
  },
});
