// GOLDBRIX — a coin is born of WORK, not of money.
// Mines and verifies the 80-byte near-block proof a CREATE must carry:
//   version(4 LE) | prevhash(32 internal) | merkle=coin_id(32) | time(4 LE) | bits(4 LE) | nonce(4 LE)
// BigInt mirror of consensus CheckCreatePoW + DeriveTarget. Same module runs
// in Node, the browser, and a Web Worker. No keys, no network.
import { sha256 } from '/vendor/gbx-hash.mjs';

export const CREATE_POW_LEN   = 80;
export const CREATE_POW_SHIFT = 5;          // target = network target << 5, clamped
export const CREATE_POW_MAX_AGE = 100;      // blocks (enforced by the node vs prev height)
export const VERSION_AUXPOW   = 0x100;      // forbidden on the proof
export const POWLIMIT_MAIN = BigInt('0x0000ffff00000000000000000000000000000000000000000000000000000000');

const sha256d = b => sha256(sha256(b));

// uint256 compare semantics: bytes are little-endian → integer.
export function hashToBig(h32){
  let x = 0n;
  for (let i = 31; i >= 0; i--) x = (x << 8n) | BigInt(h32[i]);
  return x;
}

// Exact mirror of DeriveTarget (SetCompact + negative/zero/overflow/limit guards).
export function deriveTarget(nBits, powLimit){
  const size = nBits >>> 24;
  const word = nBits & 0x007fffff;
  let t;
  if (size <= 3) t = BigInt(word >>> (8 * (3 - size)));
  else           t = BigInt(word) << BigInt(8 * (size - 3));
  const negative = word !== 0 && (nBits & 0x00800000) !== 0;
  const overflow = word !== 0 && (size > 34 || (word > 0xff && size > 33) || (word > 0xffff && size > 32));
  if (negative || t === 0n || overflow || t > powLimit) return null;
  return t;
}

// Exact mirror of the SHIFT easing loop (clamp at powLimit; 256-bit overflow guard).
export function easedTarget(nBits, powLimit){
  const base = deriveTarget(nBits, powLimit);
  if (base === null) return null;
  const MAX = (1n << 256n) - 1n;
  let t = base;
  for (let i = 0; i < CREATE_POW_SHIFT; i++){
    const nt = (t << 1n) & MAX;
    if ((nt >> 1n) !== t || nt > powLimit){ t = powLimit; break; }
    t = nt;
  }
  if (t > powLimit) t = powLimit;
  return t;
}

const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };

// prevHashDisplayHex = RPC display order (big-endian); header stores internal (reversed).
export function buildHeader({version=0x20000000, prevHashDisplayHex, coinId, time, nBits, nonce=0}){
  if ((version & VERSION_AUXPOW) !== 0) throw new Error('auxpow bit forbidden on a create proof');
  if (coinId.length !== 32) throw new Error('coin_id must be 32 bytes');
  const prev = Uint8Array.from(prevHashDisplayHex.match(/../g).map(x=>parseInt(x,16))).reverse();
  const h = new Uint8Array(CREATE_POW_LEN);
  h.set(le32(version), 0); h.set(prev, 4); h.set(coinId, 36);
  h.set(le32(time ?? Math.floor(Date.now()/1000)), 68);
  h.set(le32(nBits), 72); h.set(le32(nonce), 76);
  return h;
}

// Verify — byte-for-byte the consensus rules (freshness is the node's, vs prev height).
export function verifyPow(pow80, coinId, nBits, powLimit=POWLIMIT_MAIN){
  if (pow80.length !== CREATE_POW_LEN) return 'bad length';
  const dv = new DataView(pow80.buffer, pow80.byteOffset);
  if ((dv.getUint32(0, true) & VERSION_AUXPOW) !== 0) return 'auxpow forbidden';
  for (let i = 0; i < 32; i++) if (pow80[36+i] !== coinId[i]) return 'merkle != coin_id';
  const t = easedTarget(nBits, powLimit);
  if (t === null) return 'bad nBits';
  if (hashToBig(sha256d(pow80)) > t) return 'insufficient work';
  return null; // null = OK
}

// Mine: brute-force the nonce. Async, yields every `batch` hashes so a Worker/UI
// stays responsive; onProgress(hashes) for the bar; abort() to stop cleanly.
export async function minePow({coinId, prevHashDisplayHex, nBits, powLimit=POWLIMIT_MAIN,
                               version=0x20000000, batch=50000, onProgress=null, isAborted=null}){
  const target = easedTarget(nBits, powLimit);
  if (target === null) throw new Error('bad nBits');
  const hdr = buildHeader({version, prevHashDisplayHex, coinId, nBits});
  const dv = new DataView(hdr.buffer);
  let hashes = 0;
  for (let nonce = 0; nonce <= 0xFFFFFFFF; nonce++){
    dv.setUint32(76, nonce, true);
    if (hashToBig(sha256d(hdr)) <= target) return { pow80: hdr.slice(), nonce, hashes: hashes+1 };
    hashes++;
    if (hashes % batch === 0){
      if (isAborted && isAborted()) return null;
      if (onProgress) onProgress(hashes);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  // nonce space exhausted (astronomically unlikely at SHIFT=5): caller re-mines with fresh time/prev
  return null;
}
