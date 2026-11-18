// Music credits and license: public/demo-audio/LICENSE.txt.
const covers = [
  { bg:'#141414', fg:'#ffcd38' }, { bg:'#f6c42a', fg:'#141414' },
  { bg:'#fcfcfd', fg:'#141414' }, { bg:'#e0ae00', fg:'#141414' }
]
const owners = ['阿伟', '小云', 'Echo', '山茶', 'Nova']
const tracks = [
  { title: 'Dynamic Horizon', file: 'dynamic-horizon.ogg', duration: 35 },
  { title: 'Dynamic Daydreams', file: 'dynamic-daydreams.ogg', duration: 35 },
  { title: 'Dynamic School Days', file: 'dynamic-school-days.ogg', duration: 30 },
  { title: 'After School', file: 'after-school.ogg', duration: 46 },
  { title: 'DownTempo Avenue', file: 'downtempo-avenue.ogg', duration: 103 }
]
const makeSong = (i, prefix = 'q') => {
  const index = i + 1, n = String(index).padStart(2, '0'), source = i % 3 === 2 ? 'bilibili' : 'netease'
  const track = tracks[i]
  return { id:`${prefix}${index}`, title:track.title, artist:'ViRiX', album:'Upbeat Visual Novel Music', source,
    sourceLabel:'开放授权演示', duration:track.duration, url:`demo-audio/${track.file}`, liked:i % 8,
    likedByMe:false, pinned:false, state:i === 0 ? 'playing' : 'queued', requestedBy:owners[i % owners.length],
    addedAt:'00:41', cover:{ ...covers[i % covers.length], mark:n, sub:'OPEN MUSIC', tag:'DEMO' } }
}
const queue = tracks.map((_, i) => makeSong(i))
export const demo = {
  room:{ name:'深夜电台', code:'FMA-204', mode:'本地服务', server:'127.0.0.1:8080', online:6, capacity:12, latency:12, locked:false, admin:true, queueCount:5 },
  nowPlaying:{ ...queue[0], progress:0 }, queue,
  members:[{name:'阿伟',role:'房主',status:'在听',you:false},{name:'小云',role:'成员',status:'在听',you:false},{name:'Echo',role:'成员',status:'在听',you:false},{name:'山茶',role:'成员',status:'点歌中',you:false},{name:'Nova',role:'成员',status:'闲置',you:false},{name:'游客',role:'管理员',status:'在听',you:true}],
  activity:[{time:'00:47',text:'阿伟 点了 Dynamic Horizon'},{time:'00:46',text:'山茶 置顶了 After School'},{time:'00:44',text:'小云 点赞了当前播放'},{time:'00:41',text:'Echo 加入房间'},{time:'00:38',text:'Nova 进入闲置状态'}],
  searchResults:tracks.map((_,i)=>makeSong(i,'s')),
  trending:tracks.map(t=>t.title),
  lyrics:[{t:0,text:'开放授权演示音乐 · ViRiX'},{t:4,text:'来源与许可见素材说明'}]
}
demo.history = demo.queue.slice(1).map((s, i) => ({ ...s, id:`h-${s.id}`, playedAt:`00:${String(38-i).padStart(2,'0')}` }))
demo.chat = [
  {id:'c1',type:'system',time:'00:38',text:'欢迎来到演示房间'},
  {id:'c2',type:'chat',time:'00:39',user:'阿伟',role:'房主',text:'先来一首测试音轨。'},
  {id:'c3',type:'song',time:'00:40',user:'SYSTEM',song:demo.nowPlaying},
  {id:'c4',type:'chat',time:'00:41',user:'小云',text:'正在测试聊天界面。'},
  {id:'c5',type:'system',time:'00:42',text:'小云 点赞了当前播放'}
]
export const navItems = [{id:'party',label:'派对'},{id:'queue',label:'队列'},{id:'search',label:'搜索'},{id:'chat',label:'聊天'},{id:'history',label:'历史'},{id:'console',label:'控制台'}]
