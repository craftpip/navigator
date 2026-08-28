import puppeteer from 'puppeteer-core';
for(const url of ['ws://localhost:1994/browser/Chrome', 'ws://10.69.1.164:1994/browser/Chrome']){
  console.log('try', url);
  try{
    const browser = await puppeteer.connect({browserWSEndpoint:url, defaultViewport:{width:1280,height:800}});
    console.log('connected', url);
    const page = await browser.newPage();
    console.log('newPage', url, page.url());
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded', timeout:10000});
    console.log('goto', url, await page.title());
    await page.close();
    console.log('close ok', url);
    browser.disconnect();
  }catch(e){ console.error('fail', url, e.message); }
}
