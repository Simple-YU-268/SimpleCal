/** Render the real frontend with isolated, synthetic API responses. No account or user data is read.
 * npm install --prefix "$env:TEMP/simplecal-browser-tools" playwright
 * node code/scripts/capture-ui.mjs [output-directory]
 * Optional SIMPLECAL_PLAYWRIGHT points to playwright's index.mjs; SIMPLECAL_BROWSER selects Chromium.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'simplecal-ui-review'));
const playwrightPath = process.env.SIMPLECAL_PLAYWRIGHT || path.join(os.tmpdir(), 'simplecal-browser-tools/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const browserPath = process.env.SIMPLECAL_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = Number(process.env.SIMPLECAL_CAPTURE_PORT || 5197);
const url = `http://127.0.0.1:${port}`;
await fs.mkdir(out, { recursive: true });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: path.join(root, 'code/web'), stdio: 'pipe', windowsHide: true });
let diagnostics = '';
vite.stdout.on('data', d => { diagnostics += d; });
vite.stderr.on('data', d => { diagnostics += d; });
const calendars = [
  { id: 'default', displayName: '生活与灵感', type: 'vevent', color: '#7EDBD2', order: 0 },
  { id: 'work', displayName: '工作日程', type: 'vevent', color: '#B7D6F7', order: 1 },
  { id: 'family', displayName: '家人与朋友', type: 'vevent', color: '#FFC7DE', order: 2 },
  { id: 'tasks', displayName: '我的任务', type: 'vtodo', color: '#FFD94D', order: 3 },
];
const at = (day, hour=0) => new Date(2026, 10, day, hour).getTime();
const events = [
  ['review','产品设计评审',3,10,1,'work'], ['coffee','和朋友喝杯咖啡',5,15,2,'family'],
  ['read','阅读 · 留一点时间给自己',8,10,1,'default'], ['walk','周末去公园',14,9,2,'default'],
  ['plan','十二月计划',19,14,1,'work'], ['dinner','家人的晚餐',21,18,2,'family'],
  ['ideas','灵感整理',25,10,1,'default'], ['check','项目复盘',27,14,2,'work'],
].map(([id,title,day,hour,hours,calendarId]) => ({ id,title,start:at(day,hour),end:at(day,hour)+hours*3600000,calendarId,allDay:false,reminders:[],updatedAt:1 }));
events.push({ id:'trip', title:'杭州小旅行', start:at(10),end:at(13),calendarId:'default',allDay:true,reminders:[],updatedAt:1 });
const tasks = [
 ['task-1','整理这周的设计灵感',3,false], ['task-2','预约年度体检',5,false],
 ['task-3','给家人选一份礼物',8,false], ['task-4','完成新项目计划',6,false], ['task-5','读完一本喜欢的书',2,true],
].map(([id,title,day,done]) => ({ id,title,due:at(day,17),allDay:false,done,calendarId:'tasks',isTask:true,reminders:[],updatedAt:1 }));
let browser;
const reports=[];
try {
  for (let i=0;i<100;i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${diagnostics}`);
    await new Promise(r=>setTimeout(r,100));
    if (i===99) throw new Error(`Vite did not start: ${diagnostics}`);
  }
  browser = await chromium.launch({ executablePath: browserPath, headless:true });
  async function scene(name, { width=1440,height=1000,theme='light',signedIn=true,reducedMotion='no-preference' }={}) {
    const context = await browser.newContext({ viewport:{width,height}, deviceScaleFactor:1, locale:'zh-CN',timezoneId:'Asia/Shanghai',colorScheme:theme,reducedMotion });
    const page=await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-02T02:00:00Z'));
    const errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    const values = new Map([
      ['cal:settings',{ defaultView:'month',theme,accentColor:'#3b54c4',weekStartsOn:1,holidaysEnabled:true,eventColorMode:'calendar' }],
      ...events.map(e=>[`cal:${e.calendarId}:evt:${e.id}`,e]),
      ...tasks.map(t=>[`cal:tasks:task:${t.id}`,t]),
    ]);
    await page.route('**/api/**',async route=>{
      const u=new URL(route.request().url());
      let status=200,body={ok:true};
      if(u.pathname.endsWith('/auth/session')) { status=signedIn?200:401;body=signedIn?{uid:'visual-fixture',username:'SimpleCal',displayName:'小晴',csrf:'visual-fixture'}:{code:'no_credentials'}; }
      else if(u.pathname.endsWith('/me')) body={uid:'visual-fixture',username:'SimpleCal',displayName:'小晴',role:'user'};
      else if(u.pathname.endsWith('/calendars')) body={calendars};
      else if(u.pathname.endsWith('/server-info')) body={name:'SimpleCal',capabilities:{}};
      else if(u.pathname.endsWith('/kv')) { const prefix=u.searchParams.get('prefix')||'';body=[...values].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value})); }
      else if(u.pathname.includes('/kv/')) { const key=decodeURIComponent(u.pathname.split('/kv/')[1]);body=values.get(key)??null; }
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(url,{waitUntil:'networkidle'});
    await page.locator(signedIn?'.app':'.auth-card').waitFor();
    await page.screenshot({path:path.join(out,`${name}.png`)});
    const metrics=await page.evaluate(()=>({ scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,taskRows:document.querySelectorAll('.task-row').length,events:document.querySelectorAll('.chip').length,taskbarVisible:!!document.querySelector('.app.has-taskbar'),headerTitleWidth:document.querySelector('.header__title')?.getBoundingClientRect().width,headerTitleOccluded:(()=>{const title=document.querySelector('.header__title')?.getBoundingClientRect();return !!title && ['.header__search','.header__tools'].some(selector=>{const r=document.querySelector(selector)?.getBoundingClientRect();return r?.width>0 && r.height>0 && r.left<title.right-1 && r.right>title.left+1 && r.top<title.bottom && r.bottom>title.top;});})(),headerTitleScrollWidth:document.querySelector('.header__title')?.scrollWidth,text:document.body.innerText.slice(0,300) }));
    reports.push({name,errors,...metrics});
    if(name==='desktop' || name==='reduced-motion') {
      const target=page.locator('.task-row__main').first();
      if(await target.count()) {
        await target.click();
        await page.waitForTimeout(450);
        await page.screenshot({path:path.join(out,`${name}-task-detail.png`)});
        reports.push({name:`${name}-task-detail`,reducedMotion,runningAnimations:await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length),dialog:await page.locator('.modal').count(),heading:await page.locator('.modal').innerText().catch(()=>''),errors});
        await page.keyboard.press('Escape');
        await page.waitForTimeout(220);
        reports.push({name:`${name}-task-close`,dialog:await page.locator('.modal').count(),focusRestored:await page.evaluate(()=>document.activeElement?.classList.contains('task-row__main')),taskbarVisible:await page.locator('.taskbar').isVisible()});
        if(!await page.locator('.taskbar').isVisible()) await page.locator('.taskbar-toggle').click();
        await target.click();
        await page.waitForTimeout(420);
        await page.locator('.modal__head button').first().click();
        await page.waitForTimeout(420);
        await page.screenshot({path:path.join(out,`${name}-task-editor.png`)});
        reports.push({name:`${name}-task-editor`,inputs:await page.locator('.modal input').count(),errors});
      }
    }
    if(name==='mobile') {
      const taskToggle=page.locator('.taskbar-toggle');
      if(await taskToggle.count()) {
        await taskToggle.click();
        await page.waitForTimeout(300);
        await page.screenshot({path:path.join(out,'mobile-tasks.png')});
        reports.push({name:'mobile-tasks',visible:await page.locator('.taskbar').isVisible(),rows:await page.locator('.task-row').count(),headingTopmost:await page.locator('.taskbar__title').evaluate(node=>{const r=node.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return node===hit || node.contains(hit);}),errors});
      }
    }
    await context.close();
  }
  await scene('desktop');
  await scene('mobile',{width:390,height:844});
  await scene('small-phone',{width:320,height:740});
  await scene('tablet',{width:768,height:1024});
  await scene('small-desktop',{width:1024,height:768});
  await scene('reduced-motion',{reducedMotion:'reduce'});
  await scene('dark',{theme:'dark'});
  await scene('login',{signedIn:false});
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(reports,null,2));
  const failures=[];
  for(const report of reports) {
    if(report.errors?.length) failures.push(`${report.name}: browser errors ${report.errors.join('; ')}`);
    if(report.viewport && report.scrollWidth>report.viewport) failures.push(`${report.name}: horizontal overflow`);
    if(report.headerTitleWidth!==undefined && report.headerTitleWidth<80) failures.push(`${report.name}: month label collapsed (${report.headerTitleWidth}px)`);
    if(report.headerTitleOccluded) failures.push(report.name+': month label occluded by another header control');
    if(report.name.endsWith('-task-close') && (report.dialog!==0 || !report.focusRestored || !report.taskbarVisible)) failures.push(`${report.name}: Escape failed dialog/focus/taskbar invariant`);
    if(report.reducedMotion==='reduce' && report.runningAnimations>0) failures.push(`${report.name}: running animation despite reduced motion`);
    if(report.name.endsWith('-task-editor') && !report.inputs) failures.push(`${report.name}: task editor did not open`);
    if(report.name==='mobile-tasks' && (!report.visible || !report.headingTopmost || report.rows!==tasks.length)) failures.push('mobile task drawer failed');
  }
  console.log(JSON.stringify({output:out,reports,failures},null,2));
  if(failures.length) throw new Error(failures.join('\n'));
} finally { await browser?.close(); vite.kill(); }
