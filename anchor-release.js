// GBX Release Anchor — publishes GBX:R:<tag>:<sha256> on-chain via OP_RETURN
// Usage: GBX_CLI=goldbrix-cli GBX_DATADIR=~/.goldbrix node anchor-release.js <tag> <sha256-hex>
// Requires a wallet with a small GBX balance for the L1 fee.
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const GBX_CLI = process.env.GBX_CLI || 'goldbrix-cli';
const GBX_DATADIR = process.env.GBX_DATADIR || '';
const WALLET = process.env.GBX_WALLET || '';

async function cli(args, useWallet) {
  const a = [];
  if (GBX_DATADIR) a.push(`-datadir=${GBX_DATADIR}`);
  if (useWallet && WALLET) a.push(`-rpcwallet=${WALLET}`);
  const { stdout } = await execFileP(GBX_CLI, [...a, ...args.map(String)]);
  return stdout.trim();
}

(async () => {
  const [tag, sha] = process.argv.slice(2);
  if (!tag || !/^[0-9a-f]{64}$/.test(sha || '')) {
    console.error('usage: node anchor-release.js <tag> <64-hex-sha256>'); process.exit(1);
  }
  const msg = `GBX:R:${tag}:${sha}`;
  if (Buffer.byteLength(msg) > 80) { console.error('message > 80 bytes (tag too long)'); process.exit(1); }
  const hex = Buffer.from(msg, 'utf8').toString('hex');
  const raw = await cli(['createrawtransaction', '[]', JSON.stringify([{ data: hex }])]);
  const funded = JSON.parse(await cli(['fundrawtransaction', raw], true));
  const signed = JSON.parse(await cli(['signrawtransactionwithwallet', funded.hex], true));
  if (!signed.complete) { console.error('signing failed'); process.exit(2); }
  const txid = await cli(['sendrawtransaction', signed.hex]);
  console.log(JSON.stringify({ ok: true, txid, message: msg, fee: funded.fee }, null, 2));
})().catch(e => { console.error(e.message); process.exit(2); });
