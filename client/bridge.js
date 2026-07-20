const ONRAMP_API = 'https://goldbrix.app/onramp';

// Pre-fill GBX address from URL param ?gbx=...
(function() {
  try {
    const params = new URLSearchParams(window.location.search);
    const prefillGbx = params.get('gbx');
    if (prefillGbx && /^bn1q[a-z0-9]{30,50}$/i.test(prefillGbx)) {
      window.addEventListener('DOMContentLoaded', () => {
        const el = document.getElementById('gbx-addr');
        if (el) { el.value = prefillGbx; el.dispatchEvent(new Event('input')); }
      });
    }
  } catch(e) {}
})();

const btn = document.getElementById('connect');
const status = document.getElementById('status');
const mobileHint = document.getElementById('mobile-hint');
const step2 = document.getElementById('step2');
const step4 = document.getElementById('step4');
const usdcInput = document.getElementById('usdc-input');
const quoteDisplay = document.getElementById('quote-display');
const gbxAddrInput = document.getElementById('gbx-addr');
const createOrderBtn = document.getElementById('create-order-btn');
const orderDetails = document.getElementById('order-details');

let connected = false;
let userSolAddr = null;
let currentQuote = null;
let currentOrder = null;
let quoteTimer = null;

function isMobile() {
  return /Android|webOS|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(navigator.userAgent);
}
// Multi-wallet adapter (Phantom + Solflare)
const WALLETS = {
  phantom: {
    name: 'Phantom',
    icon: '👻',
    detect: () => !!(window.phantom?.solana?.isPhantom) || !!(window.solana && window.solana.isPhantom),
    getProvider: () => window.phantom?.solana || window.solana,
    deeplinkPrefix: 'https://phantom.app/ul/browse/'
  },
  solflare: {
    name: 'Solflare',
    icon: '🔥',
    detect: () => !!(window.solflare && window.solflare.isSolflare),
    getProvider: () => window.solflare,
    deeplinkPrefix: 'https://solflare.com/ul/v1/browse/'
  }
};

let activeWalletKey = null;
let activeProvider = null;
let activeChain = 'solana'; // Phase 2: chain selector state
let userPaymentAddr = null; // EVM address when MetaMask connected

const SOLANA_CHAINS = ['solana'];
const EVM_CHAINS = ['arbitrum', 'base', 'bsc'];

const EVM_CHAIN_PARAMS = {
  arbitrum: {
    chainId: '0xa4b1',
    chainName: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    blockExplorerUrls: ['https://arbiscan.io']
  },
  base: {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org']
  },
  bsc: {
    chainId: '0x38',
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.binance.org/'],
    blockExplorerUrls: ['https://bscscan.com']
  }
};

