// chain-balances.js v2 — GOLDBRIX multi-chain holdings reader (CLIENT-SIDE, non-custodial)
// Auto-trigger (nu depinde de timing hook). O fraza BIP39 -> SOL + EVM, RPC publice cu failover.
(function () {
  'use strict';
  var RPC = {
    base: ['https://base-rpc.publicnode.com', 'https://base-mainnet.public.blastapi.io', 'https://mainnet.base.org'],
    arb:  ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
    bsc:  ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org'],
    sol:  ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com']
  };
  var USDC = {
    base: { c: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', d: 6, label: 'Base', nat: 'ETH' },
    arb:  { c: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', d: 6, label: 'Arbitrum', nat: 'ETH' },
    bsc:  { c: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', d: 18, label: 'BNB Chain', nat: 'BNB' }
  };
  var SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  var SPL_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  async function rpc(urls, body) {
    for (var i = 0; i < urls.length; i++) {
      try {
        var r = await fetch(urls[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) continue;
        var j = await r.json();
        if (j && j.result !== undefined) return j.result;
      } catch (e) {}
    }
    return null;
  }
  function dec(h, d) { if (!h || h === '0x') return 0; try { return Number(BigInt(h)) / Math.pow(10, d); } catch (e) { return 0; } }
  async function evmNative(urls, a) { return dec(await rpc(urls, { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [a, 'latest'] }), 18); }
  async function evmUsdc(urls, a, c, d) {
    var data = '0x70a08231000000000000000000000000' + a.slice(2).toLowerCase();
    return dec(await rpc(urls, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: c, data: data }, 'latest'] }), d);
  }
  async function solBalances(a) {
    var lr = await rpc(RPC.sol, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [a] });
    var sol = lr == null ? 0 : ((lr.value != null ? lr.value : lr) / 1e9);
    var usdc = 0, others = 0;
    // USDC SPL via deterministic ATA (free, no paid indexer): derive the ATA + getTokenAccountBalance
    try {
      var S = await import('/vendor/solana.mjs');
      var ata = (await S.getAssociatedTokenAddress(new S.PublicKey(SOL_USDC_MINT), new S.PublicKey(a))).toBase58();
      var tb = await rpc(RPC.sol, { jsonrpc: '2.0', id: 1, method: 'getTokenAccountBalance', params: [ata] });
      if (tb && tb.value && tb.value.uiAmount != null) usdc = tb.value.uiAmount;
    } catch (e) {}
    return { sol: sol, usdc: usdc, others: others };
  }

  function fmtNum(n) { if (!n) return '0'; if (n < 0.0001) return Number(n).toExponential(2); return Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 }); }
  function fmtUsd(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  var ICONS = { SOL:'sol', USDC:'usdc', ETH:'eth', BNB:'bnb' };
  function iconFor(b){ var f=ICONS[b]; return f ? '<img src="/v3/icons/'+f+'.svg?v=1" alt="'+b+'" style="width:100%;height:100%;border-radius:50%;display:block;object-fit:cover;" />' : '<span style="font-size:11px;font-weight:800;color:var(--gold);">'+b+'</span>'; }
  function row(name, badge, amount, usd) {
    return '<div class="token-row">' +
      '<div class="token-row__icon">' + iconFor(badge) + '</div>' +
      '<div class="token-row__info"><div class="token-row__name">' + name + '</div><div class="token-row__balance">' + amount + '</div></div>' +
      '<div class="token-row__value"><div class="token-row__usd">' + (usd != null ? '$' + fmtUsd(usd) : '\u2014') + '</div></div>' +
    '</div>';
  }
  function heading(label) { return '<div class="section-heading"><span class="section-heading__label">' + label + '</span></div>'; }

  function getActiveWallet() {
    try {
      var u = JSON.parse(sessionStorage.getItem('gbx_unlocked_wallets') || 'null');
      if (!u || !u.wallets) return null;
      return u.wallets.find(function (w) { return w.id === u.activeWalletId; }) || u.wallets[0] || null;
    } catch (e) { return null; }
  }
  async function deriveAddrs(mnemonic) {
    var t = 0;
    while (!(window.GoldbrixMultichain && window.GoldbrixMultichain.deriveEVM) && t < 100) { await sleep(100); t++; }
    if (!(window.GoldbrixMultichain && window.GoldbrixMultichain.deriveEVM)) return null;
    try {
      var evm = await window.GoldbrixMultichain.deriveEVM(mnemonic);
      var sol = await window.GoldbrixMultichain.deriveSOL(mnemonic);
      return { evm: evm.address, sol: sol.address };
    } catch (e) { return null; }
  }

  var inflight = false;
  window.loadChainBalances = async function (activeWallet) {
    try {
      if (inflight) return;
      activeWallet = activeWallet || getActiveWallet();
      if (!activeWallet || !activeWallet.mnemonic) return;
      var list = document.getElementById('tokensList');
      if (!list) return;
      inflight = true;
      var addrs = await deriveAddrs(activeWallet.mnemonic);
      if (!addrs) { inflight = false; return; }

      var res = await Promise.all([
        solBalances(addrs.sol).catch(function () { return { sol: 0, usdc: 0, others: 0 }; }),
        evmNative(RPC.base, addrs.evm).catch(function () { return 0; }),
        evmUsdc(RPC.base, addrs.evm, USDC.base.c, USDC.base.d).catch(function () { return 0; }),
        evmNative(RPC.arb, addrs.evm).catch(function () { return 0; }),
        evmUsdc(RPC.arb, addrs.evm, USDC.arb.c, USDC.arb.d).catch(function () { return 0; }),
        evmNative(RPC.bsc, addrs.evm).catch(function () { return 0; }),
        evmUsdc(RPC.bsc, addrs.evm, USDC.bsc.c, USDC.bsc.d).catch(function () { return 0; })
      ]);
      var solR = res[0];
      var evmData = [['base', res[1], res[2]], ['arb', res[3], res[4]], ['bsc', res[5], res[6]]];

      var html = '';
      var solRows = '';
      if (solR.sol > 0) solRows += row('SOL', 'SOL', fmtNum(solR.sol) + ' SOL', null);
      if (solR.usdc > 0) solRows += row('USDC', 'USDC', fmtNum(solR.usdc) + ' USDC', solR.usdc);
      if (solR.others > 0) solRows += row('+' + solR.others + ' Solana tokens', 'SPL', '\u2014', null);
      if (solRows) html += heading('Solana') + solRows;

      var evmRows = '';
      for (var k = 0; k < evmData.length; k++) {
        var key = evmData[k][0], n = evmData[k][1], u = evmData[k][2], meta = USDC[key];
        if (n > 0) evmRows += row(meta.nat + ' (' + meta.label + ')', meta.nat, fmtNum(n) + ' ' + meta.nat, null);
        if (u > 0) evmRows += row('USDC (' + meta.label + ')', 'USDC', fmtNum(u) + ' USDC', u);
      }
      if (evmRows) html += heading('Ethereum & EVM') + evmRows;

      // Honest note (5 languages): what GoldBrix displays vs what stays in the wallet
      var _lang='en'; try{ _lang=(localStorage.getItem('gbx_lang')||localStorage.getItem('lang')||document.documentElement.lang||navigator.language||'en'); }catch(e){}
      var _L=['en','ro','de','zh','ar'].indexOf(_lang.slice(0,2).toLowerCase())>=0?_lang.slice(0,2).toLowerCase():'en';
      var _NOTE={
        en:'GoldBrix shows GBX, your memecoins, USDC and native gas. Other assets stay safe in your wallet \u2014 they are simply not listed here.',
        ro:'GoldBrix afi\u0219eaz\u0103 GBX, memecoinii t\u0103i, USDC \u0219i gazul nativ. Alte active r\u0103m\u00e2n \u00een siguran\u021b\u0103 \u00een portofelul t\u0103u \u2014 doar nu sunt listate aici.',
        de:'GoldBrix zeigt GBX, deine Memecoins, USDC und natives Gas. Andere Werte bleiben sicher in deiner Wallet \u2013 sie werden hier nur nicht angezeigt.',
        zh:'GoldBrix \u663e\u793a GBX\u3001\u60a8\u7684 meme \u5e01\u3001USDC \u548c\u539f\u751f Gas\u3002\u5176\u4ed6\u8d44\u4ea7\u5b89\u5168\u5730\u4fdd\u5b58\u5728\u60a8\u7684\u94b1\u5305\u4e2d\uff0c\u53ea\u662f\u672a\u5728\u6b64\u5904\u5217\u51fa\u3002',
        ar:'\u064a\u0639\u0631\u0636 GoldBrix \u0639\u0645\u0644\u0629 GBX \u0648\u0639\u0645\u0644\u0627\u062a \u0627\u0644\u0645\u064a\u0645 \u0627\u0644\u062e\u0627\u0635\u0629 \u0628\u0643 \u0648USDC \u0648\u0627\u0644\u063a\u0627\u0632 \u0627\u0644\u0623\u0635\u0644\u064a. \u062a\u0628\u0642\u0649 \u0627\u0644\u0623\u0635\u0648\u0644 \u0627\u0644\u0623\u062e\u0631\u0649 \u0622\u0645\u0646\u0629 \u0641\u064a \u0645\u062d\u0641\u0638\u062a\u0643 \u2014 \u0644\u0643\u0646\u0647\u0627 \u063a\u064a\u0631 \u0645\u062f\u0631\u062c\u0629 \u0647\u0646\u0627.'
      };
      var _rtl=(_L==='ar')?' direction:rtl;':'';
      html += '<div class="chain-note" style="font-size:10px;color:#8a8170;padding:10px 16px 4px;line-height:1.5;text-align:center;'+_rtl+'">'+_NOTE[_L]+'</div>';

      var old = document.getElementById('chainHoldings');
      var wrap = document.createElement('div');
      wrap.id = 'chainHoldings';
      wrap.innerHTML = html;
      // Expun soldurile brute pentru alte module (Convert) - non-custodial, doar citire
      try{
        window.gbxBalances = {
          solana:{ SOL: solR.sol||0, USDC: solR.usdc||0 },
          base:{ ETH: res[1]||0, USDC: res[2]||0 },
          arbitrum:{ ETH: res[3]||0, USDC: res[4]||0 }
        };
      }catch(_e){}
      window._gbxChainHtml = html;
      if (old) { old.replaceWith(wrap); }
      else { var _g = list.querySelector('.token-row'); if (_g) _g.insertAdjacentElement('afterend', wrap); else list.appendChild(wrap); }
      inflight = false;
    } catch (e) { inflight = false; if (window.console) console.error('[chain-balances]', e); }
  };

  // AUTO-TRIGGER: when tokensList has the GBX row and chainHoldings does not exist yet -> run
  function tryRender() {
    var list = document.getElementById('tokensList');
    var aw = getActiveWallet();
    if (list && list.querySelector('.token-row') && aw && aw.mnemonic && !document.getElementById('chainHoldings')) {
      if (window._gbxChainHtml) {
        var w = document.createElement('div'); w.id='chainHoldings'; w.innerHTML=window._gbxChainHtml;
        var g = list.querySelector('.token-row'); if (g) g.insertAdjacentElement('afterend', w); else list.appendChild(w);
      }
      if (!inflight) window.loadChainBalances(aw);
    }
  }
  setInterval(tryRender, 1000);
  // AUTO-REFRESH balances every 30s (no manual page refresh)
  setInterval(function(){
    var aw = getActiveWallet();
    if (aw && aw.mnemonic && document.getElementById('chainHoldings') && !inflight) {
      var old = document.getElementById('chainHoldings');
      window.loadChainBalances(aw);
    }
  }, 30000);
  if (document.readyState !== 'loading') tryRender();
  else document.addEventListener('DOMContentLoaded', tryRender);
})();
