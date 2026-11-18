import { reactive } from 'vue'
export const themeColors = [{id:'yellow',label:'黄',color:'#ffcd38'},{id:'pink',label:'粉',color:'#ec9fb9'},{id:'blue',label:'蓝',color:'#8bbbe3'},{id:'red',label:'红',color:'#ec8581'},{id:'purple',label:'紫',color:'#6751a4'}]
const load=(k,f)=>{try{return localStorage.getItem(k)||f}catch{return f}}
export const appearance=reactive({color:load('mp.appearance.color','yellow'),dark:load('mp.appearance.mode','light')==='dark'})
export function applyAppearance(){const root=document.documentElement;root.dataset.theme=themeColors.some(x=>x.id===appearance.color)?appearance.color:'yellow';root.dataset.mode=appearance.dark?'dark':'light';try{localStorage.setItem('mp.appearance.color',root.dataset.theme);localStorage.setItem('mp.appearance.mode',root.dataset.mode)}catch{}}
export function setThemeColor(id){if(themeColors.some(x=>x.id===id)){appearance.color=id;applyAppearance()}}
export function setDarkMode(dark){appearance.dark=!!dark;applyAppearance()}
applyAppearance()
