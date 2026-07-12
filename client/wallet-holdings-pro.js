// === GoldBrix V4.9 PRO — Holdings: real price + sparkline + P&L + total ===
let GBX_USD_PRO = 0.10;
(async function(){try{const r=await fetch('https://goldbrix.app/onramp/gbx-price');const d=await r.json();if(d&&d.gbx_price_usd>0)GBX_USD_PRO=d.gbx_price_usd;}catch(e){}})();
function sparklineSVG(prices, color) {
  if (!prices || prices.length < 2) return '';
  const w = 56, h = 22;
  const min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
  const range = (max - min) || 1;
  const pts = prices.map(function(p, i) {
    const x = (i / (prices.length - 1)) * w;
    const y = h - ((p - min) / range) * (h - 2) - 1;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  return '<svg width="' + w + '" height="' + h + '" style="display:block;"><polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}

async function enrichOneCard(card) {
  const id = card.getAttribute('data-coinid');
  const bal = Number(card.getAttribute('data-bal')) || 0;
  const avgBuy = Number(card.getAttribute('data-avgbuy')) || 0;
  if (!id) return 0;
  const API = 'https://goldbrix.app';
  try {
    const results = await Promise.all([
      fetch(API + '/launchpad/coins/' + id + '/stats'),
      fetch(API + '/launchpad/coins/' + id + '/candles?interval=1h&limit=24')
    ]);
    const stats = await results[0].json();
    const candData = await results[1].json();
    const candles = Array.isArray(candData) ? candData : (candData.candles || candData.data || []);

    const price = Number(stats.price) || 0;
    const valGbx = bal * price;
    const valEl = card.querySelector('.mc-val');
    if (valEl) {
      valEl.textContent = valGbx > 0
        ? (valGbx >= 1 ? valGbx.toFixed(2) : valGbx.toFixed(4)) + ' GBX'
        : '—';
      // GBX — adauga $ mic dedesubt (ca wallet-view)
      var usdEl = card.querySelector('.mc-usd');
      if (!usdEl && valGbx > 0) {
        usdEl = document.createElement('div');
        usdEl.className = 'mc-usd';
        usdEl.style.cssText = 'font-size:10px;color:#888;margin-top:2px;';
        valEl.parentNode.insertBefore(usdEl, valEl.nextSibling);
      }
      if (usdEl) usdEl.textContent = valGbx > 0 ? '$' + (valGbx * GBX_USD_PRO).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '';
    }

    // P&L badge: current price vs avg buy price
    const chEl = card.querySelector('.mc-ch');
    if (chEl) {
      if (avgBuy > 0 && price > 0) {
        const pnl = (price / avgBuy - 1) * 100;
        const sign = pnl >= 0 ? '+' : '';
        const col = pnl >= 0 ? '#00C864' : '#FF6644';
        const bg = pnl >= 0 ? 'rgba(0,200,100,0.15)' : 'rgba(255,100,68,0.15)';
        chEl.textContent = 'PnL ' + sign + pnl.toFixed(1) + '%';
        chEl.style.color = col;
        chEl.style.background = bg;
        chEl.style.padding = '1px 6px';
        chEl.style.borderRadius = '8px';
      } else {
        chEl.textContent = '';
        chEl.style.background = 'transparent';
      }
    }

    // Sparkline
    const closes = candles.map(function(c){ return Number(c.close); }).filter(function(p){ return p > 0; });
    const sparkEl = card.querySelector('.mc-spark');
    if (sparkEl && closes.length >= 2) {
      const up = closes[closes.length - 1] >= closes[0];
      sparkEl.innerHTML = sparklineSVG(closes, up ? '#00C864' : '#FF6644');
    }

    card.setAttribute('data-val', valGbx);
    return valGbx;
  } catch(e) {
    const valEl = card.querySelector('.mc-val');
    if (valEl && valEl.textContent === '…') valEl.textContent = '—';
    return 0;
  }
}

async function enrichHoldings() {
  const cards = Array.prototype.slice.call(document.querySelectorAll('.my-coin-card[data-coinid]'));
  if (!cards.length) return;
  const vals = await Promise.all(cards.map(enrichOneCard));
  // Total portfolio
  const total = vals.reduce(function(a,b){ return a + (b||0); }, 0);
  const totalEl = document.getElementById('portfolioTotal');
  if (totalEl) totalEl.textContent = total > 0 ? total.toFixed(2) + ' GBX' : '— GBX';
  // GBX — total COMBINAT in header (GBX balance + memecoins)
  try {
    var gbxOnly = parseFloat(window._gbxBalance || 0) || 0;
    var combined = gbxOnly + total;
    var amtEl = document.getElementById('balanceAmount');
    var usdEl = document.getElementById('balanceUsd');
    if (false) {} /* card stays pure GBX (set by wallet.html loadPortfolio) */
    if (false) {} /* USD set by wallet.html at real price */
  } catch(e){}
  // Re-sort cards by value desc
  const list = cards[0].parentNode;
  if (list) {
    cards.sort(function(a,b){
      return (Number(b.getAttribute('data-val'))||0) - (Number(a.getAttribute('data-val'))||0);
    });
    cards.forEach(function(c){ list.appendChild(c); });
  }
}
window.enrichHoldings = enrichHoldings;

setInterval(function(){
  if (document.querySelector('.my-coin-card[data-coinid]')) enrichHoldings();
}, 60000);
