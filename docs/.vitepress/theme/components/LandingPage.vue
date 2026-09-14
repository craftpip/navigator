<template>
  <div class="lp" :class="{ 'is-scrolled': isScrolled }">
    <section class="hero">
      <ForestCanvas />
      <div class="hero-shell">
        <div class="hero-content">
          <span class="pill">MCP Server</span>
          <h1 class="title">Your AI's Web Browser</h1>
          <p class="subtitle">Search, read, and interact with the real web.</p>
          <p class="desc">
            Navigator gives your MCP client a real Chromium browser. Search across 12 engines,
            extract clean content from any page, capture screenshots, and drive live sessions —
            all through one self-hosted server that works with Claude, Cursor, OpenCode, and more.
          </p>
          <div class="ctas">
            <a :href="withBase('/guides/getting-started.html')" class="cta-primary">
              Get Started
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </a>
            <a href="https://github.com/craftpip/navigator" class="cta-secondary" target="_blank">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
              GitHub
            </a>
          </div>
        </div>
        <div class="shot-wrap">
          <div class="shot-frame">
            <div class="shot-chrome" aria-hidden="true">
              <div class="shot-dots"><span></span><span></span><span></span></div>
              <span class="shot-address">localhost:1994</span>
            </div>
            <div class="shot-screen">
              <img src="/console-dark.jpg" alt="Navigator console" class="shot-dark" />
              <img src="/console-light.jpg" alt="Navigator console" class="shot-light" />
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="logos">
      <p class="logos-label">Works with your stack</p>
      <div class="logos-row">
        <span>Claude Desktop</span>
        <span class="sep">/</span>
        <span>OpenCode</span>
        <span class="sep">/</span>
        <span>Cursor</span>
        <span class="sep">/</span>
        <span>Windsurf</span>
        <span class="sep">/</span>
        <span>Any MCP Client</span>
      </div>
    </section>

    <section class="section features" ref="featuresRef">
      <div class="inner">
        <h2>Built for agents. Visible to you.</h2>
        <p class="lead">Every capability your agent needs to navigate the real web — optimized to waste as few tokens as possible.</p>
        <div class="feature-list">
          <div class="feature-row" v-for="(f, i) in features" :key="f.name" :class="{ reverse: i % 2 === 1 }">
            <FeatureVisual class="feature-illust" :type="f.visual" />
            <div class="feature-text">
              <h3>{{ f.name }}</h3>
              <p>{{ f.desc }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section why" ref="whyRef">
      <div class="inner">
        <h2>Why Navigator</h2>
        <div class="grid-2">
          <div class="card" v-for="w in why" :key="w.title">
            <div class="card-icon" :style="{ background: w.bg, color: w.fg }">
              <span v-html="w.icon"></span>
            </div>
            <h3>{{ w.title }}</h3>
            <p>{{ w.desc }}</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section audience" ref="statsRef">
      <div class="inner">
        <div class="audience-row">
          <div class="audience-item">
            <h3>For developers</h3>
            <p>Build MCP-powered tools that browse the real web — with full CDP control, custom extraction, and a test suite you can run locally.</p>
          </div>
          <div class="audience-item">
            <h3>For hobbyists</h3>
            <p>Gather, extract, and analyze web content at scale — with multi-engine search, per-domain hints, and token-optimized output.</p>
          </div>
          <div class="audience-item">
            <h3>For all your agents</h3>
            <p>Self-hosted, private, no data leaves your network — one Docker container, works with any MCP client your team already uses.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section cta-bottom" ref="ctaRef">
      <h2>Give your agents the real web.</h2>
      <p>Self-hosted. Private. Runs in a single container.</p>
      <div class="ctas" style="margin-top:28px">
        <a :href="withBase('/guides/getting-started.html')" class="cta-primary">
          Get Started
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>
        <a href="https://github.com/craftpip/navigator" class="cta-secondary" target="_blank">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          GitHub
        </a>
      </div>
    </section>

    <footer class="lp-foot">
      <span>Apache-2.0</span>
      <span class="dot">&middot;</span>
      <a href="https://github.com/craftpip/navigator">GitHub</a>
      <span class="dot">&middot;</span>
      <a :href="withBase('/changelog.html')">Changelog</a>
    </footer>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { withBase } from 'vitepress'
import ForestCanvas from './ForestCanvas.vue'
import FeatureVisual from './FeatureVisual.vue'

const featuresRef = ref(null)
const whyRef = ref(null)
const statsRef = ref(null)
const ctaRef = ref(null)
const isScrolled = ref(false)
let observer = null

const updateScrollState = () => {
  isScrolled.value = window.scrollY > 0
}

onMounted(() => {
  updateScrollState()
  window.addEventListener('scroll', updateScrollState, { passive: true })
  const els = [featuresRef.value, whyRef.value, statsRef.value, ctaRef.value].filter(Boolean)
  observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('show'); observer.unobserve(e.target) }
    }
  }, { threshold: 0.1 })
  els.forEach(el => observer.observe(el))
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('scroll', updateScrollState)
})

