import puppeteer from 'puppeteer-core';
const wsUrl = 'ws://localhost:1994/browser/Chrome';
console.log('connect start', Date.now());
const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: {width:1280, height:800} });
console.log('connected', Date.now());
const page = await browser.newPage();
console.log('newPage', Date.now(), page.url());
await page.goto('https://example.com/', {waitUntil:'domcontentloaded', timeout:15000});
console.log('goto', Date.now(), await page.title());
console.log('capture try', Date.now());
try{
  const buf = await page.screenshot({type:'jpeg', quality:75, fullPage:true});
  console.log('screenshot ok len', buf.length, Date.now());
}catch(e){ console.error('screenshot err', e.message, e.stack?.slice(0,600), Date.now()); }
try{ await page.close(); console.log('close ok', Date.now()); }catch(e){ console.error('close err', e.message, Date.now()); }
browser.disconnect();
console.log('done', Date.now());
