import path from 'node:path'
import os from 'node:os'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {createServer} from 'vite'
const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(import.meta.url)
const vite=await createServer({root,configFile:path.join(root,'vite.config.js'),server:{port:5173,strictPort:true}});await vite.listen()
try {
 const code=`(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));window.AudioContext=class{constructor(){this.state='suspended';this.destination={}}createAnalyser(){return{fftSize:2048,frequencyBinCount:1024,connect(){},getByteFrequencyData(a){a.fill(0)}}}createMediaElementSource(){return{connect(){},disconnect(){}}}resume(){return new Promise(()=>{})}close(){return Promise.resolve()}};const m=await import('/src/core/audio/engine.js');m.setTrack({url:'http://localhost:5173/demo-audio/dynamic-horizon.ogg',duration:35});m.syncTo(0,true);await wait(2000);const e=m.engine;return {playing:e.playing,ready:e.ready,hasAnalyser:e.hasAnalyser,degraded:e.degraded,error:e.error,time:e.currentTime,zeroBins:m.getFrequencyBins(32).every(x=>x===0)}})()`
 const env={...process.env,MP_DEV:'1',MP_SHOT:'1',MP_SHOT_VIEW:'party',MP_EVAL:code,MP_EVAL_WAIT:'1400',MP_SHOT_OUT:path.join(os.tmpdir(),'mp-audio-hang-diagnostic.png')};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(require('electron'),['.'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);const exit=await new Promise(r=>{const t=setTimeout(()=>{child.kill();r(-1)},15000);child.on('exit',c=>{clearTimeout(t);r(c)})});const m=out.match(/\[eval\] result (.*)/);console.log(JSON.stringify({exit,result:m?JSON.parse(m[1]):null,error:m?null:out.slice(-1200)}));if(exit!==0||!m)process.exitCode=1
}finally{await vite.close()}