const features = [
  {
    name: 'Smart Search Routing',
    visual: 'search',
    desc: 'Twelve search routes across four backends. A smart queue scores, ranks, and rotates engines — when one fails, circuit breakers swap to the next instantly. Your search never stops.',
    illustration: `<svg viewBox="0 0 480 280" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g>
        <rect x="30" y="28" width="110" height="42" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>
        <circle cx="52" cy="49" r="8" fill="none" stroke="#059669" stroke-width="2"/>
        <line x1="58" y1="55" x2="64" y2="61" stroke="#059669" stroke-width="2" stroke-linecap="round"/>
        <rect x="72" y="44" width="50" height="5" rx="2" fill="#059669" opacity="0.25"/>
        <rect x="72" y="53" width="35" height="4" rx="2" fill="#059669" opacity="0.15"/>
        <rect x="30" y="82" width="110" height="42" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>
        <circle cx="52" cy="103" r="8" fill="none" stroke="#059669" stroke-width="2"/>
        <line x1="58" y1="109" x2="64" y2="115" stroke="#059669" stroke-width="2" stroke-linecap="round"/>
        <rect x="72" y="98" width="50" height="5" rx="2" fill="#059669" opacity="0.25"/>
        <rect x="72" y="107" width="35" height="4" rx="2" fill="#059669" opacity="0.15"/>
        <rect x="30" y="136" width="110" height="42" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="2.5"/>
        <circle cx="52" cy="157" r="8" fill="none" stroke="#2563eb" stroke-width="2.5"/>
        <line x1="58" y1="163" x2="64" y2="169" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round"/>
        <rect x="72" y="152" width="50" height="5" rx="2" fill="#2563eb" opacity="0.35"/>
        <rect x="72" y="161" width="35" height="4" rx="2" fill="#2563eb" opacity="0.2"/>
        <rect x="30" y="190" width="110" height="42" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>
        <circle cx="52" cy="211" r="8" fill="none" stroke="#059669" stroke-width="2"/>
        <line x1="58" y1="217" x2="64" y2="223" stroke="#059669" stroke-width="2" stroke-linecap="round"/>
        <rect x="72" y="206" width="50" height="5" rx="2" fill="#059669" opacity="0.25"/>
        <rect x="72" y="215" width="35" height="4" rx="2" fill="#059669" opacity="0.15"/>
        <rect x="30" y="244" width="110" height="42" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>
        <circle cx="52" cy="265" r="8" fill="none" stroke="#059669" stroke-width="2"/>
        <line x1="58" y1="271" x2="64" y2="277" stroke="#059669" stroke-width="2" stroke-linecap="round"/>
        <rect x="72" y="260" width="50" height="5" rx="2" fill="#059669" opacity="0.25"/>
        <rect x="72" y="269" width="35" height="4" rx="2" fill="#059669" opacity="0.15"/>
      </g>
      <polygon points="240,100 290,125 290,175 240,200 190,175 190,125" fill="#2563eb" opacity="0.08" stroke="#2563eb" stroke-width="2"/>
      <polygon points="240,120 270,135 270,165 240,180 210,165 210,135" fill="#2563eb" opacity="0.12"/>
      <path d="M225,145 L255,135" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M250,131 L255,135 L251,140" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M255,155 L225,165" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M230,169 L225,165 L229,160" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <g opacity="0.4">
        <rect x="340" y="55" width="110" height="42" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
        <circle cx="362" cy="76" r="8" fill="none" stroke="#7c3aed" stroke-width="1.5"/>
        <line x1="368" y1="82" x2="374" y2="88" stroke="#7c3aed" stroke-width="1.5" stroke-linecap="round"/>
        <rect x="382" y="71" width="50" height="5" rx="2" fill="#7c3aed" opacity="0.3"/>
        <rect x="382" y="80" width="35" height="4" rx="2" fill="#7c3aed" opacity="0.2"/>
        <rect x="340" y="115" width="110" height="42" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
        <circle cx="362" cy="136" r="8" fill="none" stroke="#7c3aed" stroke-width="1.5"/>
        <line x1="368" y1="142" x2="374" y2="148" stroke="#7c3aed" stroke-width="1.5" stroke-linecap="round"/>
        <rect x="382" y="131" width="50" height="5" rx="2" fill="#7c3aed" opacity="0.3"/>
        <rect x="382" y="140" width="35" height="4" rx="2" fill="#7c3aed" opacity="0.2"/>
        <rect x="340" y="175" width="110" height="42" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
        <circle cx="362" cy="196" r="8" fill="none" stroke="#7c3aed" stroke-width="1.5"/>
        <line x1="368" y1="202" x2="374" y2="208" stroke="#7c3aed" stroke-width="1.5" stroke-linecap="round"/>
        <rect x="382" y="191" width="50" height="5" rx="2" fill="#7c3aed" opacity="0.3"/>
        <rect x="382" y="200" width="35" height="4" rx="2" fill="#7c3aed" opacity="0.2"/>
      </g>
      <line x1="140" y1="49" x2="190" y2="130" stroke="#059669" stroke-width="1" opacity="0.25"/>
      <line x1="140" y1="103" x2="190" y2="140" stroke="#059669" stroke-width="1" opacity="0.25"/>
      <line x1="140" y1="157" x2="190" y2="150" stroke="#2563eb" stroke-width="3" opacity="0.85"/>
      <line x1="140" y1="211" x2="190" y2="160" stroke="#059669" stroke-width="1" opacity="0.25"/>
      <line x1="140" y1="265" x2="190" y2="170" stroke="#059669" stroke-width="1" opacity="0.25"/>
      <line x1="290" y1="135" x2="340" y2="76" stroke="#7c3aed" stroke-width="1" opacity="0.2"/>
      <line x1="290" y1="145" x2="340" y2="136" stroke="#7c3aed" stroke-width="1" opacity="0.2"/>
      <line x1="290" y1="165" x2="340" y2="196" stroke="#7c3aed" stroke-width="1" opacity="0.2"/>
      <rect x="205" y="220" width="70" height="28" rx="14" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
      <path d="M233,228 L240,240 L237,240 L243,250" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`
  },
  {
    name: 'Flexible Content Extraction',
    visual: 'extract',
    desc: 'Readability to Markdown, Trafilatura to Markdown, raw HTML, plain text, or tables-only. Run the output through an AI post-processor or any custom API you wire up. The web is not built the same everywhere — neither is the output.',
    illustration: `<svg viewBox="0 0 480 280" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="40" width="120" height="200" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
      <text x="40" y="75" font-size="22" font-weight="700" fill="#dc2626" opacity="0.4" font-family="monospace">&lt;/&gt;</text>
      <rect x="35" y="95" width="90" height="6" rx="2" fill="#fca5a5" opacity="0.5"/>
      <rect x="35" y="108" width="70" height="5" rx="2" fill="#fca5a5" opacity="0.35"/>
      <rect x="35" y="120" width="85" height="5" rx="2" fill="#fca5a5" opacity="0.4"/>
      <rect x="35" y="132" width="55" height="5" rx="2" fill="#fca5a5" opacity="0.3"/>
      <rect x="35" y="144" width="80" height="5" rx="2" fill="#fca5a5" opacity="0.35"/>
      <rect x="35" y="156" width="65" height="5" rx="2" fill="#fca5a5" opacity="0.3"/>
      <rect x="35" y="168" width="90" height="5" rx="2" fill="#fca5a5" opacity="0.4"/>
      <rect x="35" y="180" width="50" height="5" rx="2" fill="#fca5a5" opacity="0.3"/>
      <rect x="35" y="192" width="75" height="5" rx="2" fill="#fca5a5" opacity="0.35"/>
      <rect x="35" y="204" width="60" height="5" rx="2" fill="#fca5a5" opacity="0.3"/>
      <path d="M150,140 L185,140" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 4"/>
      <path d="M180,135 L188,140 L180,145" fill="#94a3b8"/>
      <rect x="195" y="30" width="110" height="40" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
      <rect x="207" y="42" width="16" height="16" rx="3" fill="#2563eb" opacity="0.2"/>
      <text x="215" y="54" text-anchor="middle" font-size="10" fill="#2563eb" opacity="0.6" font-family="serif">R</text>
      <rect x="230" y="46" width="55" height="5" rx="2" fill="#2563eb" opacity="0.25"/>
      <rect x="230" y="55" width="40" height="4" rx="2" fill="#2563eb" opacity="0.15"/>
      <rect x="195" y="82" width="110" height="40" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>
      <rect x="207" y="94" width="16" height="16" rx="3" fill="#059669" opacity="0.2"/>
      <text x="215" y="106" text-anchor="middle" font-size="10" fill="#059669" opacity="0.6" font-family="serif">T</text>
      <rect x="230" y="100" width="55" height="5" rx="2" fill="#059669" opacity="0.25"/>
      <rect x="230" y="109" width="40" height="4" rx="2" fill="#059669" opacity="0.15"/>
      <rect x="195" y="134" width="110" height="40" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
      <rect x="207" y="146" width="16" height="16" rx="3" fill="#7c3aed" opacity="0.2"/>
      <text x="215" y="158" text-anchor="middle" font-size="10" fill="#7c3aed" opacity="0.6" font-family="serif">H</text>
      <rect x="230" y="152" width="55" height="5" rx="2" fill="#7c3aed" opacity="0.25"/>
      <rect x="230" y="161" width="40" height="4" rx="2" fill="#7c3aed" opacity="0.15"/>
      <rect x="195" y="186" width="110" height="40" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
      <rect x="207" y="198" width="16" height="16" rx="3" fill="#dc2626" opacity="0.15"/>
      <text x="215" y="210" text-anchor="middle" font-size="10" fill="#dc2626" opacity="0.5" font-family="serif">TX</text>
      <rect x="230" y="204" width="55" height="5" rx="2" fill="#dc2626" opacity="0.2"/>
      <rect x="230" y="213" width="40" height="4" rx="2" fill="#dc2626" opacity="0.12"/>
      <line x1="305" y1="50" x2="350" y2="100" stroke="#94a3b8" stroke-width="1" opacity="0.3"/>
      <line x1="305" y1="102" x2="350" y2="110" stroke="#94a3b8" stroke-width="1" opacity="0.3"/>
      <line x1="305" y1="154" x2="350" y2="120" stroke="#94a3b8" stroke-width="1" opacity="0.3"/>
      <line x1="305" y1="206" x2="350" y2="130" stroke="#94a3b8" stroke-width="1" opacity="0.3"/>
      <rect x="355" y="70" width="100" height="100" rx="12" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
      <circle cx="405" cy="108" r="22" fill="none" stroke="#2563eb" stroke-width="2" opacity="0.5"/>
      <circle cx="396" cy="104" r="8" fill="#2563eb" opacity="0.15"/>
      <circle cx="414" cy="104" r="8" fill="#2563eb" opacity="0.15"/>
      <path d="M396,116 Q405,124 414,116" stroke="#2563eb" stroke-width="1.5" fill="none" opacity="0.5"/>
      <circle cx="375" cy="82" r="2" fill="#2563eb" opacity="0.4"/>
      <circle cx="435" cy="82" r="2" fill="#2563eb" opacity="0.4"/>
      <circle cx="375" cy="158" r="2" fill="#2563eb" opacity="0.3"/>
      <circle cx="435" cy="158" r="2" fill="#2563eb" opacity="0.3"/>
      <path d="M405,170 L405,200" stroke="#059669" stroke-width="2" stroke-dasharray="5 4"/>
      <path d="M400,195 L405,203 L410,195" fill="#059669"/>
      <rect x="355" y="208" width="100" height="50" rx="10" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
      <rect x="370" y="222" width="6" height="6" rx="1" fill="#059669" opacity="0.5"/>
      <rect x="382" y="223" width="50" height="4" rx="2" fill="#059669" opacity="0.3"/>
      <rect x="382" y="232" width="40" height="4" rx="2" fill="#059669" opacity="0.2"/>
      <rect x="370" y="242" width="6" height="6" rx="1" fill="#059669" opacity="0.5"/>
      <rect x="382" y="243" width="55" height="4" rx="2" fill="#059669" opacity="0.3"/>
    </svg>`
  },
  {
    name: 'Per-Domain Customization',
    visual: 'domain',
    desc: 'Sites are not all built the same. Add custom extraction hints for any domain — selectors, content flows, wait strategies — and Navigator learns exactly how each page should be read. Edit them live from the web console.',
    illustration: `<svg viewBox="0 0 480 280" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="240" cy="140" r="100" fill="none" stroke="#7c3aed" stroke-width="1.5" opacity="0.25"/>
      <ellipse cx="240" cy="140" rx="50" ry="100" fill="none" stroke="#7c3aed" stroke-width="1" opacity="0.18"/>
      <ellipse cx="240" cy="140" rx="80" ry="100" fill="none" stroke="#7c3aed" stroke-width="0.8" opacity="0.1" stroke-dasharray="4 3"/>
      <line x1="140" y1="110" x2="340" y2="110" stroke="#7c3aed" stroke-width="0.8" opacity="0.12"/>
      <line x1="140" y1="170" x2="340" y2="170" stroke="#7c3aed" stroke-width="0.8" opacity="0.12"/>
      <circle cx="110" cy="50" r="26" fill="white" stroke="#7c3aed" stroke-width="1.5"/>
      <circle cx="110" cy="50" r="10" fill="none" stroke="#7c3aed" stroke-width="2.5" opacity="0.5"/>
      <circle cx="110" cy="50" r="4" fill="#7c3aed" opacity="0.4"/>
      <rect x="108" y="24" width="4" height="8" rx="1" fill="#7c3aed" opacity="0.45"/>
      <rect x="108" y="68" width="4" height="8" rx="1" fill="#7c3aed" opacity="0.45"/>
      <rect x="84" y="48" width="8" height="4" rx="1" fill="#7c3aed" opacity="0.45"/>
      <rect x="128" y="48" width="8" height="4" rx="1" fill="#7c3aed" opacity="0.45"/>
      <line x1="132" y1="68" x2="178" y2="100" stroke="#7c3aed" stroke-width="1.2" opacity="0.25"/>
      <circle cx="370" cy="55" r="26" fill="white" stroke="#7c3aed" stroke-width="1.5"/>
      <line x1="358" y1="42" x2="358" y2="68" stroke="#7c3aed" stroke-width="2.5" opacity="0.5" stroke-linecap="round"/>
      <line x1="370" y1="42" x2="370" y2="68" stroke="#7c3aed" stroke-width="2.5" opacity="0.5" stroke-linecap="round"/>
      <line x1="382" y1="42" x2="382" y2="68" stroke="#7c3aed" stroke-width="2.5" opacity="0.5" stroke-linecap="round"/>
      <circle cx="358" cy="50" r="4" fill="#7c3aed" opacity="0.6"/>
      <circle cx="370" cy="60" r="4" fill="#7c3aed" opacity="0.6"/>
      <circle cx="382" cy="46" r="4" fill="#7c3aed" opacity="0.6"/>
      <line x1="348" y1="75" x2="290" y2="105" stroke="#7c3aed" stroke-width="1.2" opacity="0.25"/>
      <circle cx="110" cy="228" r="26" fill="white" stroke="#7c3aed" stroke-width="1.5"/>
      <rect x="96" y="218" width="28" height="10" rx="4" fill="#7c3aed" opacity="0.35"/>
      <rect x="96" y="234" width="28" height="10" rx="4" fill="#7c3aed" opacity="0.35"/>
      <path d="M110,228 L110,234" stroke="#7c3aed" stroke-width="2" opacity="0.5"/>
      <path d="M104,232 L110,238 L116,232" stroke="#7c3aed" stroke-width="1.5" fill="none" opacity="0.5"/>
      <line x1="132" y1="218" x2="178" y2="188" stroke="#7c3aed" stroke-width="1.2" opacity="0.25"/>
      <circle cx="370" cy="230" r="26" fill="white" stroke="#7c3aed" stroke-width="1.5"/>
      <rect x="354" y="218" width="32" height="24" rx="4" fill="none" stroke="#7c3aed" stroke-width="2" opacity="0.5"/>
      <line x1="354" y1="226" x2="386" y2="226" stroke="#7c3aed" stroke-width="1.2" opacity="0.4"/>
      <line x1="354" y1="234" x2="386" y2="234" stroke="#7c3aed" stroke-width="1.2" opacity="0.4"/>
      <line x1="364" y1="218" x2="364" y2="242" stroke="#7c3aed" stroke-width="1.2" opacity="0.4"/>
      <line x1="348" y1="210" x2="298" y2="180" stroke="#7c3aed" stroke-width="1.2" opacity="0.25"/>
      <circle cx="240" cy="140" r="22" fill="#7c3aed" opacity="0.08"/>
      <path d="M230,152 L250,128 L255,133 L235,157 Z" fill="#7c3aed" opacity="0.45"/>
      <path d="M250,128 L255,123 L260,128 L255,133 Z" fill="#7c3aed" opacity="0.45"/>
    </svg>`
  },
  {
    name: 'Bring Any Browser',
    visual: 'relay',
    desc: 'Pair your real Chrome or Firefox through Browser Relay and keep its logins, cookies, and sessions. Or connect Navigator to any browser with a CDP endpoint over WebSocket or HTTP.',
    illustration: `<svg viewBox="0 0 480 280" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="28" y="44" width="132" height="88" rx="12" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
      <rect x="28" y="44" width="132" height="24" rx="12" fill="#dbeafe"/>
      <rect x="28" y="58" width="132" height="10" fill="#dbeafe"/>
      <circle cx="43" cy="56" r="4" fill="#fca5a5"/>
      <circle cx="55" cy="56" r="4" fill="#fde68a"/>
      <circle cx="67" cy="56" r="4" fill="#86efac"/>
      <circle cx="94" cy="94" r="17" fill="none" stroke="#2563eb" stroke-width="2" opacity="0.45"/>
      <circle cx="94" cy="94" r="6" fill="#2563eb" opacity="0.22"/>
      <rect x="320" y="44" width="132" height="88" rx="12" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
      <rect x="337" y="62" width="98" height="12" rx="3" fill="#7c3aed" opacity="0.16"/>
      <rect x="337" y="82" width="76" height="7" rx="2" fill="#7c3aed" opacity="0.24"/>
      <rect x="337" y="96" width="92" height="7" rx="2" fill="#7c3aed" opacity="0.16"/>
      <text x="386" y="121" text-anchor="middle" font-size="11" fill="#7c3aed" opacity="0.75" font-family="monospace">ws://  http://</text>
      <path d="M160 88 H204" stroke="#2563eb" stroke-width="2" stroke-dasharray="5 5" opacity="0.45"/>
      <path d="M320 88 H276" stroke="#7c3aed" stroke-width="2" stroke-dasharray="5 5" opacity="0.45"/>
      <path d="M198 82 L208 88 L198 94" fill="#2563eb" opacity="0.6"/>
      <path d="M282 82 L272 88 L282 94" fill="#7c3aed" opacity="0.6"/>
      <rect x="202" y="55" width="76" height="66" rx="16" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
      <path d="M222 78 H258 M222 88 H258 M222 98 H248" stroke="#059669" stroke-width="4" stroke-linecap="round" opacity="0.32"/>
      <circle cx="240" cy="140" r="5" fill="#059669"/>
      <path d="M240 121 V210" stroke="#059669" stroke-width="2" opacity="0.38"/>
      <path d="M240 174 H118 V206 M240 174 H362 V206" stroke="#059669" stroke-width="2" opacity="0.38"/>
      <rect x="58" y="206" width="120" height="42" rx="10" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>
      <circle cx="78" cy="227" r="7" fill="#059669" opacity="0.22"/>
      <rect x="92" y="220" width="68" height="6" rx="2" fill="#059669" opacity="0.26"/>
      <rect x="92" y="232" width="48" height="5" rx="2" fill="#059669" opacity="0.15"/>
      <rect x="302" y="206" width="120" height="42" rx="10" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>
      <circle cx="322" cy="227" r="7" fill="#059669" opacity="0.22"/>
      <rect x="336" y="220" width="68" height="6" rx="2" fill="#059669" opacity="0.26"/>
      <rect x="336" y="232" width="48" height="5" rx="2" fill="#059669" opacity="0.15"/>
      <text x="94" y="151" text-anchor="middle" font-size="11" fill="#2563eb" opacity="0.75" font-family="monospace">BROWSER RELAY</text>
      <text x="386" y="151" text-anchor="middle" font-size="11" fill="#7c3aed" opacity="0.75" font-family="monospace">ANY CDP</text>
    </svg>`
  },
  {
    name: 'Full Browser Control',
    visual: 'control',
    desc: 'Twenty-four CDP tools. Navigate, click, type, read the DOM, inspect network requests, read console logs. Open persistent tabs, manage windows. Your agent drives the browser like a user — but faster.',
    illustration: `<svg viewBox="0 0 480 280" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="40" y="20" width="260" height="210" rx="10" fill="#f8fafc" stroke="#d1d5db" stroke-width="1.5"/>
      <rect x="40" y="20" width="260" height="28" rx="10" fill="#e5e7eb"/>
      <rect x="40" y="38" width="260" height="10" fill="#e5e7eb"/>
      <circle cx="56" cy="34" r="5" fill="#fca5a5"/>
      <circle cx="70" cy="34" r="5" fill="#fde68a"/>
      <circle cx="84" cy="34" r="5" fill="#86efac"/>
      <rect x="54" y="56" width="232" height="10" rx="3" fill="#cbd5e1"/>
      <rect x="54" y="72" width="200" height="7" rx="2" fill="#e2e8f0"/>
      <rect x="54" y="85" width="220" height="7" rx="2" fill="#e2e8f0"/>
      <rect x="54" y="100" width="100" height="55" rx="6" fill="#dbeafe"/>
      <rect x="162" y="100" width="124" height="7" rx="2" fill="#e2e8f0"/>
      <rect x="162" y="113" width="110" height="6" rx="2" fill="#e2e8f0"/>
      <rect x="162" y="125" width="118" height="6" rx="2" fill="#e2e8f0"/>
      <rect x="54" y="165" width="232" height="36" rx="5" fill="#f1f5f9"/>
      <rect x="64" y="174" width="60" height="18" rx="4" fill="#2563eb" opacity="0.25"/>
      <rect x="134" y="174" width="60" height="18" rx="4" fill="#e2e8f0"/>
      <path d="M120,140 L120,160 L126,154 L134,162 L138,158 L130,150 L138,150 Z" fill="#1e293b" opacity="0.6"/>
      <rect x="330" y="24" width="125" height="36" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
      <rect x="342" y="32" width="14" height="14" rx="3" fill="#dc2626" opacity="0.25"/>
      <rect x="342" y="50" width="14" height="6" rx="2" fill="#dc2626" opacity="0.15"/>
      <rect x="362" y="34" width="70" height="5" rx="2" fill="#dc2626" opacity="0.2"/>
      <rect x="362" y="43" width="55" height="4" rx="2" fill="#dc2626" opacity="0.12"/>
      <rect x="330" y="70" width="125" height="36" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
      <circle cx="349" cy="82" r="6" fill="none" stroke="#dc2626" stroke-width="1.5" opacity="0.5"/>
      <circle cx="349" cy="82" r="2" fill="#dc2626" opacity="0.4"/>
      <rect x="362" y="76" width="70" height="5" rx="2" fill="#dc2626" opacity="0.2"/>
      <rect x="362" y="85" width="55" height="4" rx="2" fill="#dc2626" opacity="0.12"/>
      <rect x="330" y="116" width="125" height="36" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
      <rect x="340" y="124" width="18" height="12" rx="2" fill="none" stroke="#dc2626" stroke-width="1.5" opacity="0.5"/>
      <rect x="343" y="127" width="4" height="4" rx="1" fill="#dc2626" opacity="0.3"/>
      <rect x="349" y="127" width="4" height="4" rx="1" fill="#dc2626" opacity="0.3"/>
      <rect x="362" y="122" width="70" height="5" rx="2" fill="#dc2626" opacity="0.2"/>
      <rect x="362" y="131" width="55" height="4" rx="2" fill="#dc2626" opacity="0.12"/>
      <rect x="330" y="162" width="125" height="36" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
      <rect x="342" y="170" width="6" height="6" rx="1" fill="#dc2626" opacity="0.4"/>
      <rect x="352" y="168" width="6" height="6" rx="1" fill="#dc2626" opacity="0.25"/>
      <rect x="352" y="178" width="6" height="6" rx="1" fill="#dc2626" opacity="0.25"/>
      <rect x="362" y="168" width="70" height="5" rx="2" fill="#dc2626" opacity="0.2"/>
      <rect x="362" y="177" width="55" height="4" rx="2" fill="#dc2626" opacity="0.12"/>
      <rect x="330" y="208" width="125" height="36" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
      <circle cx="349" cy="220" r="5" fill="none" stroke="#dc2626" stroke-width="1.5" opacity="0.5"/>
      <path d="M344,220 L340,220" stroke="#dc2626" stroke-width="1.5" opacity="0.4"/>
      <path d="M354,220 L358,220" stroke="#dc2626" stroke-width="1.5" opacity="0.4"/>
      <rect x="362" y="214" width="70" height="5" rx="2" fill="#dc2626" opacity="0.2"/>
      <rect x="362" y="223" width="55" height="4" rx="2" fill="#dc2626" opacity="0.12"/>
      <line x1="300" y1="80" x2="330" y2="42" stroke="#dc2626" stroke-width="1" opacity="0.3"/>
      <line x1="300" y1="120" x2="330" y2="88" stroke="#dc2626" stroke-width="1" opacity="0.3"/>
      <line x1="300" y1="160" x2="330" y2="134" stroke="#dc2626" stroke-width="1" opacity="0.3"/>
      <line x1="300" y1="175" x2="330" y2="180" stroke="#dc2626" stroke-width="1" opacity="0.3"/>
      <line x1="300" y1="190" x2="330" y2="226" stroke="#dc2626" stroke-width="1" opacity="0.3"/>
    </svg>`
  },
  {
    name: 'Remote Desktop',
    visual: 'remote',
    desc: 'A live Chromium tab you can watch in real time via VNC or noVNC. See exactly what your agent sees, step in when it gets stuck, watch it recover. The black box finally has a window.',
    illustration: `<svg viewBox="0 0 480 280" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="40" y="20" width="400" height="230" rx="12" fill="#f8fafc" stroke="#d1d5db" stroke-width="1.5"/>
      <rect x="40" y="20" width="400" height="32" rx="12" fill="#e5e7eb"/>
      <rect x="40" y="36" width="400" height="16" fill="#e5e7eb"/>
      <circle cx="56" cy="36" r="5" fill="#fca5a5"/>
      <circle cx="70" cy="36" r="5" fill="#fde68a"/>
      <circle cx="84" cy="36" r="5" fill="#86efac"/>
      <rect x="44" y="52" width="130" height="22" rx="6" fill="#2563eb" opacity="0.15"/>
      <rect x="52" y="58" width="20" height="8" rx="2" fill="#2563eb" opacity="0.3"/>
      <rect x="76" y="60" width="80" height="4" rx="2" fill="#2563eb" opacity="0.2"/>
      <rect x="178" y="52" width="110" height="22" rx="6" fill="#f1f5f9"/>
      <rect x="186" y="58" width="20" height="8" rx="2" fill="#94a3b8" opacity="0.2"/>
      <rect x="210" y="60" width="60" height="4" rx="2" fill="#94a3b8" opacity="0.15"/>
      <rect x="292" y="52" width="100" height="22" rx="6" fill="#f1f5f9"/>
      <rect x="332" y="58" width="20" height="8" rx="2" fill="#94a3b8" opacity="0.2"/>
      <rect x="44" y="78" width="392" height="164" rx="4" fill="white" stroke="#e5e7eb" stroke-width="0.8"/>
      <rect x="160" y="100" width="160" height="14" rx="3" fill="#de5833" opacity="0.2"/>
      <rect x="140" y="124" width="200" height="22" rx="11" fill="#f1f5f9" stroke="#d1d5db" stroke-width="0.8"/>
      <rect x="152" y="131" width="120" height="6" rx="2" fill="#d1d5db" opacity="0.4"/>
      <rect x="140" y="158" width="200" height="6" rx="2" fill="#2563eb" opacity="0.25"/>
      <rect x="140" y="170" width="180" height="4" rx="2" fill="#e2e8f0"/>
      <rect x="140" y="180" width="190" height="4" rx="2" fill="#e2e8f0"/>
      <rect x="140" y="196" width="200" height="6" rx="2" fill="#2563eb" opacity="0.25"/>
      <rect x="140" y="208" width="160" height="4" rx="2" fill="#e2e8f0"/>
      <rect x="140" y="218" width="170" height="4" rx="2" fill="#e2e8f0"/>
      <circle cx="60" cy="248" r="5" fill="#22c55e"/>
      <rect x="72" y="244" width="30" height="8" rx="2" fill="#22c55e" opacity="0.2"/>
      <path d="M200,268 C210,258 230,258 240,268 C230,278 210,278 200,268 Z" fill="none" stroke="#94a3b8" stroke-width="1.5" opacity="0.4"/>
      <circle cx="220" cy="268" r="4" fill="#94a3b8" opacity="0.3"/>
    </svg>`
  },
  {
    name: 'Web Console',
    visual: 'console',
    desc: 'Live health dashboard, engine success rates, browser tab management, extraction testing, and domain hint editing — all at :1994/console. No restart needed.',
    illustration: `<svg viewBox="0 0 480 280" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="30" y="15" width="420" height="250" rx="10" fill="#0f172a" stroke="#334155" stroke-width="1"/>
      <rect x="30" y="15" width="420" height="30" rx="10" fill="#1e293b"/>
      <rect x="30" y="35" width="420" height="10" fill="#1e293b"/>
      <circle cx="46" cy="30" r="4.5" fill="#fca5a5"/>
      <circle cx="58" cy="30" r="4.5" fill="#fde68a"/>
      <circle cx="70" cy="30" r="4.5" fill="#86efac"/>
      <rect x="42" y="52" width="195" height="120" rx="6" fill="#1e293b" stroke="#334155" stroke-width="0.8"/>
      <rect x="54" y="62" width="70" height="7" rx="2" fill="#334155"/>
      <rect x="54" y="62" width="63" height="7" rx="2" fill="#22c55e" opacity="0.8"/>
      <rect x="54" y="76" width="70" height="7" rx="2" fill="#334155"/>
      <rect x="54" y="76" width="58" height="7" rx="2" fill="#22c55e" opacity="0.8"/>
      <rect x="54" y="90" width="70" height="7" rx="2" fill="#334155"/>
      <rect x="54" y="90" width="48" height="7" rx="2" fill="#facc15" opacity="0.8"/>
      <rect x="54" y="104" width="70" height="7" rx="2" fill="#334155"/>
      <rect x="54" y="104" width="66" height="7" rx="2" fill="#22c55e" opacity="0.8"/>
      <rect x="54" y="118" width="70" height="7" rx="2" fill="#334155"/>
      <rect x="54" y="118" width="56" height="7" rx="2" fill="#22c55e" opacity="0.8"/>
      <rect x="54" y="132" width="70" height="7" rx="2" fill="#334155"/>
      <rect x="54" y="132" width="60" height="7" rx="2" fill="#22c55e" opacity="0.8"/>
      <rect x="54" y="146" width="70" height="7" rx="2" fill="#334155"/>
      <rect x="54" y="146" width="42" height="7" rx="2" fill="#ef4444" opacity="0.6"/>
      <rect x="243" y="52" width="195" height="120" rx="6" fill="#1e293b" stroke="#334155" stroke-width="0.8"/>
      <circle cx="255" cy="68" r="3" fill="#22c55e" opacity="0.7"/>
      <rect x="262" y="66" width="80" height="4" rx="2" fill="#94a3b8" opacity="0.2"/>
      <circle cx="255" cy="82" r="3" fill="#60a5fa" opacity="0.7"/>
      <rect x="262" y="80" width="90" height="4" rx="2" fill="#94a3b8" opacity="0.2"/>
      <circle cx="255" cy="96" r="3" fill="#22c55e" opacity="0.7"/>
      <rect x="262" y="94" width="75" height="4" rx="2" fill="#94a3b8" opacity="0.2"/>
      <circle cx="255" cy="110" r="3" fill="#f59e0b" opacity="0.7"/>
      <rect x="262" y="108" width="85" height="4" rx="2" fill="#94a3b8" opacity="0.2"/>
      <circle cx="255" cy="124" r="3" fill="#60a5fa" opacity="0.7"/>
      <rect x="262" y="122" width="70" height="4" rx="2" fill="#94a3b8" opacity="0.2"/>
      <circle cx="255" cy="138" r="3" fill="#22c55e" opacity="0.7"/>
      <rect x="262" y="136" width="95" height="4" rx="2" fill="#94a3b8" opacity="0.2"/>
      <circle cx="255" cy="152" r="3" fill="#60a5fa" opacity="0.7"/>
      <rect x="262" y="150" width="80" height="4" rx="2" fill="#94a3b8" opacity="0.2"/>
      <rect x="42" y="180" width="130" height="75" rx="6" fill="#1e293b" stroke="#334155" stroke-width="0.8"/>
      <rect x="54" y="192" width="40" height="16" rx="3" fill="#22c55e" opacity="0.2"/>
      <rect x="54" y="216" width="80" height="4" rx="2" fill="#94a3b8" opacity="0.15"/>
      <rect x="54" y="226" width="60" height="4" rx="2" fill="#94a3b8" opacity="0.1"/>
      <rect x="54" y="236" width="70" height="4" rx="2" fill="#94a3b8" opacity="0.08"/>
      <rect x="180" y="180" width="130" height="75" rx="6" fill="#1e293b" stroke="#334155" stroke-width="0.8"/>
      <rect x="192" y="192" width="30" height="16" rx="3" fill="#60a5fa" opacity="0.2"/>
      <rect x="192" y="216" width="80" height="4" rx="2" fill="#94a3b8" opacity="0.15"/>
      <rect x="192" y="226" width="60" height="4" rx="2" fill="#94a3b8" opacity="0.1"/>
      <rect x="192" y="236" width="70" height="4" rx="2" fill="#94a3b8" opacity="0.08"/>
      <rect x="318" y="180" width="120" height="75" rx="6" fill="#1e293b" stroke="#334155" stroke-width="0.8"/>
      <rect x="330" y="192" width="35" height="16" rx="3" fill="#a78bfa" opacity="0.2"/>
      <rect x="330" y="216" width="80" height="4" rx="2" fill="#94a3b8" opacity="0.15"/>
      <rect x="330" y="226" width="60" height="4" rx="2" fill="#94a3b8" opacity="0.1"/>
      <rect x="330" y="236" width="70" height="4" rx="2" fill="#94a3b8" opacity="0.08"/>
    </svg>`
  }
]

