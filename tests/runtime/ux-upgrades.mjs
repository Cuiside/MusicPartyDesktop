import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ux-test-'))
const vite = await createServer({ root, configFile: path.join(root, 'vite.config.js'), server: { port: 5173, strictPort: true } })
await vite.listen()
try {
  const code = `(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));const waitFor=async fn=>{for(let i=0;i<80;i++){if(fn())return;await wait(50)}throw Error('Timed out waiting for UI')};
    const clickText=(selector,text)=>{const node=[...document.querySelectorAll(selector)].find(e=>e.textContent.includes(text));if(!node)throw Error('Missing '+text);node.click();return node};
    const setInput=(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))};
    const titleBefore=document.querySelector('.command-title')?.textContent||document.body.innerText;
    document.querySelector('.titlebar-placeholder')?.click();await waitFor(()=>document.querySelector('.palette-input input'));
    const input=document.querySelector('.palette-input input');setInput(input,'Dynamic');await waitFor(()=>document.querySelectorAll('.palette-song').length>1);
    const searchCount=document.querySelectorAll('.palette-song').length;
    const imeBefore=window.__mp.ui.filteredQueueCount();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));await wait(100);const imeSafe=window.__mp.ui.filteredQueueCount()===imeBefore&&!!document.querySelector('.palette');input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));await waitFor(()=>document.querySelector('.palette-song button'));
    const beforeQueue=window.__mp.ui.filteredQueueCount();document.querySelector('.palette-song button').click();await wait(200);
    const afterQueue=window.__mp.ui.filteredQueueCount();clickText('.palette-sources button','Bilibili');await wait(80);await waitFor(()=>document.querySelectorAll('.palette-song').length===1);
    const bilibili=[...document.querySelectorAll('.palette-song-meta b')].map(e=>e.textContent);
    setInput(input,'/settings');await wait(80);const command=document.querySelector('.palette-item')?.textContent||'';
    const beforeCommand=window.__mp.ui.filteredQueueCount();setInput(input,'/不存在');await wait(350);const chineseSearch=!document.querySelector('.palette-item');setInput(input,'/settings');await wait(60);
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(250);
    clickText('.side-item','即时聊天');await waitFor(()=>document.querySelector('.instant-chat'));
    const defaultSystem=document.querySelector('.instant-system')?.textContent||'';const card=!document.querySelector('.instant-song-body');const composer=document.querySelector('.instant-compose input');setInput(composer,'Hello fixture');composer.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(100);
    const sent=document.querySelector('.instant-chat-scroll').textContent.includes('Hello fixture');document.querySelector('.instant-toggle input').click();await wait(50);const toggled=!!document.querySelector('.instant-toggle input:checked');
    const play=document.querySelector('.transport-play');const original=window.__mp.playback.playing,mutedBefore=window.__mp.playback.muted;play.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0}));await wait(170);const during=!!document.querySelector('.hold-ring-progress.filling');play.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0}));play.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));await wait(20);const reversed=!document.querySelector('.hold-ring-progress.filling')&&window.__mp.playback.muted===mutedBefore;
    play.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0}));await wait(580);const toggledRoom=window.__mp.playback.playing!==original;play.dispatchEvent(new PointerEvent('pointerleave',{bubbles:true,pointerType:'mouse'}));play.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0}));play.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));const longLeaveSafe=window.__mp.playback.muted===mutedBefore;play.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0}));await wait(170);play.dispatchEvent(new PointerEvent('pointerleave',{bubbles:true,pointerType:'mouse'}));play.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0}));const keyboardAfterCancel=window.__mp.playback.muted!==mutedBefore;
    window.__mp.closePrompt.request(true,123);await wait(1200);const closeCount=document.querySelectorAll('.close-dialog').length;const remember=!!document.querySelector('.close-remember input');window.__mp.closePrompt.respond('cancel');
    await window.mpDesktop.window.setClosePreference('tray');const saved=await window.mpDesktop.window.getClosePreference();await window.mpDesktop.window.setClosePreference('ask');
    return {searchCount,imeSafe,afterQueue,beforeQueue,bilibili: bilibili.length,command,chineseSearch,beforeCommand,defaultSystem,card,sent,toggled,during,reversed,toggledRoom,longLeaveSafe,keyboardAfterCancel,closeCount,remember,saved,partyStillVisible:!!document.querySelector('.hero')};
  })()`
  const env={...process.env,MP_DEV:'1',MP_SHOT:'1',MP_SHOT_VIEW:'party',MP_EVAL:code,MP_EVAL_WAIT:'1500',MP_SHOT_OUT:path.join(tmp,'ux.png')};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(require('electron'),['.'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output=''
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
  const exit=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve(-1)},45000);child.on('exit',code=>{clearTimeout(timer);resolve(code)})})
  const match=output.match(/\[eval\] result (.*)/);const result=match?JSON.parse(match[1]):{error:output.slice(-1500)}
  const passed=exit===0&&result.searchCount>1&&result.imeSafe&&result.afterQueue===result.beforeQueue+1&&result.bilibili>0&&result.command.includes('/settings')&&result.chineseSearch&&result.card&&result.sent&&result.toggled&&result.during&&result.reversed&&result.toggledRoom&&result.longLeaveSafe&&result.keyboardAfterCancel&&result.closeCount===1&&result.remember&&result.saved==='tray'&&result.partyStillVisible
  console.log(JSON.stringify({passed,result,screenshot:path.join(tmp,'ux.png')}));if(!passed)process.exitCode=1
} finally { await vite.close() }
