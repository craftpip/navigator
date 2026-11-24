// src/svg/extractor.js — browser-side DOM extraction (runs inside page.evaluate)
// Owner: Agent A — DOM/pixels → data. Must stay self-contained (no imports inside function) — serialized via page.evaluate.

// opts.viewportOnly (plan 65): collect only elements inside the viewport clip.
export function svgExtractor(limit, opts) {
  function cssPathSvg(element) {
    if (!(element instanceof Element)) return null;
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 10) {
      let segment = node.tagName.toLowerCase();
      if (node.id) {
        segment += '#' + node.id;
        parts.unshift(segment);
        break;
      }
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(function(c){ return c.tagName === node.tagName; }) : [];
      if (siblings.length > 1) {
        const index = siblings.indexOf(node);
        segment += ':nth-of-type(' + (index + 1) + ')';
      }
      parts.unshift(segment);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function xpathForSvg(element) {
    if (!(element instanceof Element)) return null;
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) { if (sibling.tagName === node.tagName) index++; sibling = sibling.previousElementSibling; }
      parts.unshift(node.tagName.toLowerCase() + '[' + index + ']');
      node = node.parentElement;
    }
    return '/' + parts.join('/');
  }
  function visibleSvg(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }
  function svgVisuallyHidden(el) {
    const cls = ' ' + String((el.getAttribute && el.getAttribute('class')) || '').toLowerCase() + ' ';
    return /sr-only|visually-hidden|screen-reader|show-for-sr/.test(cls);
  }
  function innerTextVisible(el) {
    const parts = [];
    let blocked = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (n) {
        if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
        const cls = ' ' + String(n.getAttribute('class') || '').toLowerCase() + ' ';
        const tag = n.tagName.toLowerCase();
        if (/sr-only|visually-hidden|screen-reader|show-for-sr/.test(cls)) return NodeFilter.FILTER_REJECT;
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
        try {
          const cs = window.getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          blocked = cs.display !== 'inline';
        } catch (e) { /* keep walking */ }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) {
        parts.push(String(n.nodeValue).replace(/\s+/g, ' '));
      } else if (n.tagName && n.tagName.toLowerCase() === 'br') {
        parts.push('\n');
      } else if (blocked && parts.length && !/\n$/.test(parts[parts.length - 1])) {
        parts.push('\n');
      }
    }
    return parts.join('').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }
  let __svgMeasureCanvas = null;
  function measureSvgText(text, style) {
    try {
      if (!__svgMeasureCanvas) { __svgMeasureCanvas = document.createElement('canvas'); }
      const ctx = __svgMeasureCanvas.getContext('2d');
      const size = style.fontSize || '12px';
      const fam = (style.fontFamily || 'monospace').split(',')[0].replace(/["']/g,'').trim();
      ctx.font = (style.fontStyle || '') + ' ' + (style.fontWeight || '') + ' ' + size + ' ' + fam;
      const ls = parseFloat(style.letterSpacing) || 0;
      // letter-spacing is between glyphs, not after last char: n chars => (n-1) gaps
      return ctx.measureText(text).width + ls * Math.max(0, text.length - 1);
    } catch { return 0; }
  }
  function computedStyleSvg(el) {
    const s = window.getComputedStyle(el);
    // capture per-side borders — header at 1994 has borderBottom 1px solid #e5e7eb, not top
    const bTopW = s.borderTopWidth, bBotW = s.borderBottomWidth, bLeftW = s.borderLeftWidth, bRightW = s.borderRightWidth;
    const bTopC = s.borderTopColor, bBotC = s.borderBottomColor, bLeftC = s.borderLeftColor, bRightC = s.borderRightColor;
    const maxW = [bTopW,bBotW,bLeftW,bRightW].map(v=>parseFloat(v)||0).reduce((a,b)=>Math.max(a,b),0);
    const hasAnyBorder = maxW>0 && [s.borderTopStyle,s.borderBottomStyle,s.borderLeftStyle,s.borderRightStyle].some(v=>v!=='none');
    const pickColor = [bTopC,bBotC,bLeftC,bRightC].find(c=>c && c!=='transparent' && c!=='rgba(0, 0, 0, 0)' && c!=='rgba(0,0,0,0)') || s.borderTopColor;
    return {
      bg: s.backgroundColor,
      color: s.color,
      borderColor: pickColor,
      borderWidth: hasAnyBorder ? (maxW+'px') : s.borderTopWidth,
      borderTopWidth: bTopW,
      borderBottomWidth: bBotW,
      borderLeftWidth: bLeftW,
      borderRightWidth: bRightW,
      borderTopColor: bTopC,
      borderBottomColor: bBotC,
      borderLeftColor: bLeftC,
      borderRightColor: bRightC,
      borderCollapse: s.borderCollapse || "",
      borderSpacing: s.borderSpacing || "",
      captionSide: s.captionSide || "",
      radius: s.borderRadius,
      backgroundPosition: s.backgroundPosition,
      backgroundSize: s.backgroundSize,
      backgroundRepeat: s.backgroundRepeat,
      opacity: s.opacity,
      fontSize: s.fontSize,
      fontFamily: s.fontFamily,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      whiteSpace: s.whiteSpace,
      textOverflow: s.textOverflow,
      textAlign: s.textAlign,
      fontStyle: s.fontStyle,
      lineClamp: s.webkitLineClamp && s.webkitLineClamp !== 'none' ? s.webkitLineClamp : (s.lineClamp || ''),
      paddingLeft: parseFloat(s.paddingLeft) || 0,
      paddingRight: parseFloat(s.paddingRight) || 0,
      overflow: s.overflow,
      overflowX: s.overflowX,
      overflowY: s.overflowY,
      boxShadow: s.boxShadow && s.boxShadow !== 'none' ? s.boxShadow : '',
      backgroundImage: s.backgroundImage && s.backgroundImage !== 'none' ? s.backgroundImage : '',
      transform: s.transform && s.transform !== 'none' ? s.transform : '',
      filter: s.filter && s.filter !== 'none' ? s.filter : '',
      backdropFilter: (s.backdropFilter && s.backdropFilter !== 'none' ? s.backdropFilter : (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none' ? s.webkitBackdropFilter : '')),
      outline: s.outline && s.outline !== 'none' ? s.outline : '',
      outlineWidth: s.outlineWidth || '',
      outlineStyle: s.outlineStyle || '',
      outlineColor: s.outlineColor || '',
      outlineOffset: s.outlineOffset && s.outlineOffset !== '0px' ? s.outlineOffset : '',
      textDecorationLine: s.textDecorationLine && s.textDecorationLine !== 'none' ? s.textDecorationLine : '',
      textDecorationColor: s.textDecorationColor || '',
      textDecorationStyle: s.textDecorationStyle || '',
      textDecorationThickness: s.textDecorationThickness && s.textDecorationThickness !== 'auto' ? s.textDecorationThickness : '',
      textTransform: s.textTransform && s.textTransform !== 'none' ? s.textTransform : '',
      verticalAlign: s.verticalAlign && s.verticalAlign !== 'baseline' ? s.verticalAlign : '',
      transformOrigin: s.transformOrigin && s.transformOrigin !== '50% 50%' ? s.transformOrigin : '',
      objectFit: s.objectFit && s.objectFit !== 'fill' ? s.objectFit : '',
      objectPosition: s.objectPosition && s.objectPosition !== '50% 50%' ? s.objectPosition : '',
      overflowWrap: s.overflowWrap && s.overflowWrap !== 'normal' ? s.overflowWrap : '',
      wordBreak: s.wordBreak && s.wordBreak !== 'normal' ? s.wordBreak : '',
      clipPath: s.clipPath && s.clipPath !== 'none' ? s.clipPath : '',
      mask: s.mask && s.mask !== 'none' ? s.mask : '',
      maskImage: s.maskImage && s.maskImage !== 'none' ? s.maskImage : ''
    };
  }
  function queryAllWithShadow(selector) {
    const out = [];
    const seenEl = new Set();
    const walk = (root) => {
      try {
        const found = root.querySelectorAll(selector);
        for (let i = 0; i < found.length; i++) {
          const el = found[i];
          if (!seenEl.has(el)) { seenEl.add(el); out.push(el); }
        }
      } catch {}
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n = walker.nextNode();
      while (n) {
        if (n.shadowRoot) walk(n.shadowRoot);
        n = walker.nextNode();
      }
    };
    walk(document);
    return out;
  }
  const WORD_RECT_CAP = 300; // words per element with exact Range rects — beyond this, builder falls back to estimated wrap
  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;
  const nodes = [];
  const seen = new Set();
  let index = 0;
  // A viewport capture (fullPage:false) is clipped to the viewport afterwards
  // by capturePageAsSvg (src/svg/capture.js). Collecting page-wide would spend
  // the budget and the per-category caps below the fold, and the clip would
  // then discard almost everything. With viewportOnly, candidates outside that
  // clip are skipped before they count. Same test as the capture filter:
  // document coordinates, viewport size, 50px margin. (Duplicated rather than
  // imported: this function is serialized into the page.)
  const viewportOnly = Boolean(opts && opts.viewportOnly);
  const CLIP_MARGIN = 50;
  function insideClip(el) {
    if (!viewportOnly) return true;
    const r = el.getBoundingClientRect();
    const x = r.x + scrollX;
    const y = r.y + scrollY;
    return x + r.width > -CLIP_MARGIN && x < window.innerWidth + CLIP_MARGIN &&
      y + r.height > -CLIP_MARGIN && y < window.innerHeight + CLIP_MARGIN;
  }
  function addNodeSvg(el, kind) {
    if (!insideClip(el)) return;
    const key = cssPathSvg(el);
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (!visibleSvg(el)) return;
    if (svgVisuallyHidden(el)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 3 && rect.height < 3) return;
    let text = '';
    let src = '';
    let html = '';
    let alt = '';
    let href = '';
    let value = '';
    let placeholder = '';
    let type = '';
    if (kind === 'table') {
      try { html = el.outerHTML.slice(0, 20000); } catch {}
      text = innerTextVisible(el).trim().slice(0, 300);
    } else if (kind === 'img') {
      src = el.currentSrc || el.src || el.getAttribute('data-src') || '';
      try { if(src && !src.startsWith('data:') && !src.startsWith('http') && !src.startsWith('blob:')) src = new URL(src, location.href).href; } catch {}
      alt = el.alt || '';
      text = alt || (src ? src.split('/').pop() : 'image');
      text = text.slice(0, 120);
    } else if (kind === 'canvas') {
      try { src = el.toDataURL('image/png'); } catch { src = ''; }
      if (src && src.length > 180000) src = src.slice(0, 180000);
      alt = el.getAttribute('aria-label') || '';
      text = alt || 'canvas';
      text = text.slice(0, 80);
    } else if (kind === 'iframe') {
      src = el.src || el.getAttribute('src') || '';
      try { if(src && !src.startsWith('data:') && !src.startsWith('http') && !src.startsWith('blob:')) src = new URL(src, location.href).href; } catch {}
      alt = el.title || '';
      text = alt || src || 'iframe';
      text = text.slice(0, 120);
      href = src;
    } else {
      if (el.value != null && String(el.value).trim()) value = String(el.value).slice(0,120);
      if (el.placeholder) placeholder = el.placeholder.slice(0,80);
      if (el.type) type = el.type;
      href = el.href || '';
      text = innerTextVisible(el).trim().slice(0, 300);
      if (!text) {
        if (value) text = value;
        else if (placeholder) text = placeholder;
      }
    }
    if (!text && !src && !value && !placeholder) {
      const st = window.getComputedStyle(el);
      const bg = st.backgroundColor;
      const isTransparent = !bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)' || bg === 'rgba(0,0,0,0)';
      const hasBorder = [st.borderTopWidth,st.borderBottomWidth,st.borderLeftWidth,st.borderRightWidth].some(v=>v && v!=='0px') && [st.borderTopStyle,st.borderBottomStyle,st.borderLeftStyle,st.borderRightStyle].some(v=>v!=='none');
      if (kind === 'container' && isTransparent && !hasBorder) return;
      if (kind === 'interactive' && !text && !value && !placeholder) return;
    }
    index++;
    const _style = computedStyleSvg(el);
    let _measuredW = 0;
    let _wordWidths = [];
    let _words = [];
    let _textRect = null;
    let _wordRects = [];
    let _spaceW = 0;
    let _fontAsc = 0;
    let _fontDesc = 0;
    try {
      // font bounding metrics — lets the builder convert Range-rect TOPs to SVG
      // baselines exactly (SVG y IS the baseline; Range rects give line-box tops)
      try {
        if (!__svgMeasureCanvas) { __svgMeasureCanvas = document.createElement('canvas'); }
        const mctx = __svgMeasureCanvas.getContext('2d');
        const msize = _style.fontSize || '12px';
        const mfam = (_style.fontFamily || 'monospace').split(',')[0].replace(/["']/g,'').trim();
        mctx.font = (_style.fontStyle || '') + ' ' + (_style.fontWeight || '') + ' ' + msize + ' ' + mfam;
        const mm = mctx.measureText('Hg');
        _fontAsc = Math.round((mm.fontBoundingBoxAscent || 0) * 10) / 10;
        _fontDesc = Math.round((mm.fontBoundingBoxDescent || 0) * 10) / 10;
      } catch {}
      if (text) {
        const clean = text.replace(/\n/g,' ').trim().slice(0,200);
        _measuredW = measureSvgText(clean.slice(0,120), _style);
        const ws = clean.split(/\s+/).filter(Boolean).slice(0,50);
        _words = ws;
        for (const w of ws) _wordWidths.push(measureSvgText(w, _style));
        try { _spaceW = measureSvgText(' ', _style); } catch {}
        try {
          const walker2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n2 = walker2.nextNode();
          while(n2){
            if(n2.nodeValue && n2.nodeValue.trim().length>0){
              try{
                const r=document.createRange(); r.selectNodeContents(n2);
                const rc=r.getBoundingClientRect();
                // Range for hanging baseline exact y — keep subpixel (no round) for 100% fidelity, scroll offset added
                if(rc.width>2 && rc.height>2){ _textRect={x:Math.round((rc.x+scrollX)*10)/10, y:Math.round((rc.y+scrollY)*10)/10, width:Math.round(rc.width*10)/10, height:Math.round(rc.height*10)/10}; break; }
              }catch{}
            }
            n2=walker2.nextNode();
          }
        } catch {}

        // per-word rects for 100% fidelity — each word's Range rect (per-glyph when letterSpacing or CJK)
        // handles whiteSpace:pre tabs (tab width via Range, split on any whitespace including \t) and CJK kinsoku (per-char)
        try{
          const walker3 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n3 = walker3.nextNode();
          const lsPre = parseFloat(_style.letterSpacing) || 0;
          const wsPre = String(_style.whiteSpace||"").toLowerCase();
          const isPre = wsPre === "pre" || wsPre === "pre-wrap" || wsPre === "pre-line";
          while(n3 && _wordRects.length < WORD_RECT_CAP){
            const txt = n3.nodeValue || "";
            // CJK kinsoku detection: if node contains CJK, use per-glyph Range so each glyph's x reflects browser kinsoku wrapping
            const hasCJK = /[\u3000-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(txt);
            const needPerGlyph = Math.abs(lsPre) > 0.05 || hasCJK;
            if (needPerGlyph) {
              // per-glyph: one Range per visible character (skip whitespace; tabs counted via x offset of next glyph)
              for (let gi=0; gi<txt.length && _wordRects.length < WORD_RECT_CAP; gi++) {
                const ch = txt[gi];
                if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue;
                // kinsoku: skip leading punctuation that browser would never place at line start — but we still capture rect as laid out
                try{
                  const r=document.createRange(); r.setStart(n3, gi); r.setEnd(n3, gi+1);
                  const rc=r.getBoundingClientRect();
                  if(rc.width>0.5 && rc.height>0.5){
                    _wordRects.push({word:ch, x:Math.round((rc.x+scrollX)*10)/10, y:Math.round((rc.y+scrollY)*10)/10, width:Math.round(rc.width*10)/10, height:Math.round(rc.height*10)/10});
                  }
                }catch{}
              }
            } else {
              let searchFrom = 0;
              // whiteSpace:pre tabs: split on /\s+/ includes \t, Range start idx accounts for tab width natively
              const wordsInNode = isPre ? txt.split(/[ \t\n\r]+/).filter(Boolean) : txt.split(/\s+/).filter(Boolean);
              for(const w of wordsInNode){
                const idx = txt.indexOf(w, searchFrom);
                if(idx>=0){
                  searchFrom = idx + w.length;
                  try{
                    const r=document.createRange(); r.setStart(n3, idx); r.setEnd(n3, idx+w.length);
                    const rc=r.getBoundingClientRect();
                    if(rc.width>1 && rc.height>1){
                      _wordRects.push({word:w, x:Math.round((rc.x+scrollX)*10)/10, y:Math.round((rc.y+scrollY)*10)/10, width:Math.round(rc.width*10)/10, height:Math.round(rc.height*10)/10});
                      if(_wordRects.length>=WORD_RECT_CAP) break;
                    }
                  }catch{}
                }
              }
            }
            n3=walker3.nextNode();
          }
        }catch{}
      }
    } catch {}
    nodes.push({
      index: index,
      kind: kind,
      tagName: el.tagName.toLowerCase(),
      selector: key,
      xpath: xpathForSvg(el),
      role: el.getAttribute('role') || '',
      text: text || '',
      href: href || '',
      src: src || '',
      alt: alt || '',
      html: html || '',
      value: value || '',
      placeholder: placeholder || '',
      type: type || '',
      rect: { x: Math.round(rect.x + scrollX), y: Math.round(rect.y + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
      style: _style,
      measuredWidth: _measuredW,
      wordWidths: _wordWidths,
      words: _words,
      textRect: _textRect,
      wordRects: _wordRects,
      spaceWidth: _spaceW,
      fontAsc: _fontAsc,
      fontDesc: _fontDesc,
      z: (function(){ try{ const v=window.getComputedStyle(el).zIndex; return v==='auto'?0:parseInt(v,10)||0;}catch(e){return 0;}})()
    });
  }
  // Sweep priority with FAIR per-category caps. Global first-come-first-served
  // lets any single category (table cells on dense pages, styled divs on
  // dashboard pages) evict everything else at capped limits — each failure
  // mode hit one benchmark or the other. Caps guarantee representation for
  // every content class; the reserved pass spends whatever remains on
  // aggregate containers and table wrappers, which duplicate leaf glyphs.
  const caps = {
    heading: 40,
    cell: Math.max(24, Math.floor(limit * 0.22)),
    paragraph: Math.max(24, Math.floor(limit * 0.14)),
    media: Math.max(16, Math.floor(limit * 0.10)),
    link: Math.max(20, Math.floor(limit * 0.10)),
    interactive: Math.max(24, Math.floor(limit * 0.12)),
  };
  const used = { heading: 0, cell: 0, paragraph: 0, media: 0, link: 0, interactive: 0 };
  function capped(bucket, el, kind) {
    if (nodes.length >= limit) return;
    if (used[bucket] >= caps[bucket]) return;
    if (!insideClip(el)) return; // an off-clip element must not use up a cap slot
    used[bucket]++;
    addNodeSvg(el, kind);
  }
  queryAllWithShadow('h1, h2, h3, h4, h5, h6').forEach(function(el){ capped('heading', el, 'heading'); });
  queryAllWithShadow('th, td').forEach(function(el){ capped('cell', el, 'container'); });
  queryAllWithShadow('p').forEach(function(el){
    const tx = innerTextVisible(el).trim();
    if (tx.length > 8) capped('paragraph', el, 'paragraph');
  });
  queryAllWithShadow('img').forEach(function(el){ if (el.src || el.getAttribute('data-src')) capped('media', el, 'img'); });
  queryAllWithShadow('canvas').forEach(function(el){ capped('media', el, 'canvas'); });
  queryAllWithShadow('iframe').forEach(function(el){ capped('media', el, 'iframe'); });
  queryAllWithShadow('a[href]').forEach(function(el){
    const tx = innerTextVisible(el).trim();
    if (tx.length > 1) capped('link', el, 'link');
  });
  queryAllWithShadow('button, input, textarea, select, [role="button"], [role="textbox"]').forEach(function(el){ capped('interactive', el, 'interactive'); });
  let liCount = 0;
  queryAllWithShadow('li').forEach(function(el){
    if (liCount >= 20) return;
    const tx = innerTextVisible(el).trim();
    if (tx.length > 5 && tx.length < 200) { addNodeSvg(el, 'list-item'); liCount++; }
  });
  // Reserved pass — spends leftover budget on context: structural containers,
  // styled divs (panel/card backgrounds), span runs, then table wrappers.
  if (nodes.length < limit) {
    queryAllWithShadow('header, nav, main, article, section, aside, footer').forEach(function(el){
      if (nodes.length >= limit) return;
      addNodeSvg(el, 'container');
    });
    queryAllWithShadow('div').forEach(function(el){
      if (nodes.length >= limit) return;
      const hasId = !!el.id;
      const hasTestId = el.hasAttribute('data-testid');
      const st = window.getComputedStyle(el);
      const bg = st.backgroundColor;
      const hasBg = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgba(0,0,0,0)';
      const hasBorder = [st.borderTopWidth,st.borderBottomWidth,st.borderLeftWidth,st.borderRightWidth].some(v=>v && v!=='0px') && [st.borderTopStyle,st.borderBottomStyle,st.borderLeftStyle,st.borderRightStyle].some(v=>v!=='none');
      if (hasId || hasTestId || hasBg || hasBorder) addNodeSvg(el, 'container');
    });
    let extraCount = 0;
    queryAllWithShadow('span, strong, em, code, div').forEach(function(el){
      if (extraCount >= 150) return;
      if (nodes.length >= limit) return;
      const tx = innerTextVisible(el).trim();
      if (tx.length < 3 || tx.length > 140) return;
      if (!visibleSvg(el)) return;
      extraCount++;
      addNodeSvg(el, 'paragraph');
    });
    queryAllWithShadow('table').forEach(function(el){ if (nodes.length < limit) addNodeSvg(el, 'table'); });
    queryAllWithShadow('thead, tbody, tfoot, tr').forEach(function(el){ if (nodes.length < limit) addNodeSvg(el, 'container'); });
  }
  return {
    title: document.title,
    url: location.href,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    bodyBg: (function(){ try{ return getComputedStyle(document.body).backgroundColor; }catch(e){ return ""; }})(),
    htmlBg: (function(){ try{ return getComputedStyle(document.documentElement).backgroundColor; }catch(e){ return ""; }})(),
    fontLinks: (function(){ try{ return Array.from(document.querySelectorAll('link[rel="stylesheet"][href*="fonts"]')).map(l=>l.href).slice(0,5); }catch(e){ return []; }})(),
    html: (function(){ try{ return document.documentElement.outerHTML.slice(0, 400000); }catch(e){ return ""; }})(),
    htmlInline: (function(){
      try{
        const clone = document.documentElement.cloneNode(true);
        const origAll = document.querySelectorAll('*');
        const cloneAll = clone.querySelectorAll('*');
        // Only inline visual props; exclude layout-canonicalizers that break foreignObject reflow (block-size/inline-size/height on html/body)
        const VISUAL_RE = /^(display|visibility|opacity|background|color|border|font|padding|margin|position|top|left|right|bottom|flex|grid|overflow|box-shadow|transform|filter|backdrop-filter|outline|text|letter-spacing|line-height|white-space|width|height)/;
        const SKIP_PROPS = new Set(['block-size','inline-size','min-block-size','min-inline-size','max-block-size','max-inline-size','inline-size','block-size']);
        for(let i=0;i<Math.min(origAll.length, cloneAll.length);i++){
          const o = origAll[i], c = cloneAll[i];
          const tag = (o.tagName||'').toLowerCase();
          const cs = getComputedStyle(o);
          let css = '';
          for(let j=0;j<cs.length;j++){
            const prop = cs[j];
            if(SKIP_PROPS.has(prop)) continue;
            if(tag==='html' || tag==='body'){
              if(/^(block-size|inline-size|min-block-size|min-inline-size|max-block-size|max-inline-size|height|width|block-size)/.test(prop)) continue;
            }
            if(/animation|transition/.test(prop)) continue;
            const val = cs.getPropertyValue(prop);
            if(val && val!=='initial' && val!=='none' || VISUAL_RE.test(prop)){
              css += prop+':'+val+';';
            }
          }
          // ::before/::after for 100% fidelity
          try{
            const before = getComputedStyle(o, '::before');
            if(before && before.content && before.content!=='none' && before.content!=='""'){
              css += '::before{content:'+before.content+';}';
            }
            const after = getComputedStyle(o, '::after');
            if(after && after.content && after.content!=='none' && after.content!=='""'){
              css += '::after{content:'+after.content+';}';
            }
          }catch{}
          if(css) c.setAttribute('style', css + (c.getAttribute('style')?';'+c.getAttribute('style'):''));
          if(c.tagName==='IMG' && c.getAttribute('src') && !c.getAttribute('src').startsWith('http') && !c.getAttribute('src').startsWith('data:')){
            try{ c.setAttribute('src', new URL(c.getAttribute('src'), location.href).href); }catch{}
          }
          if(c.tagName==='CANVAS'){
            try{ const oc = origAll[i]; if(oc.toDataURL){ const d=oc.toDataURL('image/png'); if(d.length<300000) c.setAttribute('src', d); } }catch{}
          }
        }
        return clone.outerHTML.slice(0, 800000);
      }catch(e){ return ""; }
    })(),
    scrollbar: (function(){ try{
      const sw = window.innerWidth - document.documentElement.clientWidth;
      const sh = window.innerHeight;
      const st = window.scrollY;
      const docH = document.documentElement.scrollHeight;
      const thumbH = Math.max(20, Math.round(sh * sh / docH));
      const thumbY = docH > sh ? Math.round(st / (docH - sh) * (sh - thumbH)) : 0;
      return { width: sw, thumbY, thumbH, visible: sw>0 && docH>sh };
    }catch(e){ return {width:0, thumbY:0, thumbH:0, visible:false}; }})(),
    elements: nodes.slice(0, limit)
  };
}

// One-file helper: pass a Puppeteer/CDP Page, get back {svg, data, clipW, clipH}
// Usage: import { capturePageAsSvg } from './svg.js'; const {svg} = await capturePageAsSvg(page, {elementLimit:250, fullPage:true})