const why = [
  {
    tag: 'Self-Hosted',
    title: 'Your data never leaves your machine',
    desc: 'One Docker container. HTTP or stdio transport. Every search query, page fetch, and screenshot stays on your network — no third-party API calls, no telemetry, no surprises.',
    bg: '#ecfdf5', fg: '#059669',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
  },
  {
    tag: 'Resilient',
    title: 'Finds a way when everything else fails',
    desc: 'Twelve search routes across four backends with automatic circuit breakers. When DuckDuckGo trips, Google picks up. When a page blocks headless, CloakBrowser steps in. Your agent never sees a dead end.',
    bg: '#eff6ff', fg: '#2563eb',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>'
  },
  {
    tag: 'Teachable',
    title: 'Learns how to read every site',
    desc: 'Domain hints let you teach Navigator exactly how to extract content from each site — custom selectors, multi-step content flows, wait strategies. Edit live from the web console.',
    bg: '#f5f3ff', fg: '#7c3aed',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>'
  },
  {
    tag: 'Visible',
    title: 'Know exactly what your agent is doing',
    desc: 'Live health dashboard, engine success rates, browser tab management with inactivity countdowns, extraction testing, and a full activity feed — all at :1994/console.',
    bg: '#fffbeb', fg: '#d97706',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  },
]

