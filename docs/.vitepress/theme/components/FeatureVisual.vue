<template>
  <div class="art" :class="`art-${type}`" aria-hidden="true">
    <svg viewBox="24 38 512 264" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient :id="id('wash')" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="var(--ink)" stop-opacity=".18" />
          <stop offset="1" stop-color="var(--ink-2)" stop-opacity=".02" />
        </linearGradient>
        <linearGradient :id="id('solid')" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="var(--ink)" />
          <stop offset="1" stop-color="var(--ink-2)" />
        </linearGradient>
        <radialGradient :id="id('halo')">
          <stop stop-color="var(--ink)" stop-opacity=".25" />
          <stop offset="1" stop-color="var(--ink)" stop-opacity="0" />
        </radialGradient>
        <filter :id="id('shadow')" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dy="16" stdDeviation="18" flood-color="#0f172a" flood-opacity=".14" />
        </filter>
        <filter :id="id('glow')" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <pattern :id="id('grid')" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0v24" fill="none" stroke="currentColor" stroke-opacity=".055" />
        </pattern>
      </defs>

      <rect class="grid" x="1" y="1" width="558" height="338" rx="27" :fill="`url(#${id('grid')})`" />
      <circle class="ambient" cx="280" cy="170" r="138" :fill="`url(#${id('halo')})`" />

      <g v-if="type === 'search'" class="search-art">
        <path class="orbit" d="M64 170c46-126 385-126 432 0-47 126-386 126-432 0Z" />
        <path class="orbit faint" d="M123 170c32-78 282-78 314 0-32 78-282 78-314 0Z" />
        <g class="sources">
          <g v-for="source in sources" :key="source.x" :transform="`translate(${source.x} ${source.y})`">
            <circle class="source-halo" r="18"/><circle r="7"/><circle class="pulse-ring" r="12"/>
          </g>
        </g>
        <path class="signal-path" d="M88 96C165 82 185 137 245 153M82 224c80 15 106-39 163-42M164 58c29 61 54 76 90 96M164 282c29-62 54-78 90-97" />
        <g class="prism" filter="url(#shadow-search)" transform="translate(280 170)">
          <path class="prism-back" d="m0-62 54 31v62L0 62l-54-31v-62Z"/>
          <path class="prism-left" d="M0 0v62l-54-31v-62Z"/><path class="prism-right" d="M0 0v62l54-31v-62Z"/><path class="prism-top" d="m0-62 54 31L0 0l-54-31Z"/>
          <circle class="core-dot" r="8"/>
        </g>
        <path class="out-path" d="M334 170h104"/><circle class="out-dot" cx="461" cy="170" r="12"/><circle class="out-ring" cx="461" cy="170" r="24"/>
      </g>

      <g v-else-if="type === 'extract'" class="extract-art">
        <g class="raw-stack" filter="url(#shadow-extract)">
          <rect x="56" y="66" width="170" height="208" rx="16"/>
          <path class="raw-line heavy" d="M82 99h106M82 120h68M82 157h116M82 178h92M82 199h124M82 236h74"/>
          <rect class="raw-block" x="82" y="137" width="118" height="8" rx="4"/><rect class="raw-block" x="82" y="217" width="118" height="8" rx="4"/>
          <g class="noise-marks"><circle cx="72" cy="88" r="3"/><circle cx="210" cy="112" r="4"/><circle cx="69" cy="222" r="4"/><path d="m195 247 10 10m0-10-10 10"/></g>
        </g>
        <path class="flow-line" d="M226 170h61"/><g class="sieve" transform="translate(306 170)"><path d="M-27-30h54L9-5v27L-9 32V-5Z"/><path class="shine" d="M-14-16h28"/></g>
        <path class="flow-line" d="M333 170h58"/>
        <g class="clean-stack" filter="url(#shadow-extract)">
          <rect x="391" y="78" width="120" height="184" rx="16"/>
          <circle cx="415" cy="106" r="8"/><path d="M433 102h52M433 112h36M415 139h70M415 158h61M415 177h70M415 210h52"/>
          <rect x="413" y="226" width="72" height="13" rx="6.5"/>
        </g>
        <g class="discard"><circle cx="292" cy="257" r="3"/><circle cx="312" cy="269" r="2"/><path d="m329 251 7 7m0-7-7 7"/></g>
      </g>

      <g v-else-if="type === 'domain'" class="domain-art">
        <g class="domain-page" filter="url(#shadow-domain)">
          <rect x="45" y="62" width="218" height="216" rx="17"/><path d="M45 98h218"/>
          <circle cx="66" cy="80" r="5"/><circle cx="83" cy="80" r="5"/><circle cx="100" cy="80" r="5"/>
          <rect class="domain-address" x="119" y="72" width="124" height="17" rx="8.5"/>
          <rect class="page-noise" x="68" y="120" width="172" height="24" rx="7"/>
          <rect class="page-match" x="68" y="158" width="172" height="76" rx="9"/>
          <path class="page-lines" d="M84 178h116M84 194h138M84 210h96"/>
        </g>
        <path class="domain-link" d="M263 170h47"/><path class="domain-arrow" d="m301 161 12 9-12 9"/>
        <g class="rule-panel" filter="url(#shadow-domain)">
          <rect x="313" y="62" width="202" height="216" rx="17"/>
          <text class="panel-title" x="337" y="91">PAGE RULE</text>
           <g transform="translate(337 111)"><rect width="154" height="38" rx="9"/><text x="13" y="22">SELECT</text><path d="M13 27h104"/></g>
           <g transform="translate(337 158)"><rect width="154" height="38" rx="9"/><text x="13" y="22">WAIT</text><path d="M13 27h72"/></g>
           <g class="rule-active" transform="translate(337 205)"><rect width="154" height="48" rx="9"/><circle cx="17" cy="24" r="6"/><text x="32" y="27">EXTRACT</text><path d="M32 31h88"/></g>
        </g>
      </g>

      <g v-else-if="type === 'screenshot'" class="screenshot-art">
        <g class="capture-frame" filter="url(#shadow-screenshot)">
          <rect x="34" y="83" width="180" height="174" rx="16"/><path d="M34 116h180"/>
          <circle cx="54" cy="100" r="4"/><circle cx="69" cy="100" r="4"/><circle cx="84" cy="100" r="4"/>
          <rect class="capture-hero" x="55" y="136" width="138" height="52" rx="8"/><path class="capture-lines" d="M55 207h84M55 224h138M55 241h108"/>
          <path class="capture-corners" d="M47 145v-18h18M183 127h18v18M201 225v18h-18M65 243H47v-18"/>
        </g>
        <path class="capture-link" d="M214 170h29"/><path class="capture-arrow" d="m234 162 11 8-11 8"/>
        <g class="quality-panel" filter="url(#shadow-screenshot)">
          <rect x="245" y="70" width="116" height="200" rx="15"/><text class="quality-title" x="265" y="94">QUALITY</text>
          <g class="quality-choice selected" transform="translate(260 109)"><rect width="86" height="38" rx="9"/><circle cx="16" cy="19" r="6"/><text x="29" y="22">LOW</text><path d="M65 24h7"/></g>
          <g class="quality-choice" transform="translate(260 156)"><rect width="86" height="38" rx="9"/><circle cx="16" cy="19" r="6"/><text x="29" y="22">MEDIUM</text><path d="M65 24h7M65 17h7"/></g>
          <g class="quality-choice" transform="translate(260 203)"><rect width="86" height="38" rx="9"/><circle cx="16" cy="19" r="6"/><text x="29" y="22">HIGH</text><path d="M65 24h7M65 17h7M65 10h7"/></g>
        </g>
        <path class="delivery-link" d="M361 170h31M392 170v-49M392 170v49"/><path class="delivery-arrow" d="m384 113 8 11 8-11M384 211l8 11 8-11"/>
        <g class="delivery-options" filter="url(#shadow-screenshot)">
          <g class="file-output" transform="translate(402 84)"><rect width="128" height="72" rx="12"/><path class="file-icon" d="M16 17h19l8 8v26H16Z M35 17v9h8"/><text x="54" y="28">FILE PATH</text><path class="path-line" d="M54 42h55M54 52h38"/><circle cx="112" cy="15" r="5"/></g>
          <g transform="translate(402 184)"><rect width="128" height="72" rx="12"/><path class="base64-icon" d="M19 19h-6v34h6M39 19h6v34h-6M24 29l10 7-10 7"/><text x="54" y="32">BASE64</text><path class="path-line" d="M54 45h55M54 55h45"/></g>
        </g>
      </g>

      <g v-else-if="type === 'control'" class="control-art">
        <g class="command-list">
          <g transform="translate(42 91)"><circle cx="14" cy="14" r="14"/><text x="14" y="17">1</text><rect x="39" width="104" height="28" rx="8"/><text x="54" y="17">NAVIGATE</text></g>
          <path d="M56 119v24"/>
          <g class="command-active" transform="translate(42 143)"><circle cx="14" cy="14" r="14"/><text x="14" y="17">2</text><rect x="39" width="104" height="28" rx="8"/><text x="54" y="17">CLICK</text></g>
          <path d="M56 171v24"/>
          <g transform="translate(42 195)"><circle cx="14" cy="14" r="14"/><text x="14" y="17">3</text><rect x="39" width="104" height="28" rx="8"/><text x="54" y="17">READ DOM</text></g>
        </g>
        <path class="control-link" d="M185 170h27"/><path class="control-arrow" d="m212 161 12 9-12 9Z"/>
        <g class="browser-control" filter="url(#shadow-control)">
          <rect x="224" y="65" width="292" height="210" rx="17"/><path d="M224 101h292"/>
          <circle cx="245" cy="83" r="5"/><circle cx="262" cy="83" r="5"/><circle cx="279" cy="83" r="5"/>
          <rect class="control-card" x="250" y="124" width="240" height="53" rx="9"/><path class="control-lines" d="M268 143h112M268 158h168"/>
          <rect class="click-target" x="250" y="203" width="102" height="36" rx="9"/><text class="button-label" x="301" y="223.5">BUTTON</text>
          <circle class="click-ring" cx="337" cy="221" r="12"/>
          <path class="cursor" d="m337 221 10 28 7-8 9 12 7-5-9-12 10-4Z"/>
        </g>
      </g>

       <g v-else-if="type === 'remote'" class="remote-art">
        <g class="remote-monitor" filter="url(#shadow-remote)">
          <rect x="54" y="61" width="318" height="210" rx="17"/><rect class="monitor-screen" x="67" y="74" width="292" height="171" rx="10"/>
          <path class="monitor-bar" d="M67 108h292"/><circle cx="87" cy="91" r="5"/><circle cx="104" cy="91" r="5"/>
          <rect class="monitor-hero" x="103" y="130" width="220" height="44" rx="9"/><path class="monitor-lines" d="M103 195h142M103 214h220"/>
          <path class="monitor-stand" d="M190 271v24h46v-24M168 295h90"/>
        </g>
        <path class="remote-link" d="M372 166h38"/><circle class="remote-pulse" cx="391" cy="166" r="8"/>
        <g class="remote-client" filter="url(#shadow-remote)">
          <rect x="410" y="105" width="106" height="132" rx="14"/><rect x="421" y="119" width="84" height="91" rx="7"/>
          <rect class="client-hero" x="433" y="136" width="60" height="20" rx="5"/><path class="client-lines" d="M433 174h42M433 188h60"/><circle cx="463" cy="223" r="5"/>
        </g>
         <g class="live-badge"><rect x="407" y="67" width="109" height="27" rx="13.5"/><circle cx="424" cy="80.5" r="5"/><text x="438" y="83.5">LIVE VIEW</text></g>
       </g>

       <g v-else-if="type === 'relay'" class="relay-art">
         <g class="relay-browser" filter="url(#shadow-relay)">
           <rect x="42" y="72" width="172" height="164" rx="16"/><path d="M42 108h172"/>
           <circle cx="63" cy="90" r="5"/><circle cx="80" cy="90" r="5"/><circle cx="97" cy="90" r="5"/>
           <rect class="relay-address" x="117" y="82" width="77" height="16" rx="8"/>
           <rect class="relay-page" x="64" y="126" width="128" height="82" rx="10"/>
           <path class="relay-lines" d="M79 150h68M79 166h91M79 182h48"/>
         </g>
         <path class="relay-link" d="M214 154h53M214 184h53"/>
         <g class="relay-hub" filter="url(#shadow-relay)">
           <rect x="267" y="128" width="74" height="82" rx="17"/>
           <path d="M286 154h36M286 169h36M286 184h24"/>
         </g>
         <path class="relay-link" d="M341 154h43M341 184h43"/>
         <g class="relay-endpoint" filter="url(#shadow-relay)">
           <rect x="384" y="72" width="134" height="164" rx="16"/>
           <text x="451" y="113">CDP ENDPOINT</text>
           <rect x="404" y="130" width="94" height="26" rx="7"/>
           <path d="M418 143h66M404 178h78M404 194h54"/>
           <circle cx="405" cy="216" r="5"/>
         </g>
         <g class="relay-label"><rect x="208" y="244" width="192" height="27" rx="13.5"/><circle cx="226" cy="257.5" r="5"/><text x="240" y="260.5">BROWSER RELAY</text></g>
       </g>

       <g v-else class="console-art">
        <g class="console-shell" filter="url(#shadow-console)"><rect x="42" y="48" width="476" height="246" rx="18"/><path d="M42 88h476"/><circle cx="64" cy="68" r="5"/><circle cx="81" cy="68" r="5"/><circle cx="98" cy="68" r="5"/></g>
        <g class="metric-card"><rect x="66" y="112" width="126" height="64" rx="11"/><path class="metric" d="M82 153c17-30 35 8 51-14s27-4 43-20"/><circle cx="176" cy="119" r="4"/></g>
        <g class="metric-card"><rect x="205" y="112" width="126" height="64" rx="11"/><circle class="ring-bg" cx="237" cy="144" r="18"/><path class="ring-value" d="M237 126a18 18 0 1 1-17 12"/><path d="M267 136h45M267 149h32"/></g>
        <g class="metric-card"><rect x="344" y="112" width="150" height="64" rx="11"/><path class="bars" d="M364 158v-14M382 158v-27M400 158v-19M418 158v-38M436 158v-25M454 158v-32M472 158v-17"/></g>
        <g class="activity-panel"><rect x="66" y="190" width="428" height="80" rx="11"/><circle cx="86" cy="211" r="4"/><circle cx="86" cy="230" r="4"/><circle cx="86" cy="249" r="4"/><path d="M100 211h132M100 230h245M100 249h184"/><path class="time" d="M430 211h42M445 230h27M422 249h50"/></g>
      </g>
    </svg>
  </div>
