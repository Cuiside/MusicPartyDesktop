import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const vite = await createServer({ root, configFile: path.join(root, 'vite.config.js'), server: { port: 5173, strictPort: true } })
await vite.listen()
try {
  const code = `(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    const c=await import('/src/core/live/client.js');
    const joined=await c.joinRoom({serverUrl:'http://127.0.0.1:18993',name:'测试用户',password:''});
    await wait(900);
    document.querySelector('.nav-account').click();await wait(100);
    const leave=[...document.querySelectorAll('.ctx-item')].find(e=>e.textContent.includes('断开并回到加入界面'));
    if(!leave) throw Error('找不到退出房间菜单');leave.click();await wait(100);
    const confirm=[...document.querySelectorAll('.dialog-actions button')].find(e=>e.textContent.includes('断开并返回'));
    if(!confirm) throw Error('找不到退出确认');confirm.click();
    for(let i=0;i<60&&!window.__mp.onboarding.visible();i++)await wait(100);
    const exited=window.__mp.onboarding.visible()&&!window.__mp.live.joined;
    document.querySelector('[title=设置]').click();await wait(150);
    const service=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('服务与连接'));
    if(!service) throw Error('找不到服务设置');service.click();await wait(150);
    const buttons=[...document.querySelectorAll('.svc-card-actions button')];
    const separate=buttons.some(b=>b.textContent.includes('停止本地服务'))&&buttons.some(b=>b.textContent.includes('启动本地服务'));
    return {joined,exited,separate};
  })()`
  const env = { ...process.env, MP_DEV:'1', MP_SHOT:'1', MP_SHOT_VIEW:'party', MP_EVAL:code, MP_EVAL_WAIT:'1200', MP_SHOT_OUT:path.join(os.tmpdir(),'mp-leave-stop.png') }
  delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(require('electron'),['.'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out=''
  child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d)
  const exit=await new Promise(resolve=>{const t=setTimeout(()=>{child.kill();resolve(-1)},30000);child.on('exit',c=>{clearTimeout(t);resolve(c)})})
  const marker=String.fromCharCode(91)+'eval'+String.fromCharCode(93)+' result '
  const line=out.split(String.fromCharCode(10)).find(s=>s.startsWith(marker));const result=line?JSON.parse(line.slice(marker.length)):{error:out.slice(-1600)}
  const passed=exit===0&&result.joined&&result.exited&&result.separate
  console.log(JSON.stringify({passed,result}));if(!passed)process.exitCode=1
} finally { await vite.close() }
