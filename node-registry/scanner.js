#!/usr/bin/env node
/* GBX Node Registry Scanner — on-chain node discovery (prototype, build-once).
   Scans new blocks for OP_RETURN GBX:NODE:<https-url>. Liveness window:
   entries older than WINDOW blocks expire (operators re-announce ~weekly).
   Separate process; state = JSON file served by read-api. Keyless, read-only. */
'use strict';
const fs = require('fs'); const path = require('path'); const http = require('http');
const GBX_DATADIR = process.env.GBX_DATADIR || '/var/lib/goldbrix';
const RPC_PORT = parseInt(process.env.GBX_RPC_PORT || '8332', 10);
const STATE = process.env.GBX_NODEREG_STATE || '/root/goldbrix-tools/node-registry/node-registry.json';
const START_HEIGHT = parseInt(process.env.GBX_NODEREG_START || '0', 10);
const WINDOW = parseInt(process.env.GBX_NODEREG_WINDOW || '200000', 10);
const POLL_MS = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
function rpcAuth(){ const c = fs.readFileSync(path.join(GBX_DATADIR,'.cookie'),'utf8').trim();
  return 'Basic ' + Buffer.from(c).toString('base64'); }
function rpc(method, params=[]) {
  return new Promise((resolve,reject)=>{
    const body = JSON.stringify({jsonrpc:'1.0',id:'gbxnodereg',method,params});
    const req = http.request({host:'127.0.0.1',port:RPC_PORT,method:'POST',
      headers:{'Content-Type':'text/plain','Content-Length':Buffer.byteLength(body),'Authorization':rpcAuth()}},
      res=>{let d='';res.on('data',x=>d+=x);res.on('end',()=>{
        try{const j=JSON.parse(d);if(j.error)return reject(new Error(j.error.message));resolve(j.result);}
        catch(e){reject(new Error('RPC parse'));}});});
    req.on('error',reject);req.write(body);req.end();
  });
}
function load(){ try{return JSON.parse(fs.readFileSync(STATE,'utf8'));}catch(e){
  return {scanned_height: START_HEIGHT, nodes:{}}; } }
function save(s){ const tmp=STATE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(s,null,1)); fs.renameSync(tmp,STATE); }
function decode(hexasm){ // scriptPubKey.asm: "OP_RETURN <hex>"
  if(!hexasm||!hexasm.startsWith('OP_RETURN '))return null;
  try{ const t=Buffer.from(hexasm.slice(10).trim(),'hex').toString('utf8');
    return t.startsWith('GBX:NODE:')?t.slice(9):null; }catch(e){return null;}
}
const VALID = /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[a-zA-Z0-9._\/-]*)?$/;
(async()=>{
  const st = load();
  if (!st.scanned_height) {
    // First run, no state: only the liveness window matters — older announces are expired anyway.
    st.scanned_height = START_HEIGHT || Math.max(0, (await rpc('getblockcount')) - WINDOW);
  }
  log('start from', st.scanned_height, 'window', WINDOW);
  for(;;){
    try{
      const tip = await rpc('getblockcount');
      // Reorg safety: stay 100 behind tip? No — finality=100; scan to tip-1 is fine for discovery (client verifies liveness anyway).
      while (st.scanned_height < tip) {
        const h = st.scanned_height + 1;
        const hash = await rpc('getblockhash',[h]);
        const blk = await rpc('getblock',[hash,2]);
        for (const tx of blk.tx) for (const v of (tx.vout||[])) {
          if (!v.scriptPubKey || v.scriptPubKey.type!=='nulldata') continue;
          const url = decode(v.scriptPubKey.asm);
          if (url && VALID.test(url)) { st.nodes[url] = {height:h, txid:tx.txid}; log('ANNOUNCE',url,'@',h); }
        }
        st.scanned_height = h;
        if (h % 5000 === 0) { prune(st, tip); save(st); }
      }
      prune(st, tip); save(st);
    }catch(e){ log('err',e.message); }
    await sleep(POLL_MS);
  }
  function prune(s,tip){ for(const u of Object.keys(s.nodes))
    if (s.nodes[u].height < tip - WINDOW) { log('EXPIRE',u); delete s.nodes[u]; } }
})();
