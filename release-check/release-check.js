#!/usr/bin/env node
/* GBX Release Check — on-chain release verifier (verifier, never executor).
   Scans OP_RETURN GBX:R:tools-<tag>:<40-hex-commit>. An anchor is VALID only
   if its first input's ancestry (walk vin[0] backwards) reaches the published
   lineage root (a coinbase). Nobody can forge that lineage without the key;
   when the key is gone, the line is frozen by math. This service only reports
   state; applying a release is always a deliberate operator action. */
'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),{execFileSync}=require('child_process');
const GBX_DATADIR=process.env.GBX_DATADIR||'/var/lib/goldbrix';
const RPC_PORT=parseInt(process.env.GBX_RPC_PORT||'8332',10);
const STATE=process.env.GBX_RELCHK_STATE||path.join(__dirname,'release-check.json');
const ROOT=(process.env.GBX_RELEASE_ROOT||'').toLowerCase();
const TOOLSDIR=process.env.GBX_TOOLSDIR||path.resolve(__dirname,'..');
const WINDOW=parseInt(process.env.GBX_RELCHK_WINDOW||'400000',10);
const MAXWALK=parseInt(process.env.GBX_RELCHK_MAXWALK||'200',10);
const log=(...a)=>console.log(new Date().toISOString(),...a);
function rpcAuth(){const c=fs.readFileSync(path.join(GBX_DATADIR,'.cookie'),'utf8').trim();
  return 'Basic '+Buffer.from(c).toString('base64');}
function rpc(method,params=[]){return new Promise((resolve,reject)=>{
  const body=JSON.stringify({jsonrpc:'1.0',id:'gbxrelchk',method,params});
  const req=http.request({host:'127.0.0.1',port:RPC_PORT,method:'POST',
    headers:{'Content-Type':'text/plain','Content-Length':Buffer.byteLength(body),'Authorization':rpcAuth()}},
    res=>{let d='';res.on('data',x=>d+=x);res.on('end',()=>{
      try{const j=JSON.parse(d);if(j.error)return reject(new Error(j.error.message));resolve(j.result);}
      catch(e){reject(new Error('RPC parse'));}});});
  req.on('error',reject);req.write(body);req.end();});}
function decode(asm){ // scriptPubKey.asm: "OP_RETURN <hex>"
  if(!asm||!asm.startsWith('OP_RETURN '))return null;
  try{const t=Buffer.from(asm.slice(10).trim(),'hex').toString('utf8');
    const m=t.match(/^GBX:R:tools-([A-Za-z0-9._-]{1,24}):([0-9a-f]{40})$/);
    return m?{tag:'tools-'+m[1],commit:m[2]}:null;}catch(e){return null;}}
async function verifyLineage(txid){ // walk vin[0] back to the published root
  let cur=txid;
  for(let i=0;i<MAXWALK;i++){
    const t=await rpc('getrawtransaction',[cur,true]);
    const vin=t.vin&&t.vin[0]; if(!vin)return false;
    if(vin.coinbase!==undefined)return cur.toLowerCase()===ROOT;
    cur=vin.txid;
  } return false;}
function localVersion(){try{
  return execFileSync('git',['-C',TOOLSDIR,'describe','--tags','--always'],{encoding:'utf8'}).trim();
 }catch(e){return null;}}
function load(){try{return JSON.parse(fs.readFileSync(STATE,'utf8'));}
  catch(e){return {scanned_height:0,anchors:{}};}}
function save(s){const tmp=STATE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s,null,1));fs.renameSync(tmp,STATE);}
(async()=>{
  if(!/^[0-9a-f]{64}$/.test(ROOT)){log('FATAL: GBX_RELEASE_ROOT missing/invalid');process.exit(1);}
  const st=load();
  const tip=await rpc('getblockcount');
  if(!st.scanned_height)st.scanned_height=Math.max(0,tip-WINDOW);
  log('scan from',st.scanned_height,'to',tip);
  while(st.scanned_height<tip){
    const h=st.scanned_height+1;
    const hash=await rpc('getblockhash',[h]);
    const blk=await rpc('getblock',[hash,2]);
    for(const tx of blk.tx)for(const v of(tx.vout||[])){
      if(!v.scriptPubKey||v.scriptPubKey.type!=='nulldata')continue;
      const a=decode(v.scriptPubKey.asm); if(!a)continue;
      const ok=await verifyLineage(tx.txid);
      st.anchors[a.tag]={commit:a.commit,txid:tx.txid,height:h,lineage_valid:ok};
      log(ok?'ANCHOR VALID':'ANCHOR IGNORED (lineage)',a.tag,a.commit.slice(0,12),'@',h);
    }
    st.scanned_height=h;
    if(h%20000===0){save(st);log('progress',h,'/',tip);}
  }
  const valid=Object.entries(st.anchors).filter(([,v])=>v.lineage_valid);
  valid.sort((a,b)=>a[1].height-b[1].height);
  const latest=valid.length?{tag:valid[valid.length-1][0],...valid[valid.length-1][1]}:null;
  const lv=localVersion();
  st.report={checked_at:new Date().toISOString(),tip,local_version:lv,
    latest_anchored:latest,
    status:!latest?'none_anchored':(lv&&lv.startsWith(latest.tag)?'up_to_date':'update_available')};
  save(st);
  log('report:',JSON.stringify(st.report));
})().catch(e=>{log('err',e.message);process.exit(1);});
