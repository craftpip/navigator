import { svgExtractor } from "/app/src/svg/extractor.js";
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 1920, height: 1080 });
await p.goto("https://webcontentextraction.org", { waitUntil: "networkidle2", timeout: 60000 }).catch(e => console.log("nav:", e.message));
await new Promise(r => setTimeout(r, 1500));
const d = await p.evaluate(svgExtractor, 3000);
const h1 = (d.elements||[]).find(n => n.tagName === "h1");
if (!h1) { console.log("no h1"); process.exit(0); }
const frags = h1.wordRects || [];
const singleChar = frags.filter(f => f.word.length === 1).length;
console.log(JSON.stringify({
  text: h1.text.slice(0, 60),
  chars: h1.text.trim().length,
  fragments: frags.length,
  singleCharFragments: singleChar,
  fontSize: h1.style.fontSize,
  fontWeight: h1.style.fontWeight,
  letterSpacing: h1.style.letterSpacing,
  fontFamily: String(h1.style.fontFamily).slice(0, 60),
  lineHeight: h1.style.lineHeight,
  sampleFrags: frags.slice(0, 6).map(f => ({ w: f.word, x: f.x, y: f.y, wd: f.width }))
}, null, 1));
await b.close();
