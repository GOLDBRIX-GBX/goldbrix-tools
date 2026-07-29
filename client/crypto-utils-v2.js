// GoldBrix Crypto Utils — client-side signing
// Stack: bitcoinjs-lib + bip39 + bip32 + tiny-secp256k1
// Network: GoldBrix mainnet, bech32 'bn', P2WPKH native segwit

// ============================================================
// STEP 1: Polyfill Buffer FIRST, await it, then import the rest
// ============================================================

import { Buffer } from '/vendor/buffer.mjs';

// Set Buffer globally BEFORE any other module loads
window.Buffer = Buffer;
globalThis.Buffer = Buffer;

console.log('[GoldbrixCrypto] Buffer set globally:', typeof Buffer);

// Use dynamic imports so they load AFTER Buffer is set
// A dropped packet must not kill the wallet: every module import retries.
async function _imp(path){
  for (let a=0;a<3;a++){
    try { return await import(path+(a?('&r='+a):'')); }
    catch(e){ if(a===2) throw e; await new Promise(r=>setTimeout(r,600*(a+1))); }
  }
}
const [
  bitcoinModule,
  bip39Module,
  bip32Module,
  eccModule
] = await Promise.all([
  _imp('/vendor/bitcoinjs-lib.mjs?v=1780567102'),
  _imp('/vendor/bip39.mjs?v=1780567102'),
  _imp('/vendor/bip32.mjs?v=1780567102'),
  _imp('/vendor/secp256k1.mjs?v=1780567102')
]);

const bitcoin = bitcoinModule.default || bitcoinModule;
const bip39 = bip39Module.default || bip39Module;
const ecc = eccModule.default || eccModule;
const { BIP32Factory } = (bip32Module.default || bip32Module);

// Initialize ECC backend
bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

// ============================================================
// STEP 2: Network params
// ============================================================

const GOLDBRIX_NETWORK = {
  messagePrefix: '\x18Goldbrix Signed Message:\n',
  bech32: 'bn',
  bip32: {
    public: 0x0488B21E,
    private: 0x0488ADE4
  },
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80
};

const DERIVATION_PATH = "m/84'/0'/0'/0/0";
const API_BASE = (typeof window!=='undefined' && window.GBX_API_BASE) || 'https://goldbrix.app/api';

// Client-side per-request failover across the LP federation for utxos + broadcast.
// Order: GBX_LP_BASE (if the swap router already chose) -> all gateways from lps.json -> static fallback.
let _gbxLpList=null, _gbxLpListTs=0;
async function _lpBases(){
  const bases=[];
  try{ if(typeof window!=='undefined' && window.GBX_LP_BASE) bases.push(window.GBX_LP_BASE); }catch(_e){}
  const now=Date.now();
  if(!_gbxLpList || now-_gbxLpListTs>60000){
    try{
      const r=await fetch('/lps.json',{cache:'no-store'});
      const j=await r.json();
      _gbxLpList=(j.lps||j||[]).map(x=>x.base_url||x.base||x.gateway||x.url).filter(Boolean);
      _gbxLpListTs=now;
    }catch(_e){ _gbxLpList=_gbxLpList||[]; }
  }
  for(const b of _gbxLpList){ if(bases.indexOf(b)===-1) bases.push(b); }
  if(bases.indexOf('https://goldbrix.app/lp')===-1) bases.push('https://goldbrix.app/lp');
  return bases;
}
async function _lpFetchFailover(path, opts){
  const bases=await _lpBases();
  let lastErr=null;
  for(const b of bases){
    try{
      const res=await fetch(b+path, opts);
      if(res.ok || res.status===200){ try{ if(typeof window!=='undefined') window.GBX_LP_BASE=b; }catch(_e){} return res; }
      lastErr=new Error('HTTP '+res.status+' @ '+b);
    }catch(e){ lastErr=e; }
  }
  try{ console.error('GBX_LP_FAILOVER: toate gateway-urile au picat:', lastErr); }catch(_e){}
  const _e2=new Error('LP_UNAVAILABLE'); _e2.cause=lastErr; throw _e2;
}

// ============================================================
// STEP 3: Public functions
// ============================================================

async function deriveAddressFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed, GOLDBRIX_NETWORK);
  const child = root.derivePath(DERIVATION_PATH);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: child.publicKey,
    network: GOLDBRIX_NETWORK
  });
  return {
    address,
    publicKey: Buffer.from(child.publicKey).toString('hex'),
    derivationPath: DERIVATION_PATH
  };
}