const stats = [
  { val: '12', label: 'Search routes' },
  { val: '4', label: 'Browser backends' },
  { val: '24', label: 'DevTools commands' },
  { val: '12', label: 'Search engines' },
]
</script>

<style scoped>
.lp {
  position: relative;
  color: var(--lp-text);
  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
  line-height: 1.6;
  overflow-x: hidden;
}

.lp :deep(*) { box-sizing: border-box; margin: 0; padding: 0; }

:global(body:has(.lp:not(.is-scrolled)) .VPNavBar .divider-line) {
  opacity: 0;
}

/* ── Hero ── */
.hero {
  position: relative;
  min-height: 85vh;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 120px 24px 80px;
  background: transparent;
  z-index: 1;
}

.hero-content {
  position: relative;
  z-index: 1;
  max-width: 640px;
}

.pill {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lp-blue);
  background: var(--lp-blue-soft);
  padding: 5px 14px;
  border-radius: 100px;
  border: 1px solid color-mix(in srgb, var(--lp-blue) 15%, transparent);
  margin-bottom: 20px;
}

.title {
  font-size: clamp(3.2rem, 8vw, 6rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
  margin-bottom: 20px;
  background: linear-gradient(135deg, var(--lp-text) 30%, var(--lp-blue));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  font-size: 1.4rem;
  font-weight: 600;
  margin-bottom: 16px;
}

.desc {
  font-size: 1rem;
  line-height: 1.75;
  color: var(--lp-muted);
  margin-bottom: 32px;
}

.ctas {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
}

.cta-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 22px;
  border-radius: 10px;
  background: var(--lp-blue);
  color: #fff;
  font: 600 14px "Inter", ui-sans-serif, system-ui, sans-serif;
  text-decoration: none;
  transition: all 0.2s;
  box-shadow: 0 2px 8px rgba(37,99,235,0.3);
}
.cta-primary:hover {
  background: #1d4ed8;
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(37,99,235,0.4);
}

