// GOLDBRIX Pool Stratum — P1P solo-noncustodial job engine
// Coinbase pays the miner's address DIRECTLY. Pool never holds funds. fee_bps=0 (code-is-law).
const net = require('net');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const HOST = process.env.GBX_POOL_STRATUM_HOST || '0.0.0.0';
const PORT = Number(process.env.GBX_POOL_STRATUM_PORT || 3333);
const INFO_PORT = Number(process.env.GBX_POOL_API_PORT || 8087);
const RPC_HOST = process.env.GBX_RPC_HOST || '127.0.0.1';
const RPC_PORT = Number(process.env.GBX_RPC_PORT || 8342);
const RPC_DATADIR = process.env.GBX_RPC_DATADIR || '/root/.bitcoin';
const LOG_DIR = process.env.GBX_POOL_LOG_DIR || '/root/goldbrix-pool/logs';
const BLOCKS_LOG = LOG_DIR + '/blocks_found.jsonl';
const POOL_TAG = '/GBX-P1P/';
const EN1_SIZE = 4, EN2_SIZE = 4;
const SHARE_MIN_DIFF = Number(process.env.GBX_SHARE_MIN_DIFF || 0.0001);
const VARDIFF_TARGET_S = Number(process.env.GBX_VARDIFF_TARGET_S || 8);
const VARDIFF_RETARGET_S = Number(process.env.GBX_VARDIFF_RETARGET_S || 45);
function targetFromDiff(netTargetBuf, netDiff, shareDiff){
  if (shareDiff >= netDiff) return Buffer.from(netTargetBuf);
  const r = netDiff / shareDiff;
  const bits = BigInt('0x'+netTargetBuf.toString('hex'));
  const scaled = bits * BigInt(Math.round(r*1e6)) / 1000000n;
  let h = scaled.toString(16); if (h.length>64) h='f'.repeat(64);
  return Buffer.from(h.padStart(64,'0'),'hex');
}