const EVM_USDC = {
  arbitrum: { contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  base:     { contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  bsc:      { contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }
};

function selectChain(chainKey) {
  if (activeChain === chainKey) return;
  // Disconnect current wallet if switching chain types
  const prevIsSolana = SOLANA_CHAINS.includes(activeChain);
  const newIsSolana = SOLANA_CHAINS.includes(chainKey);
  if (connected && prevIsSolana !== newIsSolana) {
    disconnect();
  }
  activeChain = chainKey;
  // Update active class on buttons
  document.querySelectorAll('.chain-btn').forEach(b => {
    b.classList.toggle('chain-active', b.dataset.chain === chainKey);
  });
  // Toggle wallet pickers
  const solPicker = document.getElementById('walletPicker');
  const evmPicker = document.getElementById('evmWalletPicker');
  if (newIsSolana) {
    if (solPicker) solPicker.style.display = connected ? 'none' : 'flex';
    if (evmPicker) evmPicker.style.display = 'none';
  } else {
    if (solPicker) solPicker.style.display = 'none';
    if (evmPicker) evmPicker.style.display = connected ? 'none' : 'flex';
  }
  // Update status hint
  if (status) {
    status.innerHTML = 'Selected chain: <b>' + chainKey + '</b>. Connect wallet to proceed.';
  }
}

// MetaMask Solana provider detection (multi-path because API varies by version)
function getMetaMaskSolanaProvider() {
  if (window.metamask && window.metamask.solana) return window.metamask.solana;
  if (window.phantom && window.phantom.solana && window.phantom.solana.isMetaMask) return window.phantom.solana;
  if (window.solana && window.solana.isMetaMask) return window.solana;
  return null;
}

async function connectMetaMaskSolana() {
  const provider = getMetaMaskSolanaProvider();
  if (!provider) {
    if (isMobile() && (!window.ethereum || !window.ethereum.isMetaMask)) {
      // FIX: in Capacitor APK, use public domain not localhost
      const PUBLIC_HOST='goldbrix.app';
      let dappPath = window.location.host + window.location.pathname + window.location.search;
      if (dappPath.indexOf('localhost')!==-1 || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
        dappPath = PUBLIC_HOST + window.location.pathname + window.location.search;
      }
      status.innerHTML = '<span class="warn">📱 Opening MetaMask app...</span>';
      setTimeout(() => { window.location.href = 'https://metamask.app.link/dapp/' + dappPath; }, 600);
      return;
    }
    status.innerHTML = '<span class="err">❌ MetaMask Solana provider not detected.</span><br>Update MetaMask to the latest version or use Phantom/Solflare.';
    return;
  }
  try {
    status.innerHTML = '<span class="warn">⏳ Connecting MetaMask (Solana)...</span>';
    const res = await provider.connect();
    activeWalletKey = 'metamask';
    activeProvider = provider;
    userSolAddr = (res.publicKey || provider.publicKey).toString();
    userPaymentAddr = userSolAddr;
    const solPicker = document.getElementById('walletPicker');
    if (solPicker) solPicker.style.display = 'none';
    const evmPicker = document.getElementById('evmWalletPicker');
    if (evmPicker) evmPicker.style.display = 'none';
    status.innerHTML = '<span class="ok">✅ MetaMask (Solana)</span><br>Address:<br><code>' + userSolAddr + '</code>';
    const dbtn = document.getElementById('disconnectBtn');
    if (dbtn) dbtn.style.display = 'block';
    connected = true;
    mobileHint.hidden = true;
    step2.hidden = false;
  } catch (e) {
    status.innerHTML = '<span class="err">❌ MetaMask Solana: ' + e.message + '</span>';
  }
}

async function connectMetaMask() {
  if (activeChain === 'solana') {
    return connectMetaMaskSolana();
  }
  if (!window.ethereum || !window.ethereum.isMetaMask) {
    if (isMobile()) {
      const dappPath = window.location.host + window.location.pathname + window.location.search;
      status.innerHTML = '<span class="warn">📱 Opening MetaMask app...</span>';
      setTimeout(() => { window.location.href = 'https://metamask.app.link/dapp/' + dappPath; }, 600);
      return;
    }
    status.innerHTML = '<span class="err">❌ MetaMask not detected.</span><br>Install: <a href="https://metamask.io" style="color:#f5d142">metamask.io</a>';
    return;
  }
  try {
    status.innerHTML = '<span class="warn">⏳ Connecting MetaMask...</span>';
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts || accounts.length === 0) throw new Error('No account returned');
    const cfg = EVM_CHAIN_PARAMS[activeChain];
    if (!cfg) throw new Error('No chain config for ' + activeChain);
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: cfg.chainId }]
      });
    } catch (err) {
      if (err.code === 4902) {
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [cfg] });
      } else if (err.code === 4001) {
        throw new Error('Chain switch rejected by user');
      } else { throw err; }
    }
    activeWalletKey = 'metamask';
    activeProvider = window.ethereum;
    userPaymentAddr = accounts[0];
    userSolAddr = accounts[0]; // backward compat for vars
    const evmPicker = document.getElementById('evmWalletPicker');
    if (evmPicker) evmPicker.style.display = 'none';
    const solPicker = document.getElementById('walletPicker');
    if (solPicker) solPicker.style.display = 'none';
    status.innerHTML = '<span class="ok">✅ MetaMask on ' + cfg.chainName + '</span><br>Address:<br><code>' + accounts[0] + '</code>';
    const dbtn = document.getElementById('disconnectBtn');
    if (dbtn) dbtn.style.display = 'block';
    connected = true;
    mobileHint.hidden = true;
    step2.hidden = false;
  } catch (e) {
    status.innerHTML = '<span class="err">❌ MetaMask: ' + e.message + '</span>';
  }
}

