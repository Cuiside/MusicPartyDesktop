'use strict'
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const base=process.env.MP_TEST_BASE,password=process.env.MP_TEST_ROOM_PASSWORD;
if(!base||!password)throw Error('Provide MP_TEST_BASE and MP_TEST_ROOM_PASSWORD');
const variant=process.argv[2]||'remote';
const requireAudio=process.argv.includes('--audio');
const exe=path.resolve('release-rollout',variant,'win-unpacked/Music Party.exe');
const code=`(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<60&&!window.__mp;i++)await sleep(100);
document.querySelector('#onb-tab-join')?.click();await sleep(100);if(!document.querySelector('#onb-join-server'))document.querySelector('.onb-server-row')?.click();await sleep(100);
const set=(id,value)=>{const el=document.querySelector(id);if(!el)throw Error('Missing '+id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
set('#onb-nickname','游客发布验收');set('#onb-password',${JSON.stringify(password)});set('#onb-join-server',${JSON.stringify(base)});await sleep(100);document.querySelector('#onb-submit-join').click();
for(let i=0;i<100&&!window.__mp.live.connected;i++)await sleep(100);await sleep(350);const l=window.__mp.live;
let audio=null;if(${requireAudio}){for(let i=0;i<80&&!l.nowPlaying;i++)await sleep(100);const e=window.__mp.engine;for(let i=0;i<70&&!e.playing;i++)await sleep(100);const before=e.currentTime;await sleep(1500);audio={track:!!l.nowPlaying,serverPlaying:l.playing,playing:e.playing,ready:e.ready,advanced:e.currentTime>before+0.3,muted:e.muted,volume:e.volume,error:e.error};}
return {connected:l.connected,joined:l.joined,sessionBase:l.sessionBase,capabilities:[...(l.capabilities||[])],isGuest:l.identity?.isGuest,adminConfigured:l.adminConfigured,error:l.error||null,audio};})()`;
const env={...process.env,MP_EVAL:code,MP_EVAL_WAIT:'1000',MP_SHOT:'1',MP_SHOT_EXTRA:'welcome=1',MP_SHOT_OUT:path.join(os.tmpdir(),'mp-package-'+variant+'.png')};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MP_DEV;
const child=spawn(exe,[],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
const timeout=setTimeout(()=>child.kill(),30000);
child.on('error',e=>{clearTimeout(timeout);console.error(e.message);process.exitCode=1});
child.on('close',exit=>{clearTimeout(timeout);let result;try{result=JSON.parse(output.match(/\[eval\] result (.*)/)[1])}catch{result={error:'Missing evaluation result'}};
 const pass=exit===0&&result.connected&&result.joined&&result.sessionBase===base&&result.capabilities?.includes('identity-v2')&&
   (!requireAudio||(result.audio?.track&&result.audio?.serverPlaying&&result.audio?.playing&&result.audio?.ready&&result.audio?.advanced&&!result.audio?.muted&&result.audio?.volume>0&&!result.audio?.error));
 const evidence={variant,pass,result};fs.writeFileSync(path.join(os.tmpdir(),'mp-package-evidence-'+variant+'.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));if(!pass){console.log(output.replaceAll(password,'[REDACTED]').slice(-1500));process.exitCode=1;}});
