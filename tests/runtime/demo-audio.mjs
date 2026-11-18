import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(import.meta.url)
const clips=fs.readdirSync(path.join(root,'public/demo-audio')).filter(x=>/\.ogg$/.test(x))
if(clips.length!==5)throw Error('Expected five licensed demo tracks')
const packaged=process.argv.includes('--packaged')
const vite=packaged?null:await createServer({root,configFile:path.join(root,'vite.config.js'),server:{port:5173,strictPort:true}});if(vite)await vite.listen()
try {
 const action=packaged ? `document.querySelector('[title=下一首]').click()` : `const audio=await import('/src/core/audio/engine.js');audio.seek(e.duration-1)`
 const code=`(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));document.querySelector('#onb-demo').click();await wait(1600);const e=window.__mp.engine;const first={playing:e.playing,time:e.currentTime,url:e.track?.url,duration:e.duration};${action};await wait(2500);const next={playing:e.playing,url:e.track?.url,time:e.currentTime};return {first,next,transitioned:first.url!==next.url}})()`
 const env={...process.env,MP_DEV:'1',MP_SHOT:'1',MP_SHOT_VIEW:'party',MP_SHOT_EXTRA:'welcome=1',MP_EVAL:code,MP_EVAL_WAIT:'1300',MP_SHOT_OUT:path.join(os.tmpdir(),'mp-demo-audio.png')};delete env.ELECTRON_RUN_AS_NODE
 if(packaged)delete env.MP_DEV
 const executable=packaged?path.join(root,'release-rollout/local-server/win-unpacked/Music Party.exe'):require('electron')
 const child=spawn(executable,packaged?[]:['.'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
 const exit=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve(-1)},25000);child.on('exit',code=>{clearTimeout(timer);resolve(code)})})
 const match=output.match(/\[eval\] result (.*)/);const result=match?JSON.parse(match[1]):{error:output.slice(-1000)}
 const pass=exit===0&&result.first?.playing&&result.first?.time>0.2&&result.transitioned&&result.next?.playing
 console.log(JSON.stringify({pass,result,clipCount:clips.length}));if(!pass)process.exitCode=1
}finally{if(vite)await vite.close()}
