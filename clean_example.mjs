import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:1994/browser/Chrome');
let id=1;
function send(m,p){return new Promise((res,rej)=>{const cur=id++;const h=d=>{try{const j=JSON.parse(d.toString());if(j.id===cur){ws.off('message',h);j.error?rej(j.error):res(j)}}catch{}};ws.on('message',h);ws.send(JSON.stringify({id:cur,method:m,params:p}));setTimeout(()=>{ws.off('message',h);rej(new Error('timeout '+m))},8000)})}
ws.on('open', async ()=>{
  try{
    const r=await send('Target.getTargets',{});
    const infos=r.result.targetInfos||[];
    const ex=infos.filter(t=>t.url==='https://example.com/');
    console.log('found',ex.length);
    for(const t of ex){
      console.log('close',t.targetId, t.url);
      const rc=await send('Target.closeTarget',{targetId:t.targetId});
      console.log('close res',JSON.stringify(rc).slice(0,200));
      await new Promise(r=>setTimeout(r,200));
    }
    ws.close();
  }catch(e){console.error(e); ws.close();}
});