.cta-secondary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 22px;
  border-radius: 10px;
  background: var(--lp-surface);
  border: 1px solid var(--lp-border);
  color: var(--lp-text);
  font: 600 14px "Inter", ui-sans-serif, system-ui, sans-serif;
  text-decoration: none;
  transition: all 0.2s;
}
.cta-secondary:hover {
  background: var(--lp-border);
  transform: translateY(-1px);
}

/* ── Screenshot contained ── */
.shot-wrap {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 24px;
  position: relative;
  z-index: 2;
}
.shot-frame {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--lp-border);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
  line-height: 0;
  background: var(--lp-surface);
}
html.dark .shot-frame {
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
}
.shot-frame img {
  width: 100%;
  display: block;
}

/* ── Logos ── */
.logos {
  text-align: center;
  padding: 56px 24px 0;
}
.logos-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--lp-muted);
  margin-bottom: 14px;
}
.logos-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--lp-text);
  opacity: 0.55;
}
.sep { opacity: 0.3; }

/* ── Sections ── */
.section { padding: 80px 24px 0; }
.inner { max-width: 1040px; margin: 0 auto; }
.inner.narrow { max-width: 640px; }

.section h2 {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  text-align: center;
  margin-bottom: 32px;
}
.lead {
  text-align: center;
  color: var(--lp-muted);
  font-size: 1rem;
  margin-bottom: 40px;
}

