// GBX Node Announce — publishes GBX:HTLC:<https-url> on-chain via OP_RETURN.
// Anti-spam: L1 fee + liveness window (re-announce every ~200k blocks or expire).
// Usage: GBX_CLI=goldbrix-cli GBX_DATADIR=... [GBX_WALLET=...] node announce-htlc.js <chain:address[:from_block]>
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
  const url = process.argv[2];
  if (!url || !/^[a-z0-9]{2,16}:(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(:[0-9]{1,12})?$/.test(url)) {
    console.error('usage: node announce-htlc.js <chain:address[:from_block]>  (https only)'); process.exit(1);
  }
  const msg = `GBX:HTLC:${url}`;
  if (Buffer.byteLength(msg) > 80) { console.error('message > 80 bytes (url too long)'); process.exit(1); }
  const hex = Buffer.from(msg, 'utf8').toString('hex');
  const raw = await cli(['createrawtransaction', '[]', JSON.stringify([{ data: hex }])]);
  const funded = JSON.parse(await cli(['fundrawtransaction', raw], true));
  const signed = JSON.parse(await cli(['signrawtransactionwithwallet', funded.hex], true));
  if (!signed.complete) { console.error('signing failed'); process.exit(2); }
  const txid = await cli(['sendrawtransaction', signed.hex]);
  console.log(JSON.stringify({ ok: true, txid, message: msg, fee: funded.fee }, null, 2));
})().catch(e => { console.error(e.message); process.exit(2); });
