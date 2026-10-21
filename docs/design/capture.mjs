import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, stat, writeFile, access } from 'node:fs/promises';
import assert from 'node:assert/strict';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const require=createRequire(path.join(repo,'app/package.json'));
const {chromium}=require('@playwright/test');
const onlyCheck=process.argv.includes('--check');
const outArg=process.argv.find(a=>a.startsWith('--out='));
const out=outArg?path.resolve(outArg.slice(6)):path.join(here,'shots');
const pages=JSON.parse(await readFile(path.join(here,'pages.json'),'utf8'));
let executablePath=process.env.DESIGN_CHROME_PATH;
if(!executablePath){
 try{await access(chromium.executablePath());}
 catch{executablePath='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';await access(executablePath);}
}
const browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking','--disable-component-update','--no-default-browser-check']});
const context=await browser.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:1,reducedMotion:'reduce',colorScheme:'light'});
const page=await context.newPage();
const errors=[];const externalRequests=[];const failedRequests=[];
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
page.on('pageerror',e=>errors.push(String(e)));
page.on('requestfailed',r=>failedRequests.push({url:r.url(),error:r.failure()?.errorText}));
await page.route('**/*',async route=>{const url=route.request().url();if(!url.startsWith('file:')&&!url.startsWith('data:')){externalRequests.push(url);await route.abort();}else await route.continue();});
try{
 await page.goto(pathToFileURL(path.join(here,'index.html')).href,{waitUntil:'load'});
 await page.evaluate(()=>document.fonts.ready);
 await page.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(i=>i.decode())));
 const count=await page.locator('.screen').count();assert.equal(count,35);
 assert.equal(await page.locator('.specimen').count(),pages.length);
 const dimensions=await page.locator('.screen').evaluateAll(nodes=>nodes.map(n=>({id:n.closest('[data-page]').dataset.page,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
 dimensions.forEach(d=>{assert.equal(d.width,390,d.id);assert.equal(d.height,844,d.id);});
 const broken=await page.locator('img').evaluateAll(nodes=>nodes.filter(n=>!n.complete||!n.naturalWidth).map(n=>n.src));assert.deepEqual(broken,[]);
 const horizontalOverflow=await page.locator('.screen').evaluateAll(nodes=>nodes.filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>({id:n.closest('[data-page]').dataset.page,scroll:n.scrollWidth,client:n.clientWidth})));assert.deepEqual(horizontalOverflow,[]);
 const shortButtons=await page.locator('.screen button').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().height<44).map(n=>n.textContent));assert.deepEqual(shortButtons,[],'Button touch height');
 const takeover=page.locator('#auto .phone-footer').getByRole('button',{name:'我来接手',exact:true});
 assert.equal(await takeover.count(),1,'Auto takeover must be in persistent footer');
 const versionBarVisible=await page.locator('#viewer .versions').evaluate(n=>{const b=n.getBoundingClientRect(),p=n.closest('.screen-body').getBoundingClientRect();return b.top>=p.top&&b.bottom<=p.bottom;});assert(versionBarVisible,'Viewer version bar must fit initial viewport');
 const visibleText=await page.locator('.screen').allTextContents();assert(!/[¥元]|费用|花费|价格/.test(visibleText.join('')));
 const before=await page.locator('#script .screen').evaluate(n=>getComputedStyle(n).backgroundColor);
 await page.getByRole('button',{name:'全部深色',exact:true}).click();
 const after=await page.locator('#script .screen').evaluate(n=>getComputedStyle(n).backgroundColor);
 assert.notEqual(before,after);assert.equal(await page.locator('#script .screen').getAttribute('data-theme'),'studio');
 await page.getByRole('button',{name:'全部浅色',exact:true}).click();
 assert.equal(await page.locator('#home .screen').getAttribute('data-theme'),'paper');
 assert.equal(await page.locator('#viewer .screen').getAttribute('data-theme'),'studio');
 await page.getByRole('button',{name:'按场景',exact:true}).click();
 assert.equal(await page.locator('#home .screen').getAttribute('data-theme'),'studio');
 assert.equal(await page.locator('#script .screen').getAttribute('data-theme'),'paper');
 const tokens=await page.locator('#script .screen').evaluate(n=>{
  const c=getComputedStyle(n);const val=k=>c.getPropertyValue(k).trim();
  return {brand:val('--color-brand-primary'),page:val('--color-bg-page'),touch:val('--layout-touch'),ratio:val('--layout-thumbnail-ratio')};
 });assert.equal(tokens.brand,'#FF2442');assert.equal(tokens.touch,'44px');
 // Verify primary and secondary text on the two themes numerically.
 const contrast=await page.evaluate(()=>{
  function rgb(s){const nums=s.match(/[\d.]+/g).slice(0,3).map(Number);return nums.map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0);}
  const result=[];
  for(const id of ['home','script']){
   const n=document.querySelector(`#${id} .screen`),s=getComputedStyle(n),bg=rgb(s.backgroundColor);
   const text=rgb(s.color),muted=document.createElement('span');muted.className='muted';n.append(muted);const m=rgb(getComputedStyle(muted).color);muted.remove();
   const ratio=(a,b)=>(Math.max(a,b)+.05)/(Math.min(a,b)+.05);result.push({id,primary:+ratio(text,bg).toFixed(2),secondary:+ratio(m,bg).toFixed(2)});
  }
  return result;
 });contrast.forEach(c=>{assert(c.primary>=4.5);assert(c.secondary>=4.5);});
 const assetStats=[];
 for(let i=1;i<=10;i++){const name=`studio-${String(i).padStart(2,'0')}.jpg`;const s=await stat(path.join(here,'assets',name));assert(s.size<=200000);assert(await page.locator(`img[src="assets/${name}"]`).count()>0,`${name} must be used`);assetStats.push({name,bytes:s.size});}
 if(!onlyCheck){
  await mkdir(out,{recursive:true});
  for(const [i,p] of pages.entries()){
   const specimen=page.locator(`[data-page="${p.id}"]`);
   await specimen.scrollIntoViewIfNeeded();
   await specimen.screenshot({path:path.join(out,`${String(i+1).padStart(2,'0')}-${p.id}.png`),animations:'disabled'});
  }
  // Alternate theme proofs and full scroll contents for long forms.
  await page.getByRole('button',{name:'全部深色',exact:true}).click();
  await page.locator('#script').screenshot({path:path.join(out,'theme-studio.png'),animations:'disabled'});
  await page.getByRole('button',{name:'全部浅色',exact:true}).click();
  await page.locator('#home').screenshot({path:path.join(out,'theme-paper.png'),animations:'disabled'});
  await page.getByRole('button',{name:'按场景',exact:true}).click();
  for(const id of ['home','new-auto','note']){
   const content=page.locator(`#${id} .screen-body`);await content.evaluate(n=>n.scrollTop=n.scrollHeight);
   await page.locator(`#${id}`).screenshot({path:path.join(out,`${id}-continued.png`),animations:'disabled'});
   await content.evaluate(n=>n.scrollTop=0);
  }
 }
 await page.setViewportSize({width:720,height:1000});
 assert.equal(await page.locator('.screen').first().evaluate(n=>n.getBoundingClientRect().width),390);
 await page.setViewportSize({width:390,height:844});
 const boardOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(boardOverflow,false,'390px board overflow');
 await page.setViewportSize({width:1440,height:1100});
 // All anchor targets must exist and be unique.
 const badAnchors=await page.locator('a[href^="#"]').evaluateAll(nodes=>nodes.filter(n=>document.querySelectorAll(n.getAttribute('href')).length!==1).map(n=>n.getAttribute('href')));assert.deepEqual(badAnchors,[]);
 assert.deepEqual(errors,[],'Browser console');assert.deepEqual(externalRequests,[],'External requests');assert.deepEqual(failedRequests,[],'Failed local requests');
 const report={result:'passed',entry:'file://docs/design/index.html',browser:executablePath?'installed Chrome':'Playwright bundled Chromium',screenCount:count,screenSize:'390x844',consoleErrors:errors,externalRequests,failedRequests,brokenImages:broken,horizontalOverflow,shortButtons,persistentAutoTakeover:true,initialVersionBarVisible:versionBarVisible,themeSwitch:'paper / studio / scene defaults passed; viewer remains studio',responsiveWidths:[390,720,1440],contrast,assets:assetStats,screenshots:onlyCheck?0:40};
 if(!onlyCheck)await writeFile(path.join(here,'verification.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