</template>

<script setup>
const props = defineProps({ type: { type: String, required: true } })
const id = name => `${name}-${props.type}`
const sources = [{ x: 88, y: 96 }, { x: 82, y: 224 }, { x: 164, y: 58 }, { x: 164, y: 282 }]
</script>

<style scoped>
.art{--ink:#1d8446;--ink-2:#73a942;height:100%;min-height:0;color:var(--lp-text);border:1px solid color-mix(in srgb,var(--forest-600) 18%,var(--lp-border));border-radius:20px;background:linear-gradient(145deg,color-mix(in srgb,var(--lp-surface) 96%,var(--forest-500)),var(--lp-surface));box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 7%,transparent);overflow:hidden}.art-domain{--ink:#4d8a3b;--ink-2:#1d8446}.art-screenshot{--ink:#3f914c;--ink-2:#8bad3f}.art-control{--ink:#176637;--ink-2:#5fa947}.art-remote{--ink:#168354;--ink-2:#77a93e}.art-console{--ink:#2d9360;--ink-2:#84ad45}svg{display:block;width:100%;height:100%}.art text{text-rendering:geometricPrecision}.grid{color:var(--lp-text)}
.orbit,.scope{fill:none;stroke:color-mix(in srgb,var(--ink) 22%,var(--lp-border));stroke-width:1.4;stroke-dasharray:5 8}.orbit.faint{opacity:.55}.source-halo{fill:color-mix(in srgb,var(--ink) 9%,transparent)}.sources circle:not(.source-halo):not(.pulse-ring),.out-dot{fill:var(--ink)}.pulse-ring,.out-ring{fill:none;stroke:var(--ink);opacity:.35}.pulse-ring{animation:pulse 2.4s ease-out infinite;transform-box:fill-box;transform-origin:center}.signal-path,.out-path{fill:none;stroke:var(--ink);stroke-width:2;stroke-linecap:round;stroke-dasharray:4 8;animation:dash 5s linear infinite}.prism-back{fill:url(#wash-search);stroke:var(--ink)}.prism-left{fill:color-mix(in srgb,var(--ink) 16%,var(--lp-surface));stroke:var(--ink)}.prism-right{fill:color-mix(in srgb,var(--ink-2) 13%,var(--lp-surface));stroke:var(--ink-2)}.prism-top{fill:color-mix(in srgb,var(--ink) 7%,var(--lp-surface));stroke:var(--ink)}.core-dot{fill:var(--ink);filter:url(#glow-search)}
.raw-stack>rect:first-child,.clean-stack>rect:first-child,.frame>rect:first-child,.viewport>rect:first-child,.front-screen>rect:first-child,.back-screen>rect:first-child{fill:var(--lp-surface);stroke:var(--lp-border)}.raw-line,.clean-stack path,.frame-lines,.viewport>path:first-of-type,.front-screen>path,.back-screen>path{fill:none;stroke:var(--lp-border);stroke-width:7;stroke-linecap:round}.raw-block{fill:color-mix(in srgb,#ef4444 12%,var(--lp-surface))}.noise-marks{fill:#ef4444;stroke:#ef4444;opacity:.55}.flow-line,.transform-line{fill:none;stroke:var(--ink);stroke-width:2.5;stroke-dasharray:5 7;animation:dash 4s linear infinite}.sieve path:first-child{fill:url(#wash-extract);stroke:var(--ink);stroke-width:2}.sieve .shine{fill:none;stroke:var(--ink);stroke-width:2}.clean-stack circle{fill:var(--ink)}.clean-stack path{stroke-width:6}.clean-stack rect:last-of-type{fill:color-mix(in srgb,#10b981 14%,var(--lp-surface))}.discard{fill:#ef4444;stroke:#ef4444;opacity:.4}
.domain-page>rect:first-child,.rule-panel>rect:first-child{fill:var(--lp-surface);stroke:var(--lp-border)}.domain-page>path:first-of-type{stroke:var(--lp-border)}.domain-page>circle{fill:var(--lp-border)}.domain-address,.page-noise{fill:var(--lp-border);opacity:.65}.page-match{fill:color-mix(in srgb,var(--ink) 10%,var(--lp-surface));stroke:var(--ink);stroke-width:1.5}.page-lines,.rule-panel g path{stroke:var(--lp-border);stroke-width:5;stroke-linecap:round}.domain-link{stroke:var(--ink);stroke-width:2.5;stroke-dasharray:5 6}.domain-arrow{fill:var(--ink)}.rule-panel .panel-title{fill:var(--ink);font:700 10px Inter,sans-serif;letter-spacing:1.2px}.rule-panel g rect{fill:var(--lp-surface);stroke:var(--lp-border)}.rule-panel g text{fill:var(--lp-muted);font:700 8px Inter,sans-serif;letter-spacing:.8px}.rule-panel .rule-active rect{fill:color-mix(in srgb,var(--ink) 10%,var(--lp-surface));stroke:var(--ink)}.rule-panel .rule-active circle{fill:#10b981}.rule-panel .rule-active text{fill:var(--ink)}
.capture-frame>rect:first-child,.quality-panel>rect:first-child,.delivery-options g>rect:first-child{fill:var(--lp-surface);stroke:var(--lp-border)}.capture-frame>path:first-of-type{stroke:var(--lp-border)}.capture-frame circle{fill:var(--lp-border)}.capture-hero{fill:url(#wash-screenshot)}.capture-lines{fill:none;stroke:var(--lp-border);stroke-width:6;stroke-linecap:round}.capture-corners{fill:none;stroke:var(--ink);stroke-width:2;stroke-linecap:round}.capture-link,.delivery-link{fill:none;stroke:var(--ink);stroke-width:2.5;stroke-dasharray:5 6}.capture-arrow,.delivery-arrow{fill:var(--ink)}.quality-title{fill:var(--ink);font:700 9px Inter,sans-serif;letter-spacing:1.2px}.quality-choice rect{fill:var(--lp-surface);stroke:var(--lp-border)}.quality-choice circle{fill:none;stroke:var(--lp-border);stroke-width:2}.quality-choice text,.delivery-options text{fill:var(--lp-muted);font:700 8px Inter,sans-serif;letter-spacing:.7px}.quality-choice path{stroke:var(--lp-border);stroke-width:3;stroke-linecap:round}.quality-choice.selected rect{fill:color-mix(in srgb,var(--ink) 10%,var(--lp-surface));stroke:var(--ink)}.quality-choice.selected circle{fill:var(--ink);stroke:var(--ink)}.quality-choice.selected text{fill:var(--ink)}.delivery-options .file-output>rect{fill:color-mix(in srgb,#10b981 9%,var(--lp-surface));stroke:#10b981}.delivery-options .file-output text{fill:#059669}.file-icon,.base64-icon{fill:none;stroke:var(--ink);stroke-width:1.8;stroke-linejoin:round}.path-line{stroke:var(--lp-border);stroke-width:4;stroke-linecap:round}.file-output>circle{fill:#10b981}
.command-list>path{stroke:var(--lp-border);stroke-width:2}.command-list g>circle{fill:var(--lp-surface);stroke:var(--lp-border)}.command-list g>rect{fill:var(--lp-surface);stroke:var(--lp-border)}.command-list text{fill:var(--lp-muted);font:700 8px Inter,sans-serif;letter-spacing:.5px}.command-list g>text:first-of-type{text-anchor:middle}.command-list .command-active>circle{fill:var(--ink);stroke:var(--ink)}.command-list .command-active>text:first-of-type{fill:#fff}.command-list .command-active>rect{fill:color-mix(in srgb,var(--ink) 10%,var(--lp-surface));stroke:var(--ink)}.command-list .command-active>text:last-of-type{fill:var(--ink)}.control-link{stroke:var(--ink);stroke-width:2.5;stroke-dasharray:5 6}.control-arrow{fill:var(--ink)}.browser-control>rect:first-child{fill:var(--lp-surface);stroke:var(--lp-border)}.browser-control>path:first-of-type{stroke:var(--lp-border)}.browser-control>circle:not(.click-ring){fill:var(--lp-border)}.control-card{fill:color-mix(in srgb,var(--ink) 7%,var(--lp-surface))}.control-lines{stroke:var(--lp-border);stroke-width:6;stroke-linecap:round}.click-target{fill:var(--ink)}.browser-control text{fill:#fff;font:700 9px Inter,sans-serif;letter-spacing:.7px}.browser-control .button-label{text-anchor:middle}.click-ring{fill:none;stroke:var(--ink);stroke-width:2;animation:pulse 2s ease-out infinite;transform-box:fill-box;transform-origin:center}.cursor{fill:var(--lp-text);stroke:var(--lp-surface);stroke-width:2}
.remote-monitor>rect:first-child,.remote-client>rect:first-child{fill:var(--lp-surface);stroke:var(--lp-border)}.monitor-screen,.remote-client>rect:nth-child(2){fill:color-mix(in srgb,var(--lp-surface) 95%,var(--ink));stroke:var(--lp-border)}.monitor-bar{stroke:var(--lp-border)}.remote-monitor>circle,.remote-client>circle{fill:var(--lp-border)}.monitor-hero,.client-hero{fill:url(#wash-remote)}.monitor-lines,.client-lines{stroke:var(--lp-border);stroke-width:6;stroke-linecap:round}.monitor-stand{fill:none;stroke:var(--lp-border);stroke-width:5;stroke-linecap:round}.remote-link{stroke:var(--ink);stroke-width:3;stroke-dasharray:5 6;animation:dash 4s linear infinite}.remote-pulse{fill:var(--ink);filter:url(#glow-remote)}.live-badge rect{fill:color-mix(in srgb,#10b981 12%,var(--lp-surface));stroke:#10b981}.live-badge circle{fill:#10b981}.live-badge text{fill:#059669;font:700 8px Inter,sans-serif;letter-spacing:.8px}
.relay-browser>rect:first-child,.relay-endpoint>rect:first-child{fill:var(--visual-surface);stroke:var(--visual-border)}.relay-browser>path:first-of-type{stroke:var(--visual-border)}.relay-browser>circle{fill:var(--visual-dot)}.relay-address{fill:var(--visual-muted)}.relay-page{fill:color-mix(in srgb,var(--ink) 10%,var(--visual-surface))}.relay-lines{fill:none;stroke:var(--visual-border);stroke-width:6;stroke-linecap:round}.relay-link{fill:none;stroke:var(--ink);stroke-width:2.5;stroke-dasharray:5 6;animation:dash 4s linear infinite}.relay-hub rect{fill:color-mix(in srgb,var(--ink) 13%,var(--visual-surface));stroke:var(--ink);stroke-width:1.5}.relay-hub path{stroke:var(--ink);stroke-width:4;stroke-linecap:round}.relay-endpoint text{fill:var(--ink);font:700 8px Inter,sans-serif;letter-spacing:.8px;text-anchor:middle}.relay-endpoint rect:not(:first-child){fill:var(--visual-muted)}.relay-endpoint path{stroke:var(--visual-border);stroke-width:5;stroke-linecap:round}.relay-endpoint circle{fill:#10b981}.relay-label rect{fill:color-mix(in srgb,#10b981 11%,var(--visual-surface));stroke:#10b981}.relay-label circle{fill:#10b981}.relay-label text{fill:#059669;font:700 8px Inter,sans-serif;letter-spacing:.8px}
.console-shell rect{fill:var(--visual-shell);stroke:var(--visual-border)}.console-shell path{stroke:var(--visual-border)}.console-shell circle{fill:var(--visual-dot)}.metric-card rect,.activity-panel rect{fill:var(--visual-surface);stroke:var(--visual-border)}.metric,.ring-value{fill:none;stroke:var(--visual-green);stroke-width:3;stroke-linecap:round}.ring-bg{fill:none;stroke:var(--visual-border);stroke-width:5}.ring-value{stroke-width:5}.metric-card path:not(.metric):not(.ring-value):not(.bars){stroke:var(--visual-border);stroke-width:5;stroke-linecap:round}.bars{stroke:var(--visual-olive);stroke-width:7;stroke-linecap:round}.activity-panel circle{fill:var(--visual-green)}.activity-panel circle:nth-of-type(2){fill:var(--visual-olive)}.activity-panel circle:nth-of-type(3){fill:#9bbd56}.activity-panel path{stroke:var(--visual-border);stroke-width:5;stroke-linecap:round}.activity-panel .time{stroke:var(--visual-dot);stroke-width:3}
@keyframes dash{to{stroke-dashoffset:-48}}@keyframes pulse{0%{transform:scale(.5);opacity:.55}80%,100%{transform:scale(1.8);opacity:0}}@keyframes blink{50%{opacity:.35}}@media(prefers-reduced-motion:reduce){.art *{animation:none!important}}@media(max-width:768px){.art{border-radius:16px}}
</style>
