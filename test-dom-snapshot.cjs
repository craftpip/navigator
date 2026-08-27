const puppeteer = require('puppeteer-core');

const DOMSNAPSHOT_SCRIPT = `
(() => {
  function escapeXml(str) {
    return String(str)
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"')
      .replace(/'/g, '&apos;');
  }

  function cssPath(el) {
    if (!el || el === document.documentElement) return 'html';
    const parts = [];
    while (el && el !== document.documentElement) {
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector += '#' + escapeXml(el.id);
        parts.unshift(selector);
        break;
      } else {
        let sib = el, nth = 1;
        while (sib = sib.previousElementSibling) nth++;
        if (nth > 1) selector += ':nth-of-type(' + nth + ')';
        parts.unshift(selector);
      }
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function xpathFor(el) {
    if (!el) return '';
    if (el === document.documentElement) return '/html';
    const parts = [];
    while (el && el !== document.documentElement) {
      let idx = 1;
      let sib = el.previousElementSibling;
      while (sib) { if (sib.tagName === el.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(el.tagName.toLowerCase() + '[' + idx + ']');
      el = el.parentElement;
    }
    return '/' + parts.join('/');
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getAllElements() {
    const elements = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT, null, false);
    let node;
    while (node = walker.nextNode()) {
      if (isVisible(node)) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        elements.push({
          tag: node.tagName.toLowerCase(),
          selector: cssPath(node),
          xpath: xpathFor(node),
          rect: {
            x: Math.round(rect.x + window.scrollX),
            y: Math.round(rect.y + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          style: {
            backgroundColor: style.backgroundColor,
            color: style.color,
            borderTopColor: style.borderTopColor,
            borderTopWidth: style.borderTopWidth,
            borderRightColor: style.borderRightColor,
            borderRightWidth: style.borderRightWidth,
            borderBottomColor: style.borderBottomColor,
            borderBottomWidth: style.borderBottomWidth,
            borderLeftColor: style.borderLeftColor,
            borderLeftWidth: style.borderLeftWidth,
            borderTopLeftRadius: style.borderTopLeftRadius,
            borderTopRightRadius: style.borderTopRightRadius,
            borderBottomRightRadius: style.borderBottomRightRadius,
            borderBottomLeftRadius: style.borderBottomLeftRadius,
            opacity: style.opacity,
            fontSize: style.fontSize,
            fontFamily: style.fontFamily,
            fontWeight: style.fontWeight,
            fontStyle: style.fontStyle,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            whiteSpace: style.whiteSpace,
            textOverflow: style.textOverflow,
            overflow: style.overflow,
            boxShadow: style.boxShadow,
            backgroundImage: style.backgroundImage,
            transform: style.transform,
            filter: style.filter,
            backdropFilter: style.backdropFilter,
            outline: style.outline,
            zIndex: style.zIndex
          },
          text: node.innerText?.substring(0, 500) || '',
          nodeType: node.nodeType
        });
      }
    }
    return elements;
  }

  return {
    elements: getAllElements(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    title: document.title,
    url: window.location.href,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    htmlBg: getComputedStyle(document.documentElement).backgroundColor
  };
})()
`;

(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:45767/devtools/browser/abd8102c-6f4a-41a7-a615-372f838fb8ef' });
  const page = await browser.newPage();
  await page.goto('http://10.69.1.164:1994/', { waitUntil: 'domcontentloaded' });
  console.log('Page loaded:', page.url());
  
  const result = await page.evaluate(DOMSNAPSHOT_SCRIPT);
  console.log('Elements:', result.elements.length);
  console.log('First element:', JSON.stringify(result.elements[0], null, 2));
  
  await page.close();
  await browser.disconnect();
})().catch(e => console.error(e));