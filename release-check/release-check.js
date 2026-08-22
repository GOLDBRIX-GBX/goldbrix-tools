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
const STATE=process.env.GBX_RELCHK_STATE||path.join(process.env.GBX_STATE_DIR||__dirname,'release-check.json');
const ROOT=(process.env.GBX_RELEASE_ROOT||'').toLowerCase();
const TOOLSDIR=process.env.GBX_TOOLSDIR||path.resolve(__dirname,'..');
const WINDOW=parseInt(process.env.GBX_RELCHK_WINDOW||'400000',10);
const MAXWALK=parseInt(process.env.GBX_RELCHK_MAXWALK||'200',10);
const log=(...a)=>console.log(new Date().toISOString(),...a);
function rpcAuth(){
  try{ return 'Basic '+Buffer.from(fs.readFileSync(path.join(GBX_DATADIR,'.cookie'),'utf8').trim()).toString('base64'); }
  catch(e){
    const u=process.env.GBX_RPC_USER, p=process.env.GBX_RPC_PASS;
    if(u&&p) return 'Basic '+Buffer.from(u+':'+p).toString('base64');
    throw new Error('no .cookie at '+GBX_DATADIR+' and no GBX_RPC_USER/GBX_RPC_PASS');
  }
}
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
    if(m)return {kind:'tools',tag:'tools-'+m[1],commit:m[2]};
    /* App/bundle anchors: GBX:R:<tag>:<64-hex sha256> (e.g. signed-APK sha,
       or the www bundle top-hash). Additive: stored apart from tools anchors. */
    /* Permanent-source anchors: GBX:ARW:<tag>:<Arweave txid>. The archive id is
       base64url, not hex, so it gets its own namespace and never mixes with
       code or bundle hashes. */
    const w=t.match(/^GBX:ARW:([A-Za-z0-9._-]{1,24}):([A-Za-z0-9_-]{43})$/);
    if(w)return {kind:'arw',tag:w[1],arweave:w[2]};
    const a=t.match(/^GBX:R:([A-Za-z0-9._-]{1,9}):([0-9a-f]{64})$/);
    /* The tools-* namespace belongs to code anchors, whose value is a
       40-hex commit. A tools-* tag carrying a 64-hex value is malformed by
       construction (one exists historically, all zeros) and must not land
       in the app anchor namespace, where the client looks up bundle hashes. */
    if(a&&/^tools-/.test(a[1])) return null;
    return a?{kind:'app',tag:a[1],sha:a[2]}:null;}catch(e){return null;}}
async function verifyLineage(txid){ // walk vin[0] back to the published root
  let cur=txid;
  for(let i=0;i<MAXWALK;i++){
    const t=await rpc('getrawtransaction',[cur,true]);
    const vin=t.vin&&t.vin[0]; if(!vin)return false;
    if(vin.coinbase!==undefined)return cur.toLowerCase()===ROOT;
    cur=vin.txid;
  } return false;}
function localHead(){try{
  return execFileSync('git',['-C',TOOLSDIR,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 }catch(e){return null;}}
function localVersion(){try{
  /* An exact tag is a version; anything else is a commit, and saying so plainly
     beats printing a short hash where an operator expects a release name. */
  const t=execFileSync('git',['-C',TOOLSDIR,'describe','--tags','--exact-match','--match','tools-*'],
    {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  if(t) return t;
 }catch(e){
  /* No tag at HEAD is worth saying out loud. On a copied install it is the
     first visible symptom that the metadata does not describe the code. */
  log('NOTE: no tools-* tag at HEAD; reporting a bare commit');
 }
 const h=localHead(); return h?('commit:'+h.slice(0,12)):null;}
function treeChanges(){try{
  /* Metadata is not the code. Where a running copy is installed by copying
     files rather than by checking out, .git can freeze while the files move on
     (or the reverse, which is worse: fresh metadata over stale code reads as
     up_to_date and confirms something untrue). Compare the worktree with HEAD
     and report what differs. This is reported alongside the anchor verdict, not
     instead of it: an operator running local modifications is exactly what a
     federation is for, and must not lose his version reading for it. */
  const o=execFileSync('git',['-C',TOOLSDIR,'diff','--name-only','HEAD'],{encoding:'utf8'});
  return o.split('\n').map(x=>x.trim()).filter(Boolean);
 }catch(e){return null;}}
function isAncestor(a,b){
  /* true = a is an ancestor of b; false = it is not; null = this repo has never
     seen the commit (git exits 128), which is not the same thing and must not
     be read as "not an ancestor". */
  try{ execFileSync('git',['-C',TOOLSDIR,'merge-base','--is-ancestor',a,b],{stdio:'ignore'}); return true; }
  catch(e){ return e.status===1 ? false : null; }}
function releaseStatus(head,latest){
  if(!latest) return 'none_anchored';
  if(!head) return 'update_available';
  if(head===latest.commit) return 'up_to_date';
  /* A node whose HEAD descends from the anchor carries the anchored release
     plus later work. Calling that stale invites the operator to roll back his
     own commits. An anchor this repo has not fetched stays update_available. */
  return isAncestor(latest.commit,head)===true ? 'ahead_of_anchor' : 'update_available';}
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
      if(a.kind==='arw'){
        (st.arw_anchors=st.arw_anchors||{})[a.tag]={arweave:a.arweave,txid:tx.txid,height:h,lineage_valid:ok};
        log(ok?'ARW ANCHOR VALID':'ARW ANCHOR IGNORED (lineage)',a.tag,a.arweave.slice(0,12),'@',h);
      } else if(a.kind==='app'){
        (st.app_anchors=st.app_anchors||{})[a.tag]={sha:a.sha,txid:tx.txid,height:h,lineage_valid:ok};
        log(ok?'APP ANCHOR VALID':'APP ANCHOR IGNORED (lineage)',a.tag,a.sha.slice(0,12),'@',h);
      } else {
        st.anchors[a.tag]={commit:a.commit,txid:tx.txid,height:h,lineage_valid:ok};
        log(ok?'ANCHOR VALID':'ANCHOR IGNORED (lineage)',a.tag,a.commit.slice(0,12),'@',h);
      }
    }
    st.scanned_height=h;
    if(h%20000===0){save(st);log('progress',h,'/',tip);}
  }
  const valid=Object.entries(st.anchors).filter(([,v])=>v.lineage_valid);
  valid.sort((a,b)=>a[1].height-b[1].height);
  const latest=valid.length?{tag:valid[valid.length-1][0],...valid[valid.length-1][1]}:null;
  const lv=localVersion();
  const head=localHead();
  const changed=treeChanges();
  const clean=changed===null?null:changed.length===0;
  if(clean===false)log('WARNING: worktree differs from HEAD in',changed.length,
    'tracked file(s) - the reported version describes metadata, not the code that runs:',
    changed.slice(0,10).join(', '));
  st.report={checked_at:new Date().toISOString(),tip,local_version:lv,
    latest_anchored:latest,
    local_commit:head,
    tree_clean:clean,
    tree_changed:changed===null?null:changed.slice(0,20),
    /* The chain records a commit, so the verdict compares commits. Comparing
       tag prefixes reports a stale node as current (tools-v1 vs tools-v10) and
       a current node as stale (HEAD past the tag). */
    status:releaseStatus(head,latest)};
  save(st);
  log('report:',JSON.stringify(st.report));
})().catch(e=>{log('err',e.message);process.exit(1);});
