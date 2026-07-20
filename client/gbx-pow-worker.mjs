// gbx-pow-worker.mjs — CREATE-PoW mining worker
// Browser: new Worker('/gbx-pow-worker.mjs', { type: 'module' })
// Node E2E: worker_threads.Worker(path). Same message protocol both ways.
// in : {cmd:'start', coinIdHex, prevHashDisplayHex, nBits, powLimitHex?, batch?}
//      {cmd:'abort'}
// out: {type:'progress', hashes, hps} | {type:'found', pow80Hex, nonce, hashes, ms}
//      {type:'aborted'} | {type:'error', message}
import { minePow, verifyPow, POWLIMIT_MAIN } from './gbx-pow.mjs';

let aborted = false;
let post = null;

function hex2b(h){ const o = new Uint8Array(h.length/2); for (let i=0;i<o.length;i++) o[i]=parseInt(h.substr(i*2,2),16); return o; }
function b2hex(b){ return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join(''); }

async function onMsg(m){
  if (m && m.cmd === 'abort'){ aborted = true; return; }
  if (m && m.cmd === 'start'){
    aborted = false;
    const t0 = Date.now();
    try {
      const powLimit = (m.powLimitHex ? BigInt('0x'+m.powLimitHex) : POWLIMIT_MAIN);
      const cid = hex2b(m.coinIdHex);
      const res = await minePow({
        coinId: cid,
        prevHashDisplayHex: m.prevHashDisplayHex,
        nBits: m.nBits,
        powLimit: powLimit,
        batch: (m.batch || 50000),
        onProgress: function(h){ const s=(Date.now()-t0)/1000; post({ type:'progress', hashes:h, hps:(s>0 ? Math.round(h/s) : 0) }); },
        isAborted: function(){ return aborted; }
      });
      if (res === null){ post({ type:'aborted' }); return; }
      // self-verify: never hand back an unverified proof
      // verifyPow: null = OK, string = reason (consensus convention)
      const err = verifyPow(res.pow80, cid, m.nBits, powLimit);
      if (err === null){ post({ type:'found', pow80Hex: b2hex(res.pow80), nonce: res.nonce, hashes: res.hashes, ms: Date.now()-t0 }); }
      else { post({ type:'error', message:'self-verify failed: ' + err }); }
    } catch(e){ post({ type:'error', message: String(e && e.message ? e.message : e) }); }
  }
}

const inBrowserWorker = (typeof self === 'object' && self && typeof self.postMessage === 'function' && typeof window === 'undefined');
if (inBrowserWorker){
  post = function(m){ self.postMessage(m); };
  self.onmessage = function(ev){ onMsg(ev.data); };
} else {
  const wt = await import('node:worker_threads');
  if (wt.parentPort){
    post = function(m){ wt.parentPort.postMessage(m); };
    wt.parentPort.on('message', onMsg);
  }
}