function detectInstalledWallet() {
  for (const key of Object.keys(WALLETS)) {
    if (WALLETS[key].detect()) return key;
  }
  return null;
}

function isInPhantomBrowser() {
  return WALLETS.phantom.detect();
}

function isInWalletBrowser() {
  return detectInstalledWallet() !== null;
}
function isValidGbxAddr(a) {
  return /^bn1q[a-z0-9]{30,50}$/.test((a || '').trim().toLowerCase());
}

if (isMobile() && !isInWalletBrowser()) {
  mobileHint.hidden = false;
}

async function connectWallet(walletKey) {
  const wallet = WALLETS[walletKey];
  if (!wallet) return;

  // Mobile: if wallet not detected here, deeplink to its in-app browser
  if (isMobile() && !wallet.detect()) {
    // FIX: in Capacitor APK, location is localhost — use public URL
    const PUBLIC_HOST='https://goldbrix.app';
    let dappUrl = window.location.href;
    if (dappUrl.indexOf('localhost')!==-1 || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
      dappUrl = PUBLIC_HOST + window.location.pathname + window.location.search + window.location.hash;
    }
    const ref = encodeURIComponent(PUBLIC_HOST);
    const dlUrl = wallet.deeplinkPrefix + encodeURIComponent(dappUrl) + '?ref=' + ref;
    status.innerHTML = '<span class="warn">📱 Opening ' + wallet.name + ' app...</span>';
    setTimeout(() => { window.location.href = dlUrl; }, 600);
    return;
  }
  if (!wallet.detect()) {
    status.innerHTML = '<span class="err">❌ ' + wallet.name + ' not detected.</span><br>Install: <a href="' + (walletKey === 'phantom' ? 'https://phantom.app' : 'https://solflare.com') + '" style="color:#f5d142">Get ' + wallet.name + '</a>';
    return;
  }
  try {
    status.innerHTML = '<span class="warn">⏳ Connecting to ' + wallet.name + '...</span>';
    const provider = wallet.getProvider();
    const res = await provider.connect();
    activeWalletKey = walletKey;
    activeProvider = provider;
    userSolAddr = (res.publicKey || provider.publicKey).toString();
    const picker = document.getElementById('walletPicker');
    if (picker) picker.style.display = 'none';
    status.innerHTML = '<span class="ok">✅ Connected via ' + wallet.icon + ' ' + wallet.name + '</span><br>Address:<br><code>' + userSolAddr + '</code>';
    const dbtn = document.getElementById('disconnectBtn');
    if (dbtn) dbtn.style.display = 'block';
    connected = true;
    mobileHint.hidden = true;
    step2.hidden = false;
  } catch (e) {
    status.innerHTML = '<span class="err">❌ Failed: ' + e.message + '</span>';
  }
}

// Backward-compat shim (in case anywhere else calls connect())
async function connect() {
  return connectWallet('phantom');
}

async function disconnect() {
  if (activeProvider) {
    try { await activeProvider.disconnect(); } catch (e) {}
  }
  activeWalletKey = null;
  activeProvider = null;
  status.innerHTML = 'Not connected.';
  const picker = document.getElementById('walletPicker');
  if (picker) picker.style.display = 'block';
  const dbtn = document.getElementById('disconnectBtn');
  if (dbtn) dbtn.style.display = 'none';
  connected = false;
  userSolAddr = null;
  step2.hidden = true;
  step4.hidden = true;
}

// Old single-button click handler kept as fallback to Phantom only.
if (btn) btn.addEventListener('click', () => { connected ? disconnect() : connectWallet('phantom'); });

window.addEventListener('load', async () => {
  const detectedKey = detectInstalledWallet();
  if (detectedKey) {
    const wallet = WALLETS[detectedKey];
    try {
      const provider = wallet.getProvider();
      const res = await provider.connect({ onlyIfTrusted: true });
      activeWalletKey = detectedKey;
      activeProvider = provider;
      userSolAddr = (res.publicKey || provider.publicKey).toString();
      const picker = document.getElementById('walletPicker');
      if (picker) picker.style.display = 'none';
      status.innerHTML = '<span class="ok">✅ Auto-connected via ' + wallet.icon + ' ' + wallet.name + '</span><br>Address:<br><code>' + userSolAddr + '</code>';
      const dbtn = document.getElementById('disconnectBtn');
      if (dbtn) dbtn.style.display = 'block';
      connected = true;
      mobileHint.hidden = true;
      step2.hidden = false;
    } catch (e) { /* not trusted */ }
  }
});

