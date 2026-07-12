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
const [
  bitcoinModule,
  bip39Module,
  bip32Module,
  eccModule
] = await Promise.all([
  import('/vendor/bitcoinjs-lib.mjs?v=1780567102'),
  import('/vendor/bip39.mjs?v=1780567102'),
  import('/vendor/bip32.mjs?v=1780567102'),
  import('/vendor/secp256k1.mjs?v=1780567102')
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

// IDEE S (client): failover per-request pe federatia LP pentru utxos + broadcast.
// Ordinea: GBX_LP_BASE (daca routerul swap a ales deja) -> toate gateway-urile din lps.json -> fallback static.
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

async function fetchUtxos(address, target) {
  const res = (target && target>0)
    ? await _lpFetchFailover(`/utxos/${address}?target=${target}`)
    : await fetch(`${API_BASE}/utxos/${address}?limit=1000`);
  if (!res.ok) throw new Error(`UTXO fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.target_unmet) { const e = new Error('MAX_PER_TX'); e.maxPerTx = data.max_per_tx; throw e; }
  return data.unspents || [];
}

async function sendGBX(mnemonic, fromAddress, toAddress, amountGbx, feeRateSatsPerByte = 30) {
  const { keypair, address: derivedAddr } = await deriveKeypairFromMnemonic(mnemonic);
  if (derivedAddr !== fromAddress) {
    throw new Error(`Mnemonic mismatch. Derived: ${derivedAddr}, Expected: ${fromAddress}`);
  }

  const utxos = await fetchUtxos(fromAddress, amountGbx + 0.01);  // CU target -> LP gateway (UTXO mari + scriptPubKey; read-api limit=1000 dadea doar 250 GBX)
  if (utxos.length === 0) throw new Error('No UTXOs available');

  // V2.21: filter immature coinbase UTXOs (must have 100+ confirmations)
  const matureUtxos = utxos.filter(u => u.spendable !== false);
  if (matureUtxos.length === 0) {
    throw new Error('No mature coins available. Mining rewards need 100 block confirmations.');
  }

  const amountSats = Math.round(amountGbx * 1e8);
  const sortedUtxos = [...matureUtxos].sort((a, b) =>
    Math.round(b.amount * 1e8) - Math.round(a.amount * 1e8)
  );

  const psbt = new bitcoin.Psbt({ network: GOLDBRIX_NETWORK });
  let totalIn = 0;
  const selectedUtxos = [];
  const estimatedFee = 1500;

  for (const utxo of sortedUtxos) {
    const utxoSats = Math.round(utxo.amount * 1e8);
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: Buffer.from(utxo.scriptPubKey, 'hex'),
        value: utxoSats
      }
    });
    selectedUtxos.push(utxo);
    totalIn += utxoSats;
    if (totalIn >= amountSats + estimatedFee) break;
  }

  if (totalIn < amountSats + estimatedFee) {
    throw new Error(`Insufficient. Have ${totalIn/1e8}, need ${(amountSats+estimatedFee)/1e8}`);
  }

  psbt.addOutput({ address: toAddress, value: amountSats });

  const estimatedSize = selectedUtxos.length * 68 + 2 * 31 + 11;
  const fee = estimatedSize * feeRateSatsPerByte;
  const change = totalIn - amountSats - fee;

  if (change > 546) {
    psbt.addOutput({ address: fromAddress, value: change });
  }

  for (let i = 0; i < selectedUtxos.length; i++) {
    psbt.signInput(i, keypair);
  }
  psbt.finalizeAllInputs();

  const _txObj = psbt.extractTransaction();
  const rawTxHex = _txObj.toHex();
  const _localTxid = (typeof _txObj.getId === 'function') ? _txObj.getId() : '';

  const broadcastRes = await _lpFetchFailover('/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawtx: rawTxHex })
  });

  if (!broadcastRes.ok) {
    const err = await broadcastRes.text();
    if (_localTxid && /-27|already in (the )?(utxo set|block ?chain)|transaction already/i.test(err)) {
      return { txid: _localTxid, rawTx: rawTxHex, fee: fee / 1e8, feeSats: fee, alreadyConfirmed: true };
    }
    try{ console.error('GBX_BROADCAST_FAIL:', err); }catch(_e){}
    throw new Error('BROADCAST_FAILED');
  }

  const result = await broadcastRes.json();
  return {
    txid: result.txid || _localTxid,
    rawTx: rawTxHex,
    fee: fee / 1e8,
    feeSats: fee
  };
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

// ============================================================
// STEP 4: Expose globally
// ============================================================

window.GoldbrixCrypto = {
  deriveAddressFromMnemonic,
  generateNewWallet,
  deriveKeypairFromMnemonic,
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
