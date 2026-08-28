import WebSocket from 'ws';
const wsUrl = 'ws://localhost:1994/browser/Chrome';
const ws = new WebSocket(wsUrl);
let id=1;
function send(method, params={}, sessionId=null){
  const msg={id:id++, method, params};
  if(sessionId) msg.sessionId=sessionId;
  return new Promise((res,rej)=>{
    const cur=id-1;
    const handler=(data)=>{
      try{
        const j=JSON.parse(data.toString());
        if(j.id===cur){ ws.off('message',handler); if(j.error) rej(j.error); else res(j); }
      }catch{}
    };
    ws.on('message',handler);
    ws.send(JSON.stringify(msg));
    setTimeout(()=>{ ws.off('message',handler); rej(new Error('timeout '+method)); }, 8000);
  });
}
ws.on('open', async ()=>{
  console.log('open at', Date.now());
  try{
    const r2 = await send('Target.createTarget', {url:'https://example.com/'});
    console.log('create', JSON.stringify(r2).slice(0,600));
    const tid=r2.result?.targetId;
    console.log('tid',tid);
    await new Promise(r=>setTimeout(r,1500));
    const r3=await send('Target.attachToTarget',{targetId:tid, flatten:true});
    console.log('attach',JSON.stringify(r3).slice(0,600));
    const sid=r3.result?.sessionId;
    console.log('sid',sid);
    const r4=await send('Page.enable',{},sid);
    console.log('page enable',JSON.stringify(r4).slice(0,300));
    await new Promise(r=>setTimeout(r,1000));
    console.log('capture try at', Date.now());
    const r5=await send('Page.captureScreenshot',{format:'jpeg',quality:75},sid);
    console.log('capture ok at', Date.now(), 'len',JSON.stringify(r5).length);
    const r6=await send('Target.closeTarget',{targetId:tid});
    console.log('closed',JSON.stringify(r6).slice(0,200));
    ws.close();
    process.exit(0);
  }catch(e){console.error('ERR at',Date.now(),e); ws.close(); setTimeout(()=>process.exit(1),500);}
});
ws.on('error', e=>console.error('ws err',e));
setTimeout(()=>{console.log('overall timeout'); process.exit(1)}, 25000);