async function fetchQuote(amount) {
  const r = await fetch(ONRAMP_API + '/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usdc_amount: amount })
  });
  return r.json();
}

function updateOrderButtonState() {
  const hasValidQuote = currentQuote && currentQuote.gbx_output > 0;
  const hasValidAddr = isValidGbxAddr(gbxAddrInput.value);
  createOrderBtn.disabled = !(connected && hasValidQuote && hasValidAddr);
}

usdcInput.addEventListener('input', () => {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    const v = parseFloat(usdcInput.value);
    if (!v || v < 1) {
      quoteDisplay.innerHTML = '💡 Min $1 USDC';
      currentQuote = null;
      updateOrderButtonState();
      return;
    }
    if (v > 10000) {
      quoteDisplay.innerHTML = '<span class="err">Max $10,000 USDC</span>';
      currentQuote = null;
      updateOrderButtonState();
      return;
    }
    quoteDisplay.innerHTML = '⏳ Calculating...';
    try {
      const r = await fetchQuote(v);
      if (r.ok && r.quote) {
        currentQuote = r.quote;
        quoteDisplay.innerHTML =
          '<div>You pay: <b>$' + v.toFixed(2) + ' USDC</b></div>' +
          '<div>Fee (0.5%): $' + r.quote.fee_usdc + '</div>' +
          '<div>You receive: <b>' + r.quote.gbx_output + ' GBX</b></div>' +
          '<div style="opacity:0.6;font-size:11px;margin-top:4px">Rate: ' + r.quote.rate_display + '</div>';
      } else {
        quoteDisplay.innerHTML = '<span class="err">' + (r.error || 'Quote error') + '</span>';
        currentQuote = null;
      }
    } catch (e) {
      quoteDisplay.innerHTML = '<span class="err">Network: ' + e.message + '</span>';
      currentQuote = null;
    }
    updateOrderButtonState();
  }, 500);
});

gbxAddrInput.addEventListener('input', updateOrderButtonState);

createOrderBtn.addEventListener('click', async () => {
  if (!connected || !currentQuote) return;
  const gbxAddr = gbxAddrInput.value.trim();
  if (!isValidGbxAddr(gbxAddr)) {
    alert('Invalid GBX address. Must start with bn1q and be 35-54 chars.');
    return;
  }
  createOrderBtn.disabled = true;
  createOrderBtn.textContent = '⏳ Creating order...';
  try {
    const r = await fetch(ONRAMP_API + '/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        EVM_CHAINS.includes(activeChain)
          ? { chain: activeChain, usdc_amount: currentQuote.usdc_input, user_payment_address: userPaymentAddr, user_gbx_address: gbxAddr }
          : { usdc_amount: currentQuote.usdc_input, user_solana_address: userSolAddr, user_gbx_address: gbxAddr }
      )
    });
    const data = await r.json();
    if (data.ok && data.order) {
      currentOrder = data.order;
      showOrderDetails(data.order);
      createOrderBtn.textContent = '✅ Order Created';
    } else {
      alert('Order failed: ' + (data.error || 'unknown'));
      createOrderBtn.disabled = false;
      createOrderBtn.textContent = 'Create Order';
    }
  } catch (e) {
    alert('Network error: ' + e.message);
    createOrderBtn.disabled = false;
    createOrderBtn.textContent = 'Create Order';
  }
});

function showOrderDetails(o) {
  step4.hidden = false;
  orderDetails.innerHTML =
    '<div>Order ID: <code>' + o.id + '</code></div>' +
    '<div>Memo: <code>' + o.memo + '</code></div>' +
    '<div>Send: <b>$' + o.usdc_amount + ' USDC</b></div>' +
    '<div>You receive: <b>' + o.gbx_amount + ' GBX</b></div>' +
    '<div style="opacity:0.6;font-size:11px;margin-top:8px">Order expires 15min.<br>Pay via your connected wallet.</div>';
  step4.scrollIntoView({ behavior: 'smooth' });
}

