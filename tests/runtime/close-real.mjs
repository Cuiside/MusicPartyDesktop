import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
const root=path.resolve(import.meta.dirname,'../..'), require=createRequire(import.meta.url)
const vite=await createServer({root,configFile:path.join(root,'vite.config.js'),server:{port:5173,strictPort:true}})
await vite.listen()
try {
  for (const action of ['cancel','tray','close','crash','crash-before']) {
    const profile=fs.mkdtempSync(path.join(os.tmpdir(),'mp-close-real-'))
    const env={...process.env,MP_DEV:'1',MP_CLOSE_PROMPT:'1',MP_CLOSE_PROMPT_ACTION:action,MP_CLOSE_PROMPT_ACTION_DELAY:'1600',MP_CLOSE_PROMPT_REMEMBER:'1',MP_CLOSE_TEST_DATA_DIR:profile}
    if(action==='crash')env.MP_CLOSE_TEST_CRASH='1'
    if(action==='crash-before')env.MP_CLOSE_TEST_CRASH_BEFORE='1'
    for(const key of ['ELECTRON_RUN_AS_NODE','MP_SHOT','MP_EVAL','MP_EVAL_FILE'])delete env[key]
    const child=spawn(require('electron'),['.'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output=''
    child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
    const exit=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve(-1)},16000);child.on('exit',code=>{clearTimeout(timer);resolve(code)})})
    const pref=path.join(profile,'close-preference.json')
    const saved=fs.existsSync(pref)?JSON.parse(fs.readFileSync(pref,'utf8')).action:'ask'
    const pass=exit===0&&(action==='crash-before'||output.includes('real close request sent=true'))&&(['cancel','crash','crash-before'].includes(action)?saved==='ask':saved===action)
    console.log(JSON.stringify({action,pass,exit,saved}));if(!pass){console.log(output.slice(-1800));process.exitCode=1}
  }
} finally { await vite.close() }