/* ── Feature list (full-width rows) ── */
.feature-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.feature-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 48px;
  align-items: center;
  padding: 40px 0;
  border-bottom: 1px solid var(--lp-border);
}
.feature-row.reverse .feature-illust {
  order: 2;
}
.feature-row.reverse .feature-text {
  order: 1;
}

.feature-illust {
  width: 100%;
}
.feature-illust :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.feature-text h3 {
  font-size: 1.2rem;
  font-weight: 700;
  margin-bottom: 10px;
  letter-spacing: -0.01em;
}
.feature-text p {
  font-size: 0.95rem;
  line-height: 1.7;
  color: var(--lp-muted);
}

/* ── Card grid (Why section) ── */
.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}

.card {
  padding: 28px;
  border-radius: 12px;
  background: var(--lp-surface);
  border: 1px solid var(--lp-border);
  transition: transform 0.2s, box-shadow 0.2s;
}
.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 30px -8px rgba(0,0,0,0.08);
}
html.dark .card:hover {
  box-shadow: 0 8px 30px -8px rgba(0,0,0,0.4);
}

.card-icon {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.tag {
  display: inline-block;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 3px 10px;
  border-radius: 5px;
  margin-bottom: 12px;
}

.card h3 {
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 8px;
}
.card p {
  font-size: 0.88rem;
  line-height: 1.6;
  color: var(--lp-muted);
}

/* ── Audience row ── */
.audience-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}
.audience-item {
  padding: 28px;
  border-radius: 12px;
  background: var(--lp-surface);
  border: 1px solid var(--lp-border);
}
.audience-item h3 {
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 8px;
}
.audience-item p {
  font-size: 0.88rem;
  line-height: 1.6;
  color: var(--lp-muted);
}