// === STAGE 5c — USDC SPL transfer + status polling ===
const payBtn = document.getElementById('pay-btn');
const SOLANA_RPC = 'https://solana.publicnode.com';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TREASURY_USDC_ATA = '3CDM2VF59AzdWXGL7PERSwqN49m3J2MshatYzTTLkojZ';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const TREASURY_SOL_OWNER = '67giiRaNb6qUjX6DnSrEZc7fbgSu5zxCDXNrUAELaDWh';

let pollTimer = null;
let solanaLibs = null;

const step4Observer = new MutationObserver(() => {
  if (!step4.hidden && currentOrder && payBtn.disabled) {
    payBtn.disabled = false;
    var _w = WALLETS[activeWalletKey]; payBtn.textContent = 'Pay $' + currentOrder.usdc_amount + ' USDC via ' + (_w ? (_w.icon + ' ' + _w.name) : 'Wallet');
  }
});
step4Observer.observe(step4, { attributes: true, attributeFilter: ['hidden'] });

async function loadSolanaLibs() {
  if (solanaLibs) return solanaLibs;
  const [web3, splToken] = await Promise.all([
    import('/vendor/solana.mjs?v=1780567102'),
    import('/vendor/solana.mjs?v=1780567102')
  ]);
  solanaLibs = { web3, splToken };
  return solanaLibs;
}

async function payUSDC() {
  if (!activeProvider) { alert('No wallet connected. Click Connect first.'); return; }
  if (!currentOrder) { alert('No order created'); return; }
  const orig = payBtn.textContent;
  payBtn.disabled = true;
  try {
    payBtn.textContent = '⏳ Loading Solana libs...';
    const { web3, splToken } = await loadSolanaLibs();
    const { Connection, PublicKey, Transaction, TransactionInstruction } = web3;
    const { createTransferCheckedInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction } = splToken;

    payBtn.textContent = '⏳ Building transaction...';
    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const userPk = new PublicKey(userSolAddr);
    const usdcMint = new PublicKey(USDC_MINT);
    const treasuryAta = new PublicKey(TREASURY_USDC_ATA);
    const memoProgram = new PublicKey(MEMO_PROGRAM_ID);
    const userUsdcAta = await getAssociatedTokenAddress(usdcMint, userPk);

    const tx = new Transaction();
    tx.add(createAssociatedTokenAccountIdempotentInstruction(userPk, treasuryAta, new PublicKey(TREASURY_SOL_OWNER), usdcMint));
    const amountUnits = Math.round(currentOrder.usdc_amount * 1000000);
    tx.add(createTransferCheckedInstruction(userUsdcAta, usdcMint, treasuryAta, userPk, amountUnits, 6));
    const memoBytes = new TextEncoder().encode(currentOrder.memo);
    tx.add(new TransactionInstruction({
      keys: [{ pubkey: userPk, isSigner: true, isWritable: false }],
      programId: memoProgram,
      data: memoBytes
    }));

    const __bhr = await fetch(ONRAMP_API + '/solana/blockhash');
    const __bh = await __bhr.json();
    if (!__bh || !__bh.ok || !__bh.blockhash) throw new Error('blockhash unavailable: ' + ((__bh && __bh.detail) || 'rpc'));
    const blockhash = __bh.blockhash;
    tx.recentBlockhash = blockhash;
    tx.feePayer = userPk;

    var _w2 = WALLETS[activeWalletKey]; payBtn.textContent = '⏳ Awaiting ' + (_w2 ? _w2.name : 'wallet') + ' signature...';
    if (!activeProvider) throw new Error('No wallet connected'); const sendOpts = { skipPreflight: true, preflightCommitment: 'confirmed', maxRetries: 3 };
    const result = await activeProvider.signAndSendTransaction(tx, sendOpts);
    const sig = result.signature;

    payBtn.style.background = '#0a8c52';
    payBtn.style.color = '#fff';
    payBtn.textContent = '✅ TX broadcast';

    orderDetails.innerHTML +=
      '<div style="margin-top:12px;padding:10px;background:#0a8c52;border-radius:6px">' +
      '<div style="color:#fff;font-weight:600">✅ Solana TX broadcast</div>' +
      '<div style="font-size:11px;word-break:break-all;color:#fff;margin-top:4px">' +
      '<a href="https://solscan.io/tx/' + sig + '" target="_blank" style="color:#fff">' + sig + '</a></div></div>';

    startStatusPolling(currentOrder.id);
  } catch (e) {
    console.error('Pay error:', e);
    payBtn.disabled = false;
    payBtn.textContent = orig;
    alert('Pay error: ' + (e.message || e));
  }
}