async function deriveKeypairFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed, GOLDBRIX_NETWORK);
  const child = root.derivePath(DERIVATION_PATH);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: child.publicKey,
    network: GOLDBRIX_NETWORK
  });
  return {
    keypair: child,
    address,
    publicKey: child.publicKey,
    privateKey: child.privateKey
  };
}

async function _fedReadUtxos(address, target){
  /* Federated read layer first: any live node from the on-chain registry. */
  if (typeof window==='undefined' || !window.GBXRead) return null;
  try { if (window.GBXReady) await window.GBXReady; } catch(_e){}
  try {
    const est = (target && target>0) ? Math.ceil(target/0.25)+400 : 1000;
    const lim = Math.min(24000, Math.max(1000, est));
    const d = await window.GBXRead.json('/api/utxos/'+address+'?limit='+lim, {timeout:120000});
    const uns = (d && d.unspents) || [];
    if (!uns.length) return null;
    return uns;
  } catch(_e){ return null; }
}

async function _fedBroadcast(rawtx){
  /* Any live federated node can accept the transaction; the LP gateway is only a fallback. */
  if (typeof window==='undefined') return null;
  try { if (window.GBXReady) await window.GBXReady; } catch(_e){}
  const nodes=(window.GBX_NODES||[]).slice();
  for (const n of nodes){
    let r, body;
    try {
      r = await fetch(String(n).replace(/\/+$/,'')+'/broadcast', {method:'POST', cache:'no-store', headers:{'Content-Type':'application/json'}, body:JSON.stringify({rawtx:rawtx})});
      body = await r.json().catch(function(){return null;});
    } catch(_e){ continue; }
    const id = body && (body.txid || body.tx_hash);
    if (id) return id;
  }
  return null;
}

async function fetchUtxos(address, target) {
  const fed = await _fedReadUtxos(address, target);
  if (fed) return fed;
  const res = (target && target>0)
    ? await _lpFetchFailover('/utxos/'+address+'?target='+target)
    : await fetch(API_BASE+'/utxos/'+address+'?limit=1000');
  if (!res.ok) throw new Error('UTXO fetch failed: '+res.status);
  const data = await res.json();
  if (data.target_unmet) { const e = new Error('MAX_PER_TX'); e.maxPerTx = data.max_per_tx; throw e; }
  return data.unspents || [];
}

async function sendGBX(mnemonic, fromAddress, toAddress, amountGbx, feeRateSatsPerByte = 30, onProgress = null) {
  const { keypair, address: derivedAddr } = await deriveKeypairFromMnemonic(mnemonic);
  if (derivedAddr !== fromAddress) {
    throw new Error(`Mnemonic mismatch. Derived: ${derivedAddr}, Expected: ${fromAddress}`);
  }

  const utxos = await fetchUtxos(fromAddress, amountGbx + 0.05);
  if (utxos.length === 0) throw new Error('No UTXOs available');

  const matureUtxos = utxos.filter(u => u.spendable !== false);
  if (matureUtxos.length === 0) {
    throw new Error('No mature coins available. Mining rewards need 100 block confirmations.');
  }

  const sorted = [...matureUtxos].sort((a, b) =>
    Math.round(b.amount * 1e8) - Math.round(a.amount * 1e8)
  );

  /* The wallet splits a large amount into as many chained transactions as
     needed (disjoint inputs, broadcast one after another) so the user never
     sees a per-transaction cap. */
  const MAX_INPUTS = 1200;
  let remainingSats = Math.round(amountGbx * 1e8);
  let idx = 0;
  const txids = [];
  let totalFeeSats = 0;

  while (remainingSats > 0) {
    if (idx >= sorted.length) {
      const e = new Error('INSUFFICIENT');
      e.shortGbx = remainingSats / 1e8; e.txids = txids.slice();
      throw e;
    }
    const psbt = new bitcoin.Psbt({ network: GOLDBRIX_NETWORK });
    const batch = [];
    let totalIn = 0;
    while (idx < sorted.length && batch.length < MAX_INPUTS) {
      const u = sorted[idx];
      const sat = Math.round(u.amount * 1e8);
      psbt.addInput({
        hash: u.txid, index: u.vout,
        witnessUtxo: { script: Buffer.from(u.scriptPubKey, 'hex'), value: sat }
      });
      batch.push(u); totalIn += sat; idx++;
      const feeNow = (batch.length * 68 + 2 * 31 + 11) * feeRateSatsPerByte;
      if (totalIn >= remainingSats + feeNow) break;
    }
    const fee = (batch.length * 68 + 2 * 31 + 11) * feeRateSatsPerByte;
    const sendSats = Math.min(remainingSats, totalIn - fee);
    if (sendSats <= 546) {
      const e = new Error('INSUFFICIENT');
      e.shortGbx = remainingSats / 1e8; e.txids = txids.slice();
      throw e;
    }
    psbt.addOutput({ address: toAddress, value: sendSats });
    const change = totalIn - sendSats - fee;
    if (change > 546) psbt.addOutput({ address: fromAddress, value: change });
    for (let i = 0; i < batch.length; i++) psbt.signInput(i, keypair);
    psbt.finalizeAllInputs();
    const txObj = psbt.extractTransaction();
    const rawTxHex = txObj.toHex();
    const localTxid = (typeof txObj.getId === 'function') ? txObj.getId() : '';

    let txid = await _fedBroadcast(rawTxHex);
    if (!txid) {
      const res = await _lpFetchFailover('/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawtx: rawTxHex })
      });
      if (!res.ok) {
        const err = await res.text();
        if (localTxid && /-27|already in (the )?(utxo set|block ?chain)|transaction already/i.test(err)) {
          txid = localTxid;
        } else {
          try{ console.error('GBX_BROADCAST_FAIL:', err); }catch(_e){}
          const e = new Error(txids.length ? 'PARTIAL_SEND' : 'BROADCAST_FAILED');
          e.txids = txids.slice();
          e.sentGbx = (Math.round(amountGbx * 1e8) - remainingSats) / 1e8;
          throw e;
        }
      } else {
        const j = await res.json().catch(() => null);
        txid = (j && j.txid) || localTxid;
      }
    }
    txids.push(txid);
    remainingSats -= sendSats;
    totalFeeSats += fee;
    if (typeof onProgress === 'function') {
      try { onProgress({ sentGbx: (Math.round(amountGbx * 1e8) - remainingSats) / 1e8, totalGbx: amountGbx, txids: txids.slice() }); } catch (_e) {}
    }
  }

  return { txid: txids[txids.length - 1], txids: txids, batches: txids.length, fee: totalFeeSats / 1e8, feeSats: totalFeeSats };
}

