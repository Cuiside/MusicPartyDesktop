import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(import.meta.url)
const vite=await createServer({root,configFile:path.join(root,'vite.config.js'),server:{port:5173,strictPort:true}});await vite.listen()
try {
 const code=`(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));const {tray}=await import('/src/core/tray-bridge.js');tray.title='测试歌曲';tray.coverUrl='http://127.0.0.1:1/invalid.png';await wait(500);const failed=!!document.querySelector('.tc-vinyl');tray.coverUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXokAAAAASUVORK5CYII=';await wait(500);const img=document.querySelector('.tc-cover img');return {failed,recovered:!!img&&img.complete&&img.naturalWidth>0,title:document.querySelector('.tc-title')?.textContent}})()`
 const env={...process.env,MP_DEV:'1',MP_SHOT:'1',MP_SHOT_EXTRA:'tray=1',MP_EVAL:code,MP_EVAL_WAIT:'1300',MP_SHOT_OUT:path.join(os.tmpdir(),'mp-tray-cover.png')};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(require('electron'),['.'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
 const exit=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve(-1)},20000);child.on('exit',code=>{clearTimeout(timer);resolve(code)})});const match=output.match(/\[eval\] result (.*)/);const result=match?JSON.parse(match[1]):{error:output.slice(-1500)};const passed=exit===0&&result.failed&&result.recovered;console.log(JSON.stringify({passed,result}));if(!passed)process.exitCode=1
}finally{await vite.close()}