async function payUSDC_EVM() {
  if (!activeProvider) { alert('No wallet connected'); return; }
  if (!currentOrder) { alert('No order created'); return; }
  const orig = payBtn.textContent;
  payBtn.disabled = true;
  try {
    payBtn.textContent = '⏳ Loading ethers...';
    const ethersMod = await import('/vendor/ethers.mjs?v=1780567102');
    const ethers = ethersMod.ethers || ethersMod;

    payBtn.textContent = '⏳ Building transaction...';
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();

    const usdcCfg = EVM_USDC[activeChain];
    const amountUnits = ethers.parseUnits(currentOrder.usdc_amount.toString(), usdcCfg.decimals);
    const treasuryAddr = currentOrder.treasury_address;

    const erc20Abi = ['function transfer(address to, uint256 amount) returns (bool)'];
    const contract = new ethers.Contract(usdcCfg.contract, erc20Abi, signer);

    payBtn.textContent = '⏳ Awaiting MetaMask signature...';
    const tx = await contract.transfer(treasuryAddr, amountUnits);

    payBtn.style.background = '#0a8c52';
    payBtn.style.color = '#fff';
    payBtn.textContent = '✅ TX submitted';

    const chainName = EVM_CHAIN_PARAMS[activeChain]?.chainName || activeChain;
    const explorerUrl = (currentOrder.explorer || 'https://etherscan.io') + '/tx/' + tx.hash;
    orderDetails.innerHTML +=
      '<div style="margin-top:12px;padding:10px;background:#0a8c52;border-radius:6px">' +
      '<div style="color:#fff;font-weight:600">✅ ' + chainName + ' TX submitted</div>' +
      '<div style="font-size:11px;word-break:break-all;color:#fff;margin-top:4px">' +
      '<a href="' + explorerUrl + '" target="_blank" style="color:#fff">' + tx.hash + '</a></div></div>';

    startStatusPolling(currentOrder.id);
  } catch (e) {
    console.error('Pay EVM error:', e);
    payBtn.disabled = false;
    payBtn.textContent = orig;
    alert('Pay error: ' + (e.message || e));
  }
}

function startStatusPolling(orderId) {
  if (pollTimer) return;
  pollStatus(orderId);
  pollTimer = setInterval(() => pollStatus(orderId), 5000);
}

async function pollStatus(orderId) {
  try {
    const r = await fetch(ONRAMP_API + '/order/' + orderId);
    const d = await r.json();
    if (!d.ok || !d.order) return;
    let el = document.getElementById('status-display');
    if (!el) {
      el = document.createElement('div');
      el.id = 'status-display';
      el.className = 'info-box';
      el.style.marginTop = '16px';
      step4.appendChild(el);
    }
    const o = d.order;
    let html = '<div>Status: <b>' + o.status + '</b></div>';
    if (o.solana_tx_hash) html += '<div style="font-size:11px">Solana: ' + o.solana_tx_hash.slice(0,20) + '...</div>';
    const gbxTx = o.send_tx_hash || o.gbx_tx_hash;
    if (gbxTx) html += '<div style="font-size:11px;word-break:break-all">GBX TX: ' + gbxTx + '</div>';
    el.innerHTML = html;
    if (o.status === 'sent' || o.status === 'completed') {
      el.style.background = '#0a8c52';
      el.innerHTML += '<div style="margin-top:6px;font-weight:600;color:#fff">✅ GBX sent!</div>';
      clearInterval(pollTimer); pollTimer = null;
    } else if (o.status === 'failed') {
      el.style.background = '#a8332f';
      clearInterval(pollTimer); pollTimer = null;
    }
  } catch (e) { console.error('Poll:', e); }
}

payBtn.addEventListener('click', () => { if (EVM_CHAINS.includes(activeChain)) { payUSDC_EVM(); } else { payUSDC(); } });