/**
 * Generate a NEW BIP39 mnemonic (12 words, valid checksum)
 * Returns object with mnemonic + derived address + private key
 */
async function generateNewWallet() {
  const mnemonic = bip39.generateMnemonic(128);
  const { address, publicKey } = await deriveAddressFromMnemonic(mnemonic);
  return { mnemonic, address, publicKey };
}

// ============================================================
// AES-GCM ENCRYPTION (Investor-grade self-custody)
// PBKDF2 100K iterations + AES-256-GCM
// ============================================================

function _bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) arr[i / 2] = parseInt(hex.substr(i, 2), 16);
  return arr;
}

function generateSalt() {
  return _bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = _hexToBytes(saltHex);
  const pwdBytes = enc.encode(password);
  const combined = new Uint8Array(salt.length + pwdBytes.length);
  combined.set(salt);
  combined.set(pwdBytes, salt.length);
  const hashBuf = await crypto.subtle.digest('SHA-256', combined);
  return _bytesToHex(new Uint8Array(hashBuf));
}

async function _deriveAesKey(password, saltHex) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: _hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptString(plaintext, password, saltHex) {
  if (!plaintext) return null;
  const key = await _deriveAesKey(password, saltHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  return { iv: _bytesToHex(iv), ct: _bytesToHex(new Uint8Array(cipherBuf)) };
}

async function decryptString(encrypted, password, saltHex) {
  if (!encrypted || !encrypted.iv || !encrypted.ct) return null;
  const key = await _deriveAesKey(password, saltHex);
  const dec = new TextDecoder();
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: _hexToBytes(encrypted.iv) },
    key,
    _hexToBytes(encrypted.ct)
  );
  return dec.decode(plainBuf);
}

// An account is identified by its public key: the address is one of its
// projections and cannot be reversed back into a key. Deriving the address
// from a key is therefore always possible, offline, with no network and no
// server - which is why the key is the identifier used across the app.
function addressFromPublicKey(pubkeyHex) {
  const hex = String(pubkeyHex || '').toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(hex)) return null;
  try {
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(hex, 'hex'),
      network: GOLDBRIX_NETWORK
    });
    return address || null;
  } catch (e) { return null; }
}

// ============================================================
// STEP 4: Expose globally
// ============================================================

window.GoldbrixCrypto = {
  deriveAddressFromMnemonic,
  generateNewWallet,
  deriveKeypairFromMnemonic,
  addressFromPublicKey,
  fetchUtxos,
  sendGBX,
  network: GOLDBRIX_NETWORK,
  // Encryption (AES-GCM + PBKDF2)
  generateSalt,
  hashPassword,
  encryptString,
  decryptString
};

console.log('[GoldbrixCrypto] Library loaded. window.GoldbrixCrypto ready.');
