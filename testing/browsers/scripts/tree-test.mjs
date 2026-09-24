import WebSocket from "/www1/navigator/node_modules/ws/index.js";
const H = "ws://127.0.0.1:9226/session";
let ws, msgId = 0; const pending = new Map();
function send(method, params){return new Promise((res,rej)=>{const id=++msgId;pending.set(id,{res,rej});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);rej(new Error("timeout "+method));}},8000);});}
ws = new WebSocket(H);
ws.on("message",(d)=>{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.rej(new Error(m.error.code+": "+m.error.message)):p.res(m.result);}});
await new Promise((r,j)=>{ws.on("open",r);ws.on("error",j);});
console.log("connected");
const s = await send("session.new",{capabilities:{}});
console.log("session", s.sessionId);
const tree = await send("browsingContext.getTree",{});
console.log("TREE:", JSON.stringify(tree,null,2));
// try to navigate context just created to popup via about:blank? not needed.
try{await send("session.end",{});}catch(e){}
ws.close();process.exit(0);