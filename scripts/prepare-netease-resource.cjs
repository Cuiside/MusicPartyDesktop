'use strict'
// Pinned official upstream Windows release, verified before it is redistributed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const version='4.36.1',sha256='b42124b5cbf2b128cf55fe3f0b17a601fb705ffdfd0d36f7d85829914edc6263';
const url=`https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/releases/download/v${version}/ncm-api-win-x64.exe`;
async function main(){
 const index=process.argv.indexOf('--source');const source=index>=0?path.resolve(process.argv[index+1]):null;
 const bytes=source?fs.readFileSync(source):Buffer.from(await (await fetch(url,{signal:AbortSignal.timeout(300000)})).arrayBuffer());
 const actual=crypto.createHash('sha256').update(bytes).digest('hex');
 if(actual!==sha256)throw Error('Official NCM API checksum mismatch; not copied');
 fs.mkdirSync(path.join(root,'bin'),{recursive:true});fs.writeFileSync(path.join(root,'bin/netease-api.exe'),bytes);
 const metaPath=path.join(root,'.musicparty-resources.json');let meta={};try{meta=JSON.parse(fs.readFileSync(metaPath))}catch{}
 meta.neteaseApi={version,sha256,url,bytes:bytes.length,preparedAt:new Date().toISOString()};
 fs.writeFileSync(metaPath,JSON.stringify(meta,null,2)+'\n');
 fs.writeFileSync(path.join(root,'bin/netease-api-NOTICE.txt'),`NetEaseCloudMusicApiEnhanced ${version}\nOfficial upstream: https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced\nWindows release: ${url}\nSHA256: ${sha256}\nThis third-party component is distributed under its upstream license.\n`);
 console.log(JSON.stringify(meta.neteaseApi));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
