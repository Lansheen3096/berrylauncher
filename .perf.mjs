import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(import.meta.url)
const root = process.cwd()
const electronPath = require('electron')
const port = 9343
const child = spawn(electronPath, ['.', '--no-sandbox', '--disable-gpu', '--ozone-platform=x11', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, '.perf/home/chromium')}`], { cwd: root, env: { ...process.env, HOME: path.join(root, '.perf/home'), XDG_CONFIG_HOME: path.join(root, '.perf/home/.config'), BERRY_DATA_DIR: path.join(root, '.perf/data') }, stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let ws, id = 0; const pending = new Map()
const send = (m,p={}) => { const i=++id; ws.send(JSON.stringify({id:i,method:m,params:p})); return new Promise((res,rej)=>pending.set(i,{resolve:res,reject:rej})) }
const ev = async (e) => { const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value }
async function main(){
  let t; for(let i=0;i<120&&!t;i++){ try{ t=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x=>x.type==='page') }catch{} if(!t) await sleep(250) }
  ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej)})
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}})
  await send('Runtime.enable'); await sleep(1500)
  console.log('styles', await ev(`JSON.stringify({titlebar:getComputedStyle(document.querySelector('.titlebar')).backdropFilter, card:getComputedStyle(document.querySelector('.card')).backdropFilter, contentAnim:getComputedStyle(document.querySelector('.content')).animationName, contentWillChange:getComputedStyle(document.querySelector('.content')).willChange})`))
  const result = await ev(`(async()=>{
    const nav=[...document.querySelectorAll('.nav-item')].find(n=>n.textContent.includes('版本库')); nav.click();
    await new Promise(r=>setTimeout(r,1800));
    const el=document.querySelector('.content');
    el.scrollTop=0;
    const frames=[]; let last=performance.now(); let n=0;
    await new Promise(resolve=>{
      function step(t){ frames.push(t-last); last=t; el.scrollTop += 24; n++; if(n<150) requestAnimationFrame(step); else resolve(); }
      requestAnimationFrame(step);
    });
    frames.shift();
    const sorted=[...frames].sort((a,b)=>a-b);
    return JSON.stringify({rows: document.querySelectorAll('.version-row').length, height: el.scrollHeight, avg: +(frames.reduce((a,b)=>a+b,0)/frames.length).toFixed(2), p50: +sorted[Math.floor(sorted.length*.5)].toFixed(2), p95: +sorted[Math.floor(sorted.length*.95)].toFixed(2), max: +Math.max(...frames).toFixed(2)});
  })()`)
  console.log('bench', result)
  await ev('window.berry.app.close()'); ws.close()
}
main().then(()=>{child.kill();process.exit(0)}).catch(e=>{console.error(e);child.kill();process.exit(1)})