// ---------- RPC over HTTP (cookie auth) ----------
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    let cookie;
    try { cookie = fs.readFileSync(RPC_DATADIR + '/.cookie', 'utf8').trim(); }
    catch (e) { return reject(new Error('cookie read: ' + e.message)); }
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'gbxpool', method, params: params || [] });
    const req = http.request({
      host: RPC_HOST, port: RPC_PORT, method: 'POST', auth: cookie,
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) reject(new Error('rpc ' + method + ': ' + JSON.stringify(j.error)));
          else resolve(j.result);
        } catch (e) { reject(new Error('rpc parse: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ---------- serialization helpers ----------
const sha256 = b => crypto.createHash('sha256').update(b).digest();
const sha256d = b => sha256(sha256(b));
function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}
function u32LE(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function u64LE(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function heightPush(h) {
  let x = h; const bytes = [];
  while (x > 0) { bytes.push(x & 0xff); x = Math.floor(x / 256); }
  if (bytes.length === 0) bytes.push(0);
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);
}
function prevhashStratum(beHex) {
  const c = []; for (let i = 0; i < 64; i += 8) c.push(beHex.slice(i, i + 8));
  return c.reverse().join('');
}
function diffFromTarget(tHex) {
  const t = parseInt(tHex.slice(0, 16), 16) * Math.pow(2, 4 * (64 - 16));
  return (0xffff * Math.pow(2, 208)) / t;
}

// coinbase split for stratum: coinb1 + extranonce1 + extranonce2 + coinb2 (non-witness serialization = txid form)
function buildCoinbaseParts(gbt, payoutScriptHex) {
  const hp = heightPush(gbt.height);
  const tag = Buffer.from(POOL_TAG, 'utf8');
  const scriptLen = hp.length + 1 + EN1_SIZE + EN2_SIZE + 1 + tag.length;
  const payoutScript = Buffer.from(payoutScriptHex, 'hex');
  const outs = [Buffer.concat([u64LE(gbt.coinbasevalue), varint(payoutScript.length), payoutScript])];
  let outCount = 1;
  if (gbt.default_witness_commitment) {
    const cs = Buffer.from(gbt.default_witness_commitment, 'hex');
    outs.push(Buffer.concat([u64LE(0), varint(cs.length), cs]));
    outCount++;
  }
  const coinb1 = Buffer.concat([
    u32LE(2), Buffer.from([1]), Buffer.alloc(32), Buffer.from('ffffffff', 'hex'),
    varint(scriptLen), hp, Buffer.from([EN1_SIZE + EN2_SIZE])
  ]);
  const coinb2 = Buffer.concat([
    Buffer.from([tag.length]), tag, Buffer.from('ffffffff', 'hex'),
    varint(outCount), ...outs, u32LE(0)
  ]);
  return { coinb1: coinb1.toString('hex'), coinb2: coinb2.toString('hex') };
}
// re-serialize with witness (marker/flag + reserved value) for block submission
function coinbaseWithWitness(cbHex) {
  const b = Buffer.from(cbHex, 'hex');
  return Buffer.concat([
    b.slice(0, 4), Buffer.from('0001', 'hex'), b.slice(4, b.length - 4),
    Buffer.from('0120', 'hex'), Buffer.alloc(32), b.slice(b.length - 4)
  ]).toString('hex');
}
function merkleBranch(txidsBE) {
  let merkle = [null].concat(txidsBE.map(h => Buffer.from(h, 'hex').reverse()));
  const branch = [];
  while (merkle.length > 1) {
    if (merkle.length % 2) merkle.push(merkle[merkle.length - 1]);
    branch.push(merkle[1]);
    const next = [null];
    for (let i = 2; i < merkle.length; i += 2) next.push(sha256d(Buffer.concat([merkle[i], merkle[i + 1]])));
    merkle = next;
  }
  return branch;
}
function merkleRoot(cbHashLE, branch) {
  let root = cbHashLE;
  for (const b of branch) root = sha256d(Buffer.concat([root, b]));
  return root;
}

// ---------- job manager ----------
let jobCounter = 0;
const jobs = new Map();           // jobId -> {gbt, branch, targetBuf}
let currentJobId = null;
const clients = new Set();
const stats = { jobs_served: 0, shares_ok: 0, shares_rej: 0, started: Math.floor(Date.now() / 1000) };
stats.rej_reasons = {};
function tallyRej(r){ stats.rej_reasons[r]=(stats.rej_reasons[r]||0)+1; }
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
function blocksFoundCount() {
  try { return fs.readFileSync(BLOCKS_LOG, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

async function newTemplate(reason) {
  const gbt = await rpc('getblocktemplate', [{ rules: ['segwit'] }]);
  jobCounter++;
  const jobId = jobCounter.toString(16);
  const branch = merkleBranch((gbt.transactions || []).map(t => t.txid || t.hash));
  const targetBuf = Buffer.from(gbt.target, 'hex');
  const prevJob = jobs.get(currentJobId);
  const clean = !prevJob || prevJob.gbt.previousblockhash !== gbt.previousblockhash;
  jobs.set(jobId, { gbt, branch, targetBuf });
  // 7.5 stale-window: keep jobs for current + previous height (last + second-to-last)
  for (const [jid, j] of jobs) if (j.gbt.height < gbt.height - 1) jobs.delete(jid);
  while (jobs.size > 12) jobs.delete(jobs.keys().next().value);
  currentJobId = jobId;
  lastPrev = gbt.previousblockhash; lastTplTs = Date.now();
  for (const c of clients) if (c._gbx.authorized) notifyClient(c, jobId, clean);
  console.log(`job ${jobId} height=${gbt.height} txs=${(gbt.transactions || []).length} reason=${reason}`);
  return jobId;
}

function notifyClient(socket, jobId, clean) {
  const job = jobs.get(jobId);
  if (!job) return;
  const st = socket._gbx;
  if (!st.cb) st.cb = {};
  if (!st.cb[jobId]) st.cb[jobId] = buildCoinbaseParts(job.gbt, st.payoutScript);
  for (const k of Object.keys(st.cb)) if (!jobs.has(k)) delete st.cb[k];
  if (!st.diffSent) {
    const _nd = diffFromTarget(job.gbt.target);
    if (st.shareDiff > _nd) st.shareDiff = _nd;
    send(socket, { id: null, method: 'mining.set_difficulty', params: [st.shareDiff] });
    st.diffSent = true;
  }
  send(socket, {
    id: null, method: 'mining.notify', params: [
      jobId, prevhashStratum(job.gbt.previousblockhash),
      st.cb[jobId].coinb1, st.cb[jobId].coinb2,
      job.branch.map(b => b.toString('hex')),
      job.gbt.version.toString(16).padStart(8, '0'),
      job.gbt.bits, job.gbt.curtime.toString(16).padStart(8, '0'), !!clean
    ]
  });
  stats.jobs_served++;
}

async function handleSubmit(socket, msg, params) {
  const st = socket._gbx;
  const [, jobId, en2, ntime, nonce] = params.map(p => String(p || '').toLowerCase());
  const job = jobs.get(jobId);
  if (!job) { tallyRej('STALE'); stats.shares_rej++; return reply(socket, msg.id ?? null, false, [21, 'JOB_NOT_FOUND_OR_STALE', null]); }
  if (!/^[0-9a-f]{8}$/.test(en2) || !/^[0-9a-f]{8}$/.test(ntime) || !/^[0-9a-f]{8}$/.test(nonce))
    { tallyRej('MALFORMED'); stats.shares_rej++; return reply(socket, msg.id ?? null, false, [20, 'MALFORMED_PARAMS', null]); }
  const parts = st.cb && st.cb[jobId];
  if (!parts) { tallyRej('NO_CB'); stats.shares_rej++; return reply(socket, msg.id ?? null, false, [21, 'NO_COINBASE_FOR_JOB', null]); }

  const coinbaseHex = parts.coinb1 + st.extranonce1 + en2 + parts.coinb2;
  const cbHash = sha256d(Buffer.from(coinbaseHex, 'hex'));
  const root = merkleRoot(cbHash, job.branch);
  const header = Buffer.concat([
    u32LE(job.gbt.version),
    Buffer.from(job.gbt.previousblockhash, 'hex').reverse(),
    root,
    Buffer.from(ntime, 'hex').reverse(),
    Buffer.from(job.gbt.bits, 'hex').reverse(),
    Buffer.from(nonce, 'hex').reverse()
  ]);
  const hashBE = Buffer.from(sha256d(header)).reverse();
  const _netDiff = diffFromTarget(job.gbt.target);
  const shareTarget = targetFromDiff(job.targetBuf, _netDiff, st.shareDiff);
  if (Buffer.compare(hashBE, shareTarget) > 0) {
    tallyRej('LOWDIFF'); stats.shares_rej++;
    return reply(socket, msg.id ?? null, false, [23, 'LOW_DIFFICULTY_SHARE', null]);
  }
  st.sharesSince++;
  const _now = Date.now();
  if (_now - st.lastRetarget >= VARDIFF_RETARGET_S*1000) {
    const elapsed=(_now-st.lastRetarget)/1000, rate=st.sharesSince/elapsed, tRate=1/VARDIFF_TARGET_S;
    if (rate>0){ let nd=st.shareDiff*(rate/tRate); nd=Math.max(SHARE_MIN_DIFF,Math.min(nd,_netDiff));
      if (Math.abs(nd-st.shareDiff)/st.shareDiff>0.2){ st.shareDiff=nd; send(socket,{id:null,method:'mining.set_difficulty',params:[nd]}); } }
    st.lastRetarget=_now; st.sharesSince=0;
  }
  // block only if hash meets NETWORK target
  if (Buffer.compare(hashBE, job.targetBuf) > 0) {
    stats.shares_ok++;
    return reply(socket, msg.id ?? null, true, null);
  }
  // block candidate → assemble full block (witness coinbase) + submit
  const txs = job.gbt.transactions || [];
  const blockHex = header.toString('hex')
    + varint(1 + txs.length).toString('hex')
    + coinbaseWithWitness(coinbaseHex)
    + txs.map(t => t.data).join('');
  let res;
  try { res = await rpc('submitblock', [blockHex]); }
  catch (e) { tallyRej('SUBMIT_ERR'); stats.shares_rej++; return reply(socket, msg.id ?? null, false, [20, 'SUBMIT_ERROR:' + e.message.slice(0, 80), null]); }
  if (res !== null && res !== undefined && res !== '') {
    tallyRej('SUBMIT_REJ:'+String(res).slice(0,20)); stats.shares_rej++;
    return reply(socket, msg.id ?? null, false, [20, 'REJECTED:' + String(res), null]);
  }
  stats.shares_ok++;
  const rec = { ts: Math.floor(Date.now() / 1000), height: job.gbt.height, hash: hashBE.toString('hex'),
    payout_address: st.payout, worker: st.worker, coinbase_value_sats: job.gbt.coinbasevalue, mode: 'solo-noncustodial' };
  fs.appendFileSync(BLOCKS_LOG, JSON.stringify(rec) + '\n');
  console.log('BLOCK FOUND', JSON.stringify(rec));
  reply(socket, msg.id ?? null, true, null);
  newTemplate('block-found').catch(e => console.error('tmpl after block:', e.message));
}

// ---------- stratum protocol ----------
function send(socket, obj) { try { socket.write(JSON.stringify(obj) + '\n'); } catch {} }
function reply(socket, id, result, error) { send(socket, { id, result, error: error || null }); }
function parseWorkerLogin(login) {
  const raw = String(login || '').trim();
  const idx = raw.indexOf('.');
  if (idx === -1) return { payout: raw, worker: 'worker' };
  return { payout: raw.slice(0, idx), worker: raw.slice(idx + 1) || 'worker' };
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket._gbx = { subscribed: false, authorized: false, payout: '', worker: '',
    extranonce1: crypto.randomBytes(EN1_SIZE).toString('hex'), diffSent: false, cb: {},
    shareDiff: SHARE_MIN_DIFF, lastRetarget: Date.now(), sharesSince: 0 };
  clients.add(socket);
  let buffer = '';
  socket.on('data', async (chunk) => {
    buffer += String(chunk || '');
    while (buffer.includes('\n')) {
      const idx = buffer.indexOf('\n');
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { reply(socket, null, null, [20, 'INVALID_JSON', null]); continue; }
      const method = msg.method || '';
      const params = Array.isArray(msg.params) ? msg.params : [];
      try {
        if (method === 'mining.subscribe') {
          socket._gbx.subscribed = true;
          reply(socket, msg.id ?? null, [[['mining.notify', 'gbx-sub']], socket._gbx.extranonce1, EN2_SIZE], null);
          continue;
        }
        if (method === 'mining.authorize') {
          const parsed = parseWorkerLogin(params[0]);
          if (!parsed.payout || !parsed.payout.startsWith('bn1')) {
            reply(socket, msg.id ?? null, false, [20, 'INVALID_WORKER_LOGIN', null]); continue;
          }
          const info = await rpc('validateaddress', [parsed.payout]);
          if (!info || !info.isvalid || !info.scriptPubKey) {
            reply(socket, msg.id ?? null, false, [20, 'INVALID_PAYOUT_ADDRESS', null]); continue;
          }
          socket._gbx.authorized = true;
          socket._gbx.payout = parsed.payout;
          socket._gbx.worker = parsed.worker;
          socket._gbx.payoutScript = info.scriptPubKey;
          try { const pw=String(params[1]||''); const m=pw.match(/d=([\d.]+)/); if(m){const dv=parseFloat(m[1]); if(dv>0) socket._gbx.shareDiff=Math.max(SHARE_MIN_DIFF,dv);} } catch {}
          reply(socket, msg.id ?? null, true, null);
          if (currentJobId) notifyClient(socket, currentJobId, true);
          continue;
        }
        if (method === 'mining.submit') {
          if (!socket._gbx.authorized) { reply(socket, msg.id ?? null, false, [24, 'UNAUTHORIZED', null]); continue; }
          await handleSubmit(socket, msg, params);
          continue;
        }
        if (method === 'mining.extranonce.subscribe') { reply(socket, msg.id ?? null, true, null); continue; }
        reply(socket, msg.id ?? null, null, [20, 'UNSUPPORTED_METHOD', null]);
      } catch (err) {
        reply(socket, msg.id ?? null, null, [20, err.message, null]);
      }
    }
  });
  const drop = () => { clients.delete(socket); };
  socket.on('error', drop);
  socket.on('close', drop);
});

// ---------- template poll loop (chain ~1.3s/block → 500ms poll) ----------
let lastPrev = '', lastTplTs = 0;
setInterval(async () => {
  try {
    const best = await rpc('getbestblockhash', []);
    const now = Date.now();
    const changed = best !== lastPrev;
    if (changed || now - lastTplTs > 30000) {
      const cur = jobs.get(currentJobId);
      if (changed && cur && cur.gbt.previousblockhash === best) { lastPrev = best; lastTplTs = now; }
      else { lastPrev = best; lastTplTs = now; await newTemplate(changed ? 'new-block' : 'refresh'); }
    }
  } catch (e) { console.error('poll:', e.message); }
}, 500);

// ---------- /pool-info (public transparency, IDEE A-style) ----------
http.createServer(async (req, res) => {
  let height = null, best = null;
  try { height = await rpc('getblockcount', []); best = await rpc('getbestblockhash', []); } catch {}
  const body = JSON.stringify({
    pool: 'GOLDBRIX Pool', mode: 'solo-noncustodial',
    fee_bps: 0,
    fee_policy: 'none - coinbase pays the miner address directly; pool never holds funds (code-is-law)',
    stratum: 'stratum+tcp://goldbrix.app:3333',
    login_format: 'bn1address.workername',
    height, best_hash: best,
    miners_connected: [...clients].filter(c => c._gbx && c._gbx.authorized).length,
    jobs_served: stats.jobs_served, shares_ok: stats.shares_ok, shares_rej: stats.shares_rej,
    rej_reasons: stats.rej_reasons,
    blocks_found: blocksFoundCount(),
    uptime_s: Math.floor(Date.now() / 1000) - stats.started, ts: Math.floor(Date.now() / 1000)
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}).listen(INFO_PORT, '0.0.0.0', () => console.log(`pool-info on :${INFO_PORT}`));

server.listen(PORT, HOST, async () => {
  console.log(`goldbrix-pool-stratum P1P listening on ${HOST}:${PORT}`);
  try { await newTemplate('startup'); } catch (e) { console.error('startup tmpl:', e.message); }
});