/* ── Stats ── */
.stats {
  padding: 64px 24px;
}
.stats-row {
  max-width: 800px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
  text-align: center;
  border-top: 1px solid var(--lp-border);
  border-bottom: 1px solid var(--lp-border);
  padding: 48px 0;
}
.stat-val {
  display: block;
  font-size: 2.2rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  background: linear-gradient(135deg, var(--lp-blue), var(--lp-purple));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.stat-label {
  display: block;
  font-size: 0.78rem;
  color: var(--lp-muted);
  margin-top: 2px;
}

/* ── Install steps ── */
.steps { display: flex; flex-direction: column; gap: 18px; }
.step {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.step-num {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--lp-blue);
  color: #fff;
  font-size: 0.72rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}
.step-title {
  font-size: 0.88rem;
  font-weight: 600;
  margin-bottom: 8px;
}
.step pre {
  background: var(--lp-code-bg);
  color: var(--lp-code-text);
  padding: 14px 18px;
  border-radius: 8px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.8rem;
  line-height: 1.6;
  overflow-x: auto;
}

/* ── Bottom CTA ── */
.cta-bottom {
  text-align: center;
  padding: 80px 24px;
}
.cta-bottom h2 {
  font-size: 1.9rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.cta-bottom p {
  color: var(--lp-muted);
  margin-top: 4px;
}

/* ── Footer ── */
.lp-foot {
  text-align: center;
  padding: 28px 24px;
  border-top: 1px solid var(--lp-border);
  font-size: 0.78rem;
  color: var(--lp-muted);
  display: flex;
  gap: 8px;
  justify-content: center;
}
.lp-foot a {
  color: var(--lp-muted);
  text-decoration: none;
  transition: color 0.15s;
}
.lp-foot a:hover { color: var(--lp-text); }
.dot { opacity: 0.3; }

/* ── Scroll reveal ── */
.section {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.6s ease, transform 0.6s ease;
}
.section.show {
  opacity: 1;
  transform: translateY(0);
}

/* ── Responsive ── */
@media (max-width: 768px) {
  .hero { min-height: auto; padding: 100px 20px 60px; }
  .title { font-size: 2.6rem; }
  .subtitle { font-size: 1.15rem; }
  .grid-2, .audience-row { grid-template-columns: 1fr; }
  .feature-row,
  .feature-row.reverse {
    grid-template-columns: 1fr;
    gap: 24px;
  }
  .feature-row.reverse .feature-illust { order: 0; }
  .feature-row.reverse .feature-text { order: 0; }
  .stats-row { grid-template-columns: repeat(2, 1fr); gap: 28px; }
}
</style>

<style scoped>
/* Landing visual system: Navigator routes and the alligator-green identity. */
.lp {
  --forest-950: #071d12;
  --forest-900: #0b2b19;
  --forest-800: #12452a;
  --forest-700: #176637;
  --forest-600: #1d8446;
  --forest-500: #27a858;
  --forest-300: #86d69f;
  --moss-200: #cde8c8;
  --moss-100: #e7f2e3;
  --marsh-50: #f5f8f2;
  --lp-blue: var(--forest-600);
  --lp-blue-soft: color-mix(in srgb, var(--forest-500) 10%, transparent);
  --lp-purple: #67a33f;
  --visual-shell: #edf4ee;
  --visual-surface: #ffffff;
  --visual-border: #cad9cd;
  --visual-muted: #dfeae1;
  --visual-dot: #9aaca0;
  --visual-green: #1d8446;
  --visual-olive: #72a944;
  background: var(--vp-c-bg);
}

.hero {
  min-height: auto;
  padding: 132px 32px 112px;
  text-align: center;
  isolation: isolate;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 10%, rgba(126, 190, 112, 0.2), transparent 34rem),
    linear-gradient(180deg, #f8faf5 0%, var(--marsh-50) 100%);
}

.hero-shell {
  position: relative;
  z-index: 1;
  width: min(1180px, 100%);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 62px;
  align-items: center;
}

.hero-content {
  max-width: 850px;
  margin: 0 auto;
  text-align: center;
  animation: hero-copy-in 0.75s cubic-bezier(.2,.8,.2,1) both;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--forest-700);
  background: rgba(255, 255, 255, 0.7);
  border-color: color-mix(in srgb, var(--forest-600) 24%, transparent);
  margin-bottom: 24px;
  padding: 7px 14px 7px 11px;
  box-shadow: 0 8px 28px -20px rgba(10, 80, 38, 0.7);
  backdrop-filter: blur(10px);
}

.pill::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--forest-500);
  box-shadow: 0 0 0 5px rgba(39, 168, 88, 0.11);
}

.title {
  max-width: 920px;
  margin: 0 auto 24px;
  font-size: clamp(4.4rem, 7.4vw, 7rem);
  line-height: 0.9;
  letter-spacing: -0.058em;
  background: linear-gradient(132deg, var(--forest-950) 15%, var(--forest-700) 58%, #55a83a 100%);
  -webkit-background-clip: text;
  background-clip: text;
}

.subtitle {
  margin-bottom: 14px;
  font-size: clamp(1.2rem, 2vw, 1.55rem);
  letter-spacing: -0.02em;
  color: var(--forest-900);
}

.desc {
  max-width: 700px;
  margin: 0 auto 34px;
  font-size: 1rem;
  line-height: 1.82;
}

.ctas { justify-content: center; }

.cta-primary,
.cta-secondary {
  height: 50px;
  border-radius: 14px;
  padding: 0 24px;
}

.cta-primary {
  background: linear-gradient(135deg, var(--forest-700), var(--forest-500));
  box-shadow: 0 14px 30px -16px rgba(17, 104, 52, 0.8);
}

.cta-primary:hover {
  background: linear-gradient(135deg, var(--forest-800), var(--forest-600));
  transform: translateY(-2px);
  box-shadow: 0 18px 36px -16px rgba(17, 104, 52, 0.9);
}

.cta-secondary {
  background: color-mix(in srgb, var(--lp-surface) 82%, transparent);
  border-color: color-mix(in srgb, var(--forest-700) 20%, var(--lp-border));
  backdrop-filter: blur(12px);
}

.shot-wrap {
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 0;
  isolation: isolate;
  animation: console-in 0.9s 0.12s cubic-bezier(.2,.8,.2,1) both;
}

.shot-wrap::before {
  content: "";
  position: absolute;
  inset: 8% 4% -14%;
  z-index: -1;
  border-radius: 40%;
  background: radial-gradient(circle, rgba(35, 145, 72, 0.24), transparent 68%);
  filter: blur(28px);
}

.shot-frame {
  position: relative;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--forest-700) 28%, var(--lp-border));
  border-radius: 20px;
  background: color-mix(in srgb, var(--forest-950) 96%, #27352b);
  box-shadow:
    0 46px 90px -42px rgba(4, 41, 19, 0.7),
    0 20px 34px -26px rgba(4, 41, 19, 0.74),
    inset 0 0 0 1px rgba(255,255,255,0.08);
  transition: transform 0.45s cubic-bezier(.2,.8,.2,1), box-shadow 0.45s ease;
}

.shot-frame:hover {
  transform: translateY(-5px);
  box-shadow: 0 48px 90px -38px rgba(4, 41, 19, 0.72);
}

.shot-chrome {
  height: 46px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid #dce4de;
  color: #647169;
  background: #f1f5f2;
  font: 500 11px "JetBrains Mono", ui-monospace, monospace;
}

.shot-dots { display: flex; gap: 7px; justify-self: start; }
.shot-dots span { width: 8px; height: 8px; border-radius: 50%; background: #9aa89f; }
.shot-dots span:nth-child(2) { opacity: 0.7; }
.shot-dots span:nth-child(3) { opacity: 0.45; }
.shot-address {
  padding: 5px 22px;
  border: 1px solid #d9e1db;
  border-radius: 999px;
  background: rgba(255,255,255,0.72);
}
.shot-screen { line-height: 0; }
.shot-frame img { border-radius: 0; }

.logos {
  position: relative;
  z-index: 2;
  width: min(1120px, calc(100% - 48px));
  margin: 0 auto -58px;
  padding: 24px 30px;
  border: 1px solid color-mix(in srgb, var(--forest-600) 15%, var(--lp-border));
  border-radius: 22px;
  background: color-mix(in srgb, var(--lp-surface) 84%, transparent);
  box-shadow: 0 22px 55px -42px rgba(5, 63, 28, 0.62);
  backdrop-filter: blur(18px);
  transform: translateY(-50%);
}

.logos-label { margin-bottom: 13px; color: var(--forest-600); }
.logos-row { gap: 9px; opacity: 1; }
.logos-row > span:not(.sep) {
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, var(--forest-500) 13%, var(--lp-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--forest-500) 4%, var(--lp-surface));
  font-size: 0.8rem;
}
.logos-row .sep { display: none; }

