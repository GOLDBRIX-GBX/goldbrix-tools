// GBX STATE checkpoint verifier (third-party)
// Usage: node verify-state.js <balances.txt> <merkle16-from-chain>
// balances.txt: address:balance (8 decimals), one per line, sorted by address
const crypto = require('crypto');
const fs = require('fs');

const [file, expected] = process.argv.slice(2);
if (!file || !/^[0-9a-f]{16}$/.test(expected || '')) {
  console.error('usage: node verify-state.js <balances.txt> <merkle16>'); process.exit(1);
}
const data = fs.readFileSync(file, 'utf8').trim();
const got = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
console.log(got === expected ? `MATCH ${got}` : `MISMATCH got=${got} expected=${expected}`);
process.exit(got === expected ? 0 : 2);
