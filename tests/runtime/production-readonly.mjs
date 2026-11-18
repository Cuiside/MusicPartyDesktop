import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@stomp/stompjs';
const base=process.env.MP_TEST_BASE;
const password=process.env.MP_TEST_ROOM_PASSWORD;
if(!base||!password)throw Error('Provide MP_TEST_BASE and MP_TEST_ROOM_PASSWORD');
const results=[];let client;
const check=(name,pass,actual)=>{results.push({name,pass,actual});if(!pass)process.exitCode=1};
try{
 const version=await (await fetch(base+'/api/version')).json();
 check('deployed version',version.version==='1.4.1-fix',version);
 const config=await (await fetch(base+'/api/config')).json();
 check('REST protection enabled',config.restProtectionEnabled===true);
 check('unauthorized REST rejected',(await fetch(base+'/api/search/netease/test')).status===401);
 const response=await fetch(base+'/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
 const auth=await response.json();check('correct room password and token',response.ok&&auth.valid&&!!auth.roomToken);
 const protectedResponse=await fetch(base+'/api/search/netease/test',{headers:{'X-Room-Token':auth.roomToken}});
 check('valid room token reaches music service',protectedResponse.status!==401,{status:protectedResponse.status,neteaseConfigured:config.neteaseConfigured});
 let me,pong;
 client=new Client({brokerURL:base.replace(/^http/,'ws')+'/ws',reconnectDelay:0,connectHeaders:{'user-name':'游客发布验收','room-password':password,'client':'release-check/0.2.1'},
 onConnect:()=>{client.subscribe('/app/user/me',m=>me=JSON.parse(m.body));client.subscribe('/user/queue/me',m=>me=JSON.parse(m.body));client.subscribe('/user/queue/pong',m=>pong=JSON.parse(m.body));setTimeout(()=>client.publish({destination:'/app/ping',body:JSON.stringify({requestId:'release-readonly-ping',clientTime:Date.now()})}),300)}});
 client.activate();for(let i=0;i<80&&(!me||!pong);i++)await new Promise(r=>setTimeout(r,100));
 check('WSS v2 identity',!!me?.id&&!!me?.recoveryKey&&me.id!==me.recoveryKey,{received:!!me,isGuest:me?.isGuest});
 check('WSS unicast ping',pong?.requestId==='release-readonly-ping');
}catch(e){check('error',false,e.message)}finally{
 if(client)await client.deactivate();
 fs.writeFileSync(path.join(os.tmpdir(),'mp-production-readonly.json'),JSON.stringify({time:new Date().toISOString(),results},null,2));
 for(const r of results)console.log(JSON.stringify(r));
}
