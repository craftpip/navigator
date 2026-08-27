import fs from "fs";
import { PNG } from "pngjs";
let p1 = PNG.sync.read(fs.readFileSync("/tmp/leaderboard-original.png"));
let p2 = PNG.sync.read(fs.readFileSync("/tmp/leaderboard-svg.png"));
let total=p1.width*p1.height;
let diff=0, white1=0, white2=0, nonwhiteDiff=0;
for(let i=0;i<total;i++){
  let o=i*4;
  let r1=p1.data[o], g1=p1.data[o+1], b1=p1.data[o+2];
  let r2=p2.data[o], g2=p2.data[o+1], b2=p2.data[o+2];
  let w1=r1>245 && g1>245 && b1>245;
  let w2=r2>245 && g2>245 && b2>245;
  if(w1) white1++; if(w2) white2++;
  if(Math.abs(r1-r2)>15 || Math.abs(g1-g2)>15 || Math.abs(b1-b2)>15) diff++;
  if(!w1 && w2) nonwhiteDiff++; // orig has content but svg white
}
console.log("white1", (white1/total*100).toFixed(1), "white2", (white2/total*100).toFixed(1), "diff", (diff/total*100).toFixed(1), "missingContent", (nonwhiteDiff/total*100).toFixed(1), "nonwhiteDiff", nonwhiteDiff);
