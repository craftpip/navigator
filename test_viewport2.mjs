import { browserCaptureScreenshot } from "./src/search.js";
import { createTarget, captureTargetScreenshot, closeTarget, handleDevtoolsToolCall } from "./src/devtools.js";

async function evalViewport(targetId) {
  const res = await handleDevtoolsToolCall("Runtime.evaluate", { targetId, expression: "({w: window.innerWidth, h: window.innerHeight})" });
  // res is formatted? handleDevtoolsToolCall returns { result } ?
  // Let's try direct: it returns { targetId, result }
  return res.result || res;
}

async function test() {
  console.log("Test 3: captureTargetScreenshot with viewport override and restore");
  try {
    const target = await createTarget({ url: "http://10.69.1.164:1994/console", viewport: { width: 1024, height: 768 } });
    console.log("  created target", target.targetId, "viewport", target.viewport);
    // wait a bit for navigation
    await new Promise(r => setTimeout(r, 2000));
    let vp = await evalViewport(target.targetId);
    console.log("  before override viewport:", vp);
    const r = await captureTargetScreenshot({ targetId: target.targetId, fullPage: false, viewport: { width: 400, height: 300 } });
    console.log("  screenshot with 400x300 captured", r.sizeBytes);
    let vp2 = await evalViewport(target.targetId);
    console.log("  after screenshot (should be restored to 1024x768):", vp2);
    const restored = vp2.w === 1024 && vp2.h === 768;
    console.log("  PASS 3 restored?", restored ? "YES" : "NO");

    console.log("\nTest 4: captureTargetScreenshot fullPage true only width matters");
    vp = await evalViewport(target.targetId);
    console.log("  before fullPage true:", vp);
    const r4 = await captureTargetScreenshot({ targetId: target.targetId, fullPage: true, viewport: { width: 600, height: 900 } });
    console.log("  screenshot fullPage true with 600x900 captured", r4.sizeBytes);
    let vp3 = await evalViewport(target.targetId);
    console.log("  after fullPage true (should be restored):", vp3);
    console.log("  PASS 4 restored?", (vp3.w===1024 && vp3.h===768)?"YES":"NO");

    console.log("\nTest 5: captureTargetScreenshot with viewport 500 width only and fullPage true (height defaults)");
    const r5 = await captureTargetScreenshot({ targetId: target.targetId, fullPage: true, viewport: { width: 500 } });
    console.log("  screenshot with 500 width only captured", r5.sizeBytes);
    let vp4 = await evalViewport(target.targetId);
    console.log("  after width-only (restored):", vp4);
    console.log("  PASS 5 restored?", (vp4.w===1024 && vp4.h===768)?"YES":"NO");

    // Test error case: fullPage false without height should error
    console.log("\nTest 6: viewport missing height when fullPage false should error");
    try {
      await captureTargetScreenshot({ targetId: target.targetId, fullPage: false, viewport: { width: 500 } });
      console.log("  FAIL 6: should have thrown");
    } catch (e) {
      console.log("  PASS 6: threw as expected:", e.message.slice(0,80));
    }

    await closeTarget({ targetId: target.targetId });
    console.log("  closed target");
  } catch (e) { console.error("  FAIL:", e.message, e.stack?.slice(0,600)); }
  process.exit(0);
}
test();
