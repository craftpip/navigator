import fs from "fs";
import { createRequire } from "module";
const orig = fs.readFileSync("/tmp/leaderboard-original.png");
const svg = fs.readFileSync("/tmp/leaderboard-svg.png");
console.log("orig", orig.length, "svg", svg.length);
// Use canvas to decode? we can use pngjs if available
try {
  const { PNG } = await import("pngjs");
  let p1 = PNG.sync.read(orig);
  let p2 = PNG.sync.read(svg);
  console.log("dims orig", p1.width, p1.height, "svg", p2.width, p2.height);
  let diff=0, total=p1.width*p1.height;
  for(let i=0;i<total*4;i+=4){
    let r1=p1.data[i], g1=p1.data[i+1], b1=p1.data[i+2];
    let r2=p2.data[i], g2=p2.data[i+1], b2=p2.data[i+2];
    if(Math.abs(r1-r2)>10 || Math.abs(g1-g2)>10 || Math.abs(b1-b2)>10) diff++;
  }
  console.log("pixel diff", diff, "/", total, (diff/total*100).toFixed(1)+"%");
} catch(e){ console.log("pngjs not", e.message);
  // fallback: just compare file sizes
}
