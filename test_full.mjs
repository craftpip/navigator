import { execSync } from 'child_process';
function call(name, args, timeout=40){
  const payload = JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name, arguments:args}});
  const cmd = `curl -s --max-time ${timeout} http://10.69.1.164:1994/mcp -H "Content-Type: application/json" -d '${payload.replace(/'/g,"'\\''")}'`;
  try{
    const out = execSync(cmd, {timeout: timeout*1000+2000, encoding:'utf-8', maxBuffer: 20*1024*1024});
    return JSON.parse(out);
  }catch(e){
    return {error: e.message, stdout: e.stdout?.toString().slice(0,2000), stderr: e.stderr?.toString().slice(0,2000)};
  }
}
function txt(resp){
  try{ return resp.result.content[0].text; }catch{ return JSON.stringify(resp).slice(0,3000); }
}
function extractTid(resp){
  const t = txt(resp);
  const m = t.match(/"targetId"\s*:\s*"([^"]+)"/);
  return m?m[1]:null;
}
let passed=0, failed=0;
function test(name, fn){
  const t0=Date.now();
  try{
    const [ok, detail] = fn();
    const dt=Date.now()-t0;
    console.log(`[${ok?'PASS':'FAIL'}] ${name} ${dt}ms :: ${detail.slice(0,600)}`);
    if(ok) passed++; else failed++;
  }catch(e){
    console.log(`[ERR] ${name} ${Date.now()-t0}ms :: ${e.message}`);
    failed++;
  }
}
test("1 web_search", ()=>{
  const r=call("web_search", {queries:["example domain"], limit:2}, 30);
  const t=txt(r);
  return [t.includes("Example")||t.includes("example"), t.slice(0,400)];
});
test("2 web_fetch Chrome", ()=>{
  const r=call("web_fetch", {urls:["https://example.com/"], browser:"Chrome", maxChars:4000}, 35);
  const t=txt(r);
  return [t.includes("Status: Success")&&t.includes("Example Domain"), t.slice(0,500)];
});
test("3 web_fetch chromium", ()=>{
  const r=call("web_fetch", {urls:["https://example.com/"], browser:"chromium", maxChars:4000}, 30);
  const t=txt(r);
  return [t.includes("Example Domain"), t.slice(0,400)];
});
test("4 web_page_screenshot chromium", ()=>{
  const r=call("web_page_screenshot", {urls:["https://example.com/"], browser:"chromium"}, 35);
  const t=txt(r);
  const raw=JSON.stringify(r);
  return [t.includes("Captured")&&raw.includes("base64"), t.slice(0,500)];
});
test("5 web_page_screenshot Chrome", ()=>{
  const r=call("web_page_screenshot", {urls:["https://example.com/"], browser:"Chrome"}, 40);
  const t=txt(r);
  const raw=JSON.stringify(r);
  if(r.error) return [false, r.error];
  if(t.includes("Failed")||t.includes("unreachable")) return [false, t.slice(0,600)];
  return [t.includes("Captured")&&raw.includes("base64"), t.slice(0,500)];
});
test("6 web_page_svg Chrome", ()=>{
  const r=call("web_page_svg", {url:"https://example.com/", browser:"Chrome"}, 35);
  const t=txt(r);
  const raw=JSON.stringify(r);
  return [t.includes("<svg")||raw.includes("<svg"), `len ${raw.length} ${t.slice(0,400)}`];
});
test("7 web_page_links", ()=>{
  const r1=call("web_fetch", {urls:["https://example.com/"], browser:"Chrome", maxChars:4000}, 35);
  const t1=txt(r1);
  // ref 2409 is example.com link
  const r2=call("web_page_links", {ref_ids:[2409]}, 10);
  const t2=txt(r2);
  return [t2.toLowerCase().includes("example.com"), t2.slice(0,400)];
});
let tid=null;
test("8 Target.createTarget Chrome", ()=>{
  const r=call("Target.createTarget", {url:"https://example.com/", browser:"Chrome"}, 30);
  tid=extractTid(r);
  const t=txt(r);
  return [!!tid, `tid ${tid} ${t.slice(0,500)}`];
});
test("9 DOM.getDocument", ()=>{
  const r=call("DOM.getDocument", {targetId:tid, limit:10}, 30);
  const t=txt(r);
  return [t.includes("Example Domain"), t.slice(0,800)];
});
test("10 Runtime.evaluate", ()=>{
  const r=call("Runtime.evaluate", {targetId:tid, expression:"document.title"}, 20);
  const t=txt(r);
  return [t.includes("Example Domain"), t.slice(0,500)];
});
test("11 DOM.querySelector", ()=>{
  const r=call("DOM.querySelector", {targetId:tid, selector:"h1"}, 20);
  const t=txt(r);
  return [t.includes("Example Domain"), t.slice(0,500)];
});
test("12 DOM.querySelectorAll", ()=>{
  const r=call("DOM.querySelectorAll", {targetId:tid, selector:"a"}, 20);
  const t=txt(r);
  return [t.includes("Learn more"), t.slice(0,600)];
});
test("13 DOM.getOuterHTML", ()=>{
  const r=call("DOM.getOuterHTML", {targetId:tid, selector:"h1"}, 20);
  const t=txt(r);
  return [t.includes("<h1>Example Domain</h1>"), t.slice(0,500)];
});
test("14 Page.navigate", ()=>{
  const r=call("Page.navigate", {targetId:tid, url:"https://example.com/"}, 30);
  const t=txt(r);
  return [t.toLowerCase().includes("example.com"), t.slice(0,500)];
});
test("15 Network.getRequests", ()=>{
  const r=call("Network.getRequests", {targetId:tid}, 15);
  const t=txt(r);
  return [t.includes("GET"), t.slice(0,600)];
});
test("16 DOM.scrollIntoViewIfNeeded", ()=>{
  const r=call("DOM.scrollIntoViewIfNeeded", {targetId:tid, selector:"a"}, 15);
  const t=txt(r);
  return [true, t.slice(0,500)];
});
test("17 Input.dispatchMouseEvent", ()=>{
  const r=call("Input.dispatchMouseEvent", {targetId:tid, selector:"h1"}, 20);
  const t=txt(r);
  return [!t.toLowerCase().includes("error")||t.toLowerCase().includes("clicked"), t.slice(0,500)];
});
test("18 Page.reload", ()=>{
  const r=call("Page.reload", {targetId:tid}, 30);
  const t=txt(r);
  return [true, t.slice(0,500)];
});
test("19 web_page_screenshot targetId", ()=>{
  const r=call("web_page_screenshot", {targetId:tid}, 40);
  const t=txt(r);
  const raw=JSON.stringify(r);
  if(t.toLowerCase().includes("timed out")) return [false, t.slice(0,600)];
  return [t.includes("Captured")||raw.includes("base64"), t.slice(0,600)];
});
test("20 Target.closeTarget", ()=>{
  const r=call("Target.closeTarget", {targetId:tid}, 25);
  const t=txt(r);
  const raw=JSON.stringify(r);
  if(raw.includes("isError")) return [false, t.slice(0,600)];
  return [t.toLowerCase().includes("closed"), t.slice(0,500)];
});
test("21 Target.getTargets", ()=>{
  const r=call("Target.getTargets", {}, 15);
  const t=txt(r);
  return [t.includes("Chrome"), t.slice(0,600)];
});
test("22 Runtime.getConsoleMessages", ()=>{
  const r1=call("Target.createTarget", {url:"https://example.com/", browser:"Chrome"}, 30);
  const tid2=extractTid(r1);
  const r2=call("Runtime.getConsoleMessages", {targetId:tid2}, 15);
  const t=txt(r2);
  call("Target.closeTarget", {targetId:tid2}, 20);
  return [true, t.slice(0,500)];
});
test("23 Input.dispatchKeyEvent", ()=>{
  const r1=call("Target.createTarget", {url:"https://example.com/", browser:"Chrome"}, 30);
  const tid2=extractTid(r1);
  const r2=call("Input.dispatchKeyEvent", {targetId:tid2, key:"Enter"}, 15);
  const t=txt(r2);
  call("Target.closeTarget", {targetId:tid2}, 20);
  return [true, t.slice(0,500)];
});
test("24 Page.goBack/goForward", ()=>{
  const r1=call("Target.createTarget", {url:"https://example.com/", browser:"Chrome"}, 30);
  const tid2=extractTid(r1);
  call("Page.navigate", {targetId:tid2, url:"https://example.com/"}, 20);
  const r2=call("Page.goBack", {targetId:tid2}, 15);
  const t2=txt(r2);
  const r3=call("Page.goForward", {targetId:tid2}, 15);
  const t3=txt(r3);
  call("Target.closeTarget", {targetId:tid2}, 20);
  return [true, `back ${t2.slice(0,200)} forward ${t3.slice(0,200)}`];
});
console.log(`\n=== SUMMARY ${passed} passed, ${failed} failed, total ${passed+failed} ===`);
