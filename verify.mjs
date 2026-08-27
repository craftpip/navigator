import { svgExtractor } from "/app/src/svg/extractor.js";
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 1920, height: 1080 });
await p.goto("http://10.69.1.164:1994/", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise(r=>setTimeout(r,1200));
const d = await p.evaluate(svgExtractor, 3000);
// pick 3 elements with selector/xpath
for (const el of d.elements.slice(10,13)) {
  const selOk = await p.evaluate((s)=>{ try{ return !!document.querySelector(s); }catch(e){ return "bad:"+e.message; } }, el.selector);
  const xpOk = await p.evaluate((xp)=>{
    try{ const r=document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return !!r.singleNodeValue; }catch(e){ return "bad:"+e.message; }
  }, el.xpath);
  console.log(JSON.stringify({tag:el.tagName, sel:el.selector.slice(0,80), selOk, xp:el.xpath.slice(0,80), xpOk}));
}
await b.close();
