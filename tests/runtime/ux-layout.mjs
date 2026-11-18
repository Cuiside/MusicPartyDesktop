import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(import.meta.url)
const vite=await createServer({root,configFile:path.join(root,'vite.config.js'),server:{port:5173,strictPort:true}})
await vite.listen()
try {
 for(const width of [1440,1024]) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mp-ux-layout-'))
  const code=`(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));const find=(selector,text)=>[...document.querySelectorAll(selector)].find(e=>e.textContent.includes(text));
   document.querySelector('#onb-clear-data').click();await wait(100);const clearWarning=document.querySelector('.confirm-dialog,.dialog')?.textContent||document.body.innerText;const clearConfirm=clearWarning.includes('清除所有本地数据')&&clearWarning.includes('密码');
   const cancel=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='取消');cancel?.click();await wait(100);
   localStorage.setItem('mp.desktop.settings','fixture');localStorage.setItem('mp.desktop.recovery-key','fixture');await window.mpDesktop.launcher.setSecrets({adminPassword:'fixture-admin-password-12345',neteaseCookie:'MUSIC_U=fixture'});await window.mpDesktop.window.setClosePreference('tray');
   const cleared=await window.mpDesktop.launcher.clearLocalData();const cfg=await window.mpDesktop.launcher.getConfig();const data={ok:cleared.ok,localStorageEmpty:localStorage.length===0,secretCleared:!cfg.adminPasswordSet&&!cfg.neteaseCookieSet,closePref:await window.mpDesktop.window.getClosePreference()};
   document.querySelector('#onb-demo').click();await wait(1300);const demoAudio={playing:window.__mp.engine.playing,ready:window.__mp.engine.ready,advanced:window.__mp.engine.currentTime>0.2,error:window.__mp.engine.error};document.querySelector('[title="管理员登录"]').click();await wait(200);
   const input=document.querySelector('#admin-auth-password'),eye=document.querySelector('.admin-auth-eye');input.focus();const a=input.getBoundingClientRect(),b=eye.getBoundingClientRect();const admin={overlap:Math.max(0,a.right-b.left),outline:getComputedStyle(input).outlineOffset};document.querySelector('.admin-auth-close').click();await wait(150);
   window.__mp.live.joined=true;window.__mp.live.connected=true;find('.nav-item','搜索').click();await wait(450);const platform=document.querySelector('.search-trending .chip-link.active');const selected=platform?{color:getComputedStyle(platform).color,background:getComputedStyle(platform).backgroundColor}:null;
   window.__mp.live.joined=false;find('.nav-item','派对').click();await wait(350);find('.side-item','即时聊天').click();await wait(250);const chatVisible=!!document.querySelector('.instant-chat');
   return {clearConfirm,data,demoAudio,admin,selected,chatVisible,overflow:document.documentElement.scrollWidth>innerWidth};})()`
  const env={...process.env,MP_DEV:'1',MP_SHOT:'1',MP_SHOT_VIEW:'party',MP_SHOT_EXTRA:'welcome=1',MP_SHOT_W:String(width),MP_SHOT_H:'768',MP_EVAL:code,MP_EVAL_WAIT:'1400',MP_SHOT_OUT:path.join(tmp,'layout.png')};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(require('electron'),['.'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
  const exit=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve(-1)},30000);child.on('exit',code=>{clearTimeout(timer);resolve(code)})})
  const match=output.match(/\[eval\] result (.*)/);const result=match?JSON.parse(match[1]):{error:output.slice(-1500)}
  const passed=exit===0&&result.clearConfirm&&result.data?.ok&&result.data?.localStorageEmpty&&result.data?.secretCleared&&result.data?.closePref==='ask'&&result.demoAudio?.playing&&result.demoAudio?.ready&&result.demoAudio?.advanced&&!result.demoAudio?.error&&result.admin?.overlap<=0&&result.selected?.color==='rgb(255, 205, 56)'&&result.chatVisible&&!result.overflow
  console.log(JSON.stringify({width,passed,result,screenshot:path.join(tmp,'layout.png')}));if(!passed)process.exitCode=1
 }
}finally{await vite.close()}