.section { padding: 104px 28px 0; }
.inner { max-width: 1160px; }
.section h2 {
  margin-bottom: 18px;
  font-size: clamp(2rem, 3.2vw, 3rem);
  letter-spacing: -0.045em;
}
.lead { max-width: 660px; margin: 0 auto 42px; line-height: 1.8; }

.feature-list { gap: 0; }
.feature-row {
  min-height: 0;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 1fr);
  gap: clamp(42px, 6vw, 72px);
  padding: 36px 0;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--forest-600) 13%, var(--lp-border));
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  overflow: visible;
  transition: border-color 0.35s ease;
}

.feature-row:nth-child(even) {
  background: transparent;
}

.feature-row:hover {
  border-color: color-mix(in srgb, var(--forest-600) 28%, var(--lp-border));
  box-shadow: none;
}

.feature-illust { height: 230px; filter: saturate(0.82); }
.feature-text { max-width: 430px; }
.feature-text h3 {
  margin-bottom: 16px;
  font-size: clamp(1.45rem, 2.1vw, 2rem);
  line-height: 1.15;
  letter-spacing: -0.035em;
}
.feature-text p { font-size: 0.95rem; line-height: 1.82; }

.why {
  margin-top: 96px;
  padding: 88px 28px;
  background:
    radial-gradient(circle at 12% 10%, rgba(109, 205, 129, 0.1), transparent 30%),
    linear-gradient(135deg, var(--forest-950), var(--forest-800));
  color: #f4faf3;
}
.why h2 { color: #f4faf3; margin-bottom: 44px; }
.why .grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 56px; }
.why .card {
  grid-column: auto;
  min-height: 190px;
  padding: 28px 0;
  border: 0;
  border-top: 1px solid rgba(195, 231, 201, 0.18);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
}
.why .card:nth-child(n) { grid-column: auto; }
.why .card:hover {
  border-color: rgba(134, 214, 159, 0.3);
  background: transparent;
  box-shadow: none;
}
.why .card-icon {
  width: 42px;
  height: 42px;
  border: 1px solid rgba(113, 212, 146, 0.16);
  border-radius: 12px;
  color: #71d492 !important;
  background: rgba(103, 202, 133, 0.11) !important;
}
.why .card h3 { color: #f4faf3; font-size: 1.13rem; }
.why .card p { color: rgba(226, 241, 226, 0.68); line-height: 1.72; }

.audience { padding-top: 80px; }
.audience-row { gap: 16px; }
.audience-item {
  position: relative;
  min-height: 0;
  padding: 28px 4px 20px;
  border: 0;
  border-top: 2px solid color-mix(in srgb, var(--forest-600) 28%, var(--lp-border));
  border-radius: 0;
  background: transparent;
  overflow: hidden;
  transition: transform 0.3s ease, border-color 0.3s ease;
}
.audience-item::after {
  content: "";
  position: absolute;
  width: 110px;
  height: 110px;
  right: -48px;
  bottom: -56px;
  border: 20px solid color-mix(in srgb, var(--forest-500) 7%, transparent);
  border-radius: 46% 54% 48% 52%;
  transform: rotate(25deg);
}
.audience-item:hover { border-color: color-mix(in srgb, var(--forest-600) 48%, var(--lp-border)); }
.audience-item h3 { margin-bottom: 15px; font-size: 1.15rem; }
.audience-item p { line-height: 1.75; }

.cta-bottom {
  width: 100%;
  margin: 88px auto 0;
  padding: 80px 28px;
  transform: none;
  border: 0;
  border-radius: 0;
  color: #f5faf4;
  background:
    radial-gradient(circle at 12% 10%, rgba(109, 205, 129, 0.1), transparent 30%),
    linear-gradient(135deg, var(--forest-950), var(--forest-800));
  box-shadow: 0 35px 80px -55px rgba(3, 48, 19, 0.9);
}
.cta-bottom h2 { color: #f5faf4; font-size: clamp(2rem, 3.4vw, 3.2rem); }
.cta-bottom p { color: rgba(229, 242, 228, 0.68); }
.cta-bottom .ctas { justify-content: center; }
.cta-bottom .cta-secondary { color: #eef8ed; background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.16); }
.cta-bottom .cta-secondary:hover { background: rgba(255,255,255,0.12); }

.lp-foot { border-top-color: color-mix(in srgb, var(--forest-600) 12%, var(--lp-border)); }

@keyframes hero-copy-in {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes console-in {
  from { opacity: 0; transform: translateX(30px) scale(.97); }
  to { opacity: 1; transform: translateX(0) scale(1); }
}

@media (max-width: 1100px) {
  .hero { padding-top: 112px; }
  .hero-shell { gap: 54px; }
  .title { font-size: clamp(4rem, 8vw, 6rem); }
}

@media (max-width: 900px) {
  .hero { min-height: auto; padding: 110px 24px 88px; }
  .hero-shell { gap: 52px; }
  .hero-content { max-width: 700px; text-align: center; margin: 0 auto; }
  .desc { margin-left: auto; margin-right: auto; }
  .ctas { justify-content: center; }
  .shot-wrap { max-width: 760px; margin: 0 auto; }
  .shot-frame { transform: none; }
  .logos { margin-top: 0; }
  .feature-row { grid-template-columns: 1fr; gap: 22px; }
  .feature-row .feature-illust, .feature-row.reverse .feature-illust { order: 0; }
  .feature-row .feature-text, .feature-row.reverse .feature-text { order: 1; max-width: 680px; }
}

@media (max-width: 768px) {
  .hero { padding: 106px 20px 92px; }
  .hero-shell { gap: 40px; }
  .title { font-size: clamp(3.05rem, 14vw, 4.15rem); line-height: .94; }
  .subtitle { font-size: 1.08rem; }
  .desc { font-size: .9rem; line-height: 1.76; }
  .shot-frame { border-radius: 14px; }
  .shot-chrome { height: 38px; padding: 0 11px; }
  .shot-address { margin: 0 12px; padding: 4px 10px; overflow: hidden; text-overflow: ellipsis; }
  .logos { width: calc(100% - 32px); margin-bottom: -66px; padding: 20px 16px; border-radius: 18px; }
  .logos-row { gap: 7px; }
  .logos-row > span:not(.sep) { font-size: .7rem; padding: 5px 9px; }
  .section { padding: 76px 16px 0; }
  .section h2 { font-size: 2.1rem; }
  .lead { margin-bottom: 30px; font-size: .9rem; }
  .feature-list { gap: 0; }
  .feature-row { min-height: 0; padding: 26px 0; border-radius: 0; gap: 18px; }
  .feature-illust { height: 150px; }
  .feature-text { padding: 0 4px; }
  .feature-text h3 { font-size: 1.35rem; margin-bottom: 12px; }
  .feature-text p { font-size: .87rem; line-height: 1.72; }
  .why { margin-top: 72px; padding: 68px 16px; }
  .why .grid-2 { grid-template-columns: 1fr; }
  .why .card, .why .card:nth-child(n) { grid-column: auto; min-height: 0; padding: 24px 0; border-radius: 0; }
  .audience { padding-top: 64px; }
  .audience-item { min-height: 0; padding: 24px 4px 18px; border-radius: 0; }
  .cta-bottom { width: 100%; margin: 64px auto 0; padding: 64px 22px; border-radius: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .hero-content, .shot-wrap { animation: none; }
  .shot-frame, .feature-row, .card, .audience-item { transition: none; }
}
</style>
