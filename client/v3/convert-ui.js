/* GOLDBRIX · convert-ui.js · ON-RAMP Convert UI (SPA-safe, 5 limbi, fallback agregatoare keyless)
   Leaga: mod-b-onramp-sol.mjs (Jupiter+Raydium) + mod-b-onramp-evm.mjs (ParaSwap+KyberSwap)
   Non-custodial: user semneaza, agregator executa. Istoric tip CONVERT. */
(function(){
  // ---- i18n 5 limbi (regula 8) ----
  var L = {
    en:{title:'Convert',pick:'Choose what to convert:',pay:'You pay',get:'You receive',min:'Min received',via:'Via',back:'Back',go:'Convert',
        working:'Converting…',quoting:'Getting best rate…',signing:'Sign in your wallet…',
        done:'Done! Funds are in your wallet.',
        unavail:'Conversion is temporarily unavailable on this network — try another network or come back in a few minutes.',
        have:'You have:',noamt:'Enter an amount.',nobal:'Not enough balance for this conversion.',nofee:'Insufficient {sym} for network fees — keep at least ~{min} {sym} in your wallet on top of the converted amount.',soon:'Coming soon'},
    ro:{title:'Conversie',pick:'Alege ce convertești:',pay:'Plătești',get:'Primești',min:'Minim primit',via:'Prin',back:'Înapoi',go:'Convertește',
        working:'Se convertește…',quoting:'Se caută cel mai bun curs…',signing:'Semnează în portofel…',
        done:'Gata! Fondurile sunt în portofel.',
        unavail:'Conversia e temporar indisponibilă pe această rețea — încearcă altă rețea sau revino în câteva minute.',
        have:'Ai:',noamt:'Introdu o sumă.',nobal:'Sold insuficient pentru această conversie.',nofee:'{sym} insuficient pentru taxele rețelei — păstrează minim ~{min} {sym} în portofel peste suma convertită.',soon:'În curând'},
    de:{title:'Umwandeln',pick:'Wähle, was umgewandelt wird:',pay:'Du zahlst',get:'Du erhältst',min:'Mindestens',via:'Über',back:'Zurück',go:'Umwandeln',
        working:'Wird umgewandelt…',quoting:'Bester Kurs wird gesucht…',signing:'In der Wallet signieren…',
        done:'Fertig! Guthaben ist in deiner Wallet.',
        unavail:'Umwandlung auf diesem Netzwerk vorübergehend nicht verfügbar — versuche ein anderes Netzwerk oder komme später wieder.',
        have:'Du hast:',noamt:'Betrag eingeben.',nobal:'Unzureichendes Guthaben für diese Umwandlung.',nofee:'Nicht genug {sym} für Netzwerkgebühren — behalte mindestens ~{min} {sym} zusätzlich zum umgewandelten Betrag in der Wallet.',soon:'Demnächst'},
    zh:{title:'兑换',pick:'选择要兑换的：',pay:'支付',get:'收到',min:'最少收到',via:'通过',back:'返回',go:'兑换',
        working:'兑换中…',quoting:'正在获取最佳汇率…',signing:'在钱包中签名…',
        done:'完成！资金已到账。',
        unavail:'此网络暂时无法兑换 — 请尝试其他网络或稍后再来。',
        have:'你有：',noamt:'请输入金额。',nobal:'余额不足，无法完成此兑换。',nofee:'{sym} 不足以支付网络费用 — 请在兑换金额之外，钱包中至少保留约 {min} {sym}。',soon:'即将推出'},
    ar:{title:'تحويل',pick:'اختر ما تريد تحويله:',pay:'تدفع',get:'تستلم',min:'الحد الأدنى',via:'عبر',back:'رجوع',go:'تحويل',
        working:'جارٍ التحويل…',quoting:'جارٍ الحصول على أفضل سعر…',signing:'وقّع في محفظتك…',
        done:'تم! الأموال في محفظتك.',
        unavail:'التحويل غير متاح مؤقتًا على هذه الشبكة — جرّب شبكة أخرى أو عد بعد دقائق.',
        have:'لديك:',noamt:'أدخل مبلغًا.',nobal:'الرصيد غير كافٍ لهذا التحويل.',nofee:'رصيد {sym} لا يكفي لرسوم الشبكة — احتفظ بما لا يقل عن ~{min} {sym} في محفظتك فوق المبلغ المحوَّل.',soon:'قريبًا'}
  };
  function lang(){ try{ return localStorage.getItem('gbx_lang')||'en'; }catch(e){ return 'en'; } }
  function t(k){ var l=L[lang()]||L.en; return l[k]||L.en[k]||k; }

  // ---- Cele 6 rute (ambele sensuri). Solana live (Jupiter+Raydium). EVM live (ParaSwap+KyberSwap). ----
  var ROUTES = [
    {id:'sol_usdc', chain:'solana',   from:'SOL',  to:'USDC', dir:'native2usdc', icon:'◎', col:'#9945FF'},
    {id:'usdc_sol', chain:'solana',   from:'USDC', to:'SOL',  dir:'usdc2native', icon:'◎', col:'#9945FF'},
    {id:'eth_usdc_base', chain:'base',     from:'ETH',  to:'USDC', dir:'native2usdc', icon:'⬡', col:'#0052FF'},
    {id:'usdc_eth_base', chain:'base',     from:'USDC', to:'ETH',  dir:'usdc2native', icon:'⬡', col:'#0052FF'},
    {id:'eth_usdc_arb',  chain:'arbitrum', from:'ETH',  to:'USDC', dir:'native2usdc', icon:'◆', col:'#28A0F0'},
    {id:'usdc_eth_arb',  chain:'arbitrum', from:'USDC', to:'ETH',  dir:'usdc2native', icon:'◆', col:'#28A0F0'}
  ];
  var _cur=null, _quoteTimer=null, _lastQuote=null;
  var _cvAgg="jupiter"; // solana: user alege jupiter/raydium (default jupiter dovedit)

  // ---- Deschide/inchide modal (SPA-safe: display flex/none, ca addWalletModal) ----
  window.openConvertModal=function(){
    var m=document.getElementById('convertModal'); if(!m) return;
    document.getElementById('cvTitle').textContent=t('title');
    document.getElementById('cvPick').textContent=t('pick');
    renderRoutes();
    document.getElementById('cvRoutes').style.display='block';
    document.getElementById('cvSwap').style.display='none';
    m.style.display='flex';
  };
  window.closeConvertModal=function(){ var m=document.getElementById('convertModal'); if(m)m.style.display='none'; _cur=null; };
  window.cvBackToRoutes=function(){
    document.getElementById('cvSwap').style.display='none';
    document.getElementById('cvRoutes').style.display='block';
    _cur=null;
  };

  function renderRoutes(){
    var html='';
    for(var i=0;i<ROUTES.length;i++){ var r=ROUTES[i];
      html+='<div onclick="cvSelectRoute(\''+r.id+'\')" style="display:flex;align-items:center;gap:12px;padding:13px;background:#241d14;border-radius:12px;margin-bottom:8px;cursor:pointer;border:1px solid transparent;" '
        +'onmouseover="this.style.borderColor=\'#F0C060\'" onmouseout="this.style.borderColor=\'transparent\'">'
        +'<div style="width:32px;height:32px;border-radius:50%;background:'+r.col+'22;color:'+r.col+';display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;">'+r.icon+'</div>'
        +'<div style="flex:1;font-size:14px;font-weight:700;color:#fff;font-family:JetBrains Mono,monospace;">'+r.from+' <span style="color:#F0C060;">&rarr;</span> '+r.to+'</div>'
        +'<div style="font-size:10px;color:#777;">'+chainName(r.chain)+'</div>'
        +'</div>';
    }
    document.getElementById('cvRouteList').innerHTML=html;
  }
  function chainName(c){ return c==='solana'?'Solana':c==='base'?'Base':c==='arbitrum'?'Arbitrum':c; }

  // ---- Citeste balanta activului de platit (per ruta) ----
  var RPCS = { base:'https://mainnet.base.org', arbitrum:'https://arb1.arbitrum.io/rpc', solana:'https://api.mainnet-beta.solana.com' };
  var USDC_EVM = { base:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arbitrum:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831' };
  var USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  async function evmRpc(chain, method, params){
    var r=await fetch(RPCS[chain],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:method,params:params})});
    var j=await r.json(); return j.result;
  }
  async function solRpc(method, params){
    var r=await fetch(RPCS.solana,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:method,params:params})});
    var j=await r.json(); return j.result;
  }
  function _getMnemonic(){
    try{ if(window.GBXSession){ var w=GBXSession.activeWallet(); if(w&&w.mnemonic) return w.mnemonic; } }catch(e){}
    try{ var u=JSON.parse(sessionStorage.getItem('gbx_unlocked_wallets')||'null');
      if(u&&u.wallets){ var rw=u.wallets[u.activeWalletId]||u.wallets[Object.keys(u.wallets)[0]]; if(rw&&rw.mnemonic) return rw.mnemonic; } }catch(e){}
    return null;
  }
  var RPCS={ base:'https://mainnet.base.org', arbitrum:'https://arb1.arbitrum.io/rpc', solana:'https://api.mainnet-beta.solana.com' };
  var USDC_EVM={ base:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arbitrum:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831' };
  var USDC_SOL='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  async function readBalance(route){
    // 1) Daca gbxBalances exista (chain-balances a rulat), foloseste-l - instant
    try{ var B=window.gbxBalances;
      if(B&&B[route.chain]&&B[route.chain][route.from]!=null) return Number(B[route.chain][route.from])||0;
    }catch(e){}
    // 2) Fallback robust: derivez din mnemonic + RPC direct
    try{
      var mn=_getMnemonic(); if(!mn) return 0;
      if(route.chain==='solana'){
        var sol=await window.GoldbrixMultichain.deriveSOL(mn);
        if(route.from==='SOL'){
          var r=await fetch(RPCS.solana,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[sol.address]})});
          var j=await r.json(); return (j.result&&j.result.value!=null)?(j.result.value/1e9):0;
        } else {
          var r2=await fetch(RPCS.solana,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenAccountsByOwner',params:[sol.address,{mint:USDC_SOL},{encoding:'jsonParsed'}]})});
          var j2=await r2.json(); var v=j2.result&&j2.result.value;
          if(v&&v.length) return Number(v[0].account.data.parsed.info.tokenAmount.uiAmount)||0; return 0;
        }
      } else {
        var ev=await window.GoldbrixMultichain.deriveEVM(mn);
        if(route.from==='ETH'){
          var r3=await fetch(RPCS[route.chain],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBalance',params:[ev.address,'latest']})});
          var j3=await r3.json(); return Number(BigInt(j3.result||'0x0'))/1e18;
        } else {
          var d='0x70a08231000000000000000000000000'+ev.address.replace(/^0x/,'').toLowerCase();
          var r4=await fetch(RPCS[route.chain],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:USDC_EVM[route.chain],data:d},'latest']})});
          var j4=await r4.json(); return Number(BigInt(j4.result||'0x0'))/1e6;
        }
      }
    }catch(e){}
    return 0;
  }
  var _curBal=0;
  window.cvSelectRoute=function(id){
    _cur=ROUTES.filter(function(r){return r.id===id;})[0]; if(!_cur) return;
    document.getElementById('cvRoutes').style.display='none';
    document.getElementById('cvSwap').style.display='block';
    document.getElementById('cvRouteLabel').textContent=_cur.from+' → '+_cur.to+' · '+chainName(_cur.chain);
    document.getElementById('cvYouPay').textContent=t('pay')+' ('+_cur.from+')';
    document.getElementById('cvYouGet').textContent=t('get')+' ('+_cur.to+')';
    document.getElementById('cvMinLbl').textContent=t('min');
    document.getElementById('cvViaLbl').textContent=t('via');
    document.getElementById('cvBack').textContent=t('back');
    document.getElementById('cvGoBtn').textContent=t('go');
    document.getElementById('cvAmount').value='';
    document.getElementById('cvOut').textContent='—';
    document.getElementById('cvMin').textContent='—';
    document.getElementById('cvVia').textContent='—';
    hideMsg();
    var inp=document.getElementById('cvAmount');
    inp.oninput=function(){ scheduleQuote(); };
    // sold real + procente
    var balRow=document.getElementById('cvBalRow');
    if(!balRow){ var inpEl=document.getElementById('cvAmount'); if(inpEl){ balRow=document.createElement('div'); balRow.id='cvBalRow'; balRow.style.cssText='font-size:13px;margin-bottom:8px;font-family:JetBrains Mono,monospace;'; inpEl.parentNode.insertBefore(balRow,inpEl); } }
    if(!balRow){ return; }
    balRow.innerHTML='<span style="color:#d4c590;">'+t('have')+' …</span>';
    // SELECTOR AGREGATOR (doar solana): Jupiter / Raydium
    _cvAgg='jupiter';
    var oldSel=document.getElementById('cvAggRow'); if(oldSel) oldSel.remove();
    if(_cur.chain==='solana'){
      var aggRow=document.createElement('div'); aggRow.id='cvAggRow';
      aggRow.style.cssText='display:flex;gap:8px;margin-bottom:10px;font-family:JetBrains Mono,monospace;';
      aggRow.innerHTML='<span style="color:#d4c590;font-size:12px;align-self:center;">'+t('via')+':</span>'
        +'<button id="cvAggJup" onclick="cvSetAgg(\'jupiter\')" style="flex:1;padding:7px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;background:rgba(240,192,96,0.18);border:1px solid #F0C060;color:#F0C060;">Jupiter</button>'
        +'<button id="cvAggRay" onclick="cvSetAgg(\'raydium\')" style="flex:1;padding:7px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;background:transparent;border:1px solid #3a3025;color:#888;">Raydium</button>';
      balRow.parentNode.insertBefore(aggRow, balRow);
    }
    readBalance(_cur).then(function(b){
      _curBal=b;
      balRow.innerHTML='<span style="color:#d4c590;">'+t('have')+' </span><span style="color:#F0C060;font-weight:700;">'+fmt(b)+' '+_cur.from+'</span>'
        +'<span style="float:right;">'
        +'<button onclick="cvPct(10)" style="background:rgba(240,192,96,0.12);border:1px solid rgba(240,192,96,0.35);color:#F0C060;border-radius:6px;padding:2px 8px;font-size:10px;font-weight:700;cursor:pointer;margin-left:4px;font-family:JetBrains Mono,monospace;">10%</button>'
        +'<button onclick="cvPct(50)" style="background:rgba(240,192,96,0.12);border:1px solid rgba(240,192,96,0.35);color:#F0C060;border-radius:6px;padding:2px 8px;font-size:10px;font-weight:700;cursor:pointer;margin-left:4px;font-family:JetBrains Mono,monospace;">50%</button>'
        +'<button onclick="cvPct(100)" style="background:rgba(240,192,96,0.12);border:1px solid rgba(240,192,96,0.35);color:#F0C060;border-radius:6px;padding:2px 8px;font-size:10px;font-weight:700;cursor:pointer;margin-left:4px;font-family:JetBrains Mono,monospace;">100%</button>'
        +'</span>';
    });
  };
  window.cvSetAgg=function(a){
    _cvAgg=a;
    var j=document.getElementById('cvAggJup'), r=document.getElementById('cvAggRay');
    if(j&&r){
      var on='rgba(240,192,96,0.18)', onB='#F0C060', off='transparent', offB='#3a3025', offC='#888';
      j.style.background=(a==='jupiter'?on:off); j.style.borderColor=(a==='jupiter'?onB:offB); j.style.color=(a==='jupiter'?onB:offC);
      r.style.background=(a==='raydium'?on:off); r.style.borderColor=(a==='raydium'?onB:offB); r.style.color=(a==='raydium'?onB:offC);
    }
    scheduleQuote(); // re-quote cu noul agregator
  };
  window.cvPct=function(p){
    if(!(_curBal>0)) return;
    var amt=_curBal*p/100;
    // la 100% native, las putin pt gaz (0.5% sau min)
    if(p===100 && (_cur.from==='SOL'||_cur.from==='ETH')) amt=amt*0.99;
    document.getElementById('cvAmount').value=(_cur.from==='USDC')?amt.toFixed(2):amt.toFixed(6);
    scheduleQuote();
  };

  function scheduleQuote(){
    clearTimeout(_quoteTimer);
    _quoteTimer=setTimeout(doQuote,350);
  }
  function showMsg(txt,kind){
    var e=document.getElementById('cvMsg'); e.style.display='block'; e.textContent=txt;
    if(kind==='err'){ e.style.background='rgba(255,100,68,0.12)'; e.style.color='#FF8866'; }
    else if(kind==='ok'){ e.style.background='rgba(240,192,96,0.12)'; e.style.color='#F0C060'; }
    else { e.style.background='rgba(240,160,48,0.12)'; e.style.color='#F0A030'; }
  }
  function hideMsg(){ var e=document.getElementById('cvMsg'); if(e)e.style.display='none'; }

  async function doQuote(){
    var v=parseFloat(document.getElementById('cvAmount').value); if(!(v>0)){ document.getElementById('cvOut').textContent='—'; document.getElementById('cvMin').textContent='—'; return; }
    hideMsg();
    document.getElementById('cvOut').textContent='…';
    try{
      var q=await getQuote(_cur,v);
      _lastQuote=q;
      hideMsg();
      document.getElementById('cvOut').textContent=fmt(q.out)+' '+_cur.to;
      document.getElementById('cvMin').textContent=fmt(q.minOut)+' '+_cur.to;
      document.getElementById('cvVia').textContent=q.via;
      hideMsg(); // rata valida -> ascunde orice mesaj de eroare rezidual
    }catch(e){
      // eroare tranzitorie: pastreaza rata veche daca exista, arata unavail DOAR daca chiar n-avem nimic
      if(!_lastQuote){
        document.getElementById('cvOut').textContent='—';
        showMsg(t('unavail'),'err');
      }
      // daca _lastQuote exista (rata anterioara valida), nu speria userul pt un hopa tranzitoriu
    }
  }
  function fmt(n){ return (Number(n)||0).toLocaleString(undefined,{maximumFractionDigits:6}); }

  // ---- QUOTE prin module (Solana: Jupiter+Raydium · EVM: ParaSwap+KyberSwap) ----
  async function getQuote(route, amount){
    var w=null; try{ if(window.GBXSession){ w=GBXSession.activeWallet(); } if(!w){ var _u=JSON.parse(sessionStorage.getItem('gbx_unlocked_wallets')||'null'); if(_u && _u.wallets){ w=_u.wallets[_u.activeWalletId] || _u.wallets[Object.keys(_u.wallets)[0]]; } } }catch(_e){}
    if(route.chain==='solana'){
      var mod=window.GoldbrixOnrampSol; if(!mod) throw new Error('sol-mod');
      var SOLM="So11111111111111111111111111111111111111112", USDCM="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      if(_cvAgg==='raydium'){
        if(route.dir==='native2usdc'){
          var rq=await mod.quoteRaydium(SOLM,USDCM,Math.round(amount*1e9),50);
          return { out:rq.outAmount, minOut:rq.minOut, via:'Raydium', _raw:rq, _kind:'ray_n2u' };
        } else {
          var rq2=await mod.quoteRaydium(USDCM,SOLM,Math.round(amount*1e6),50);
          return { out:rq2.outAmount, minOut:rq2.minOut, via:'Raydium', _raw:rq2, _kind:'ray_u2n' };
        }
      }
      if(route.dir==='native2usdc'){
        var lamports=Math.round(amount*1e9);
        var qq=await mod.quoteSolToUsdc(lamports,50);
        return { out:qq.outUsdc, minOut:qq.minOutUsdc, via:'Jupiter', _raw:qq, _kind:'sol_n2u' };
      } else {
        var qx=await mod.quoteUsdcToSol(Math.round(amount*1e6),50);
        return { out:qx.outSol, minOut:qx.minOutSol, via:'Jupiter', _raw:qx, _kind:'sol_u2n' };
      }
    } else {
      var modE=window.GoldbrixOnrampEvm; if(!modE) throw new Error('evm-mod');
      var NATIVE=modE.EVM_NATIVE, C=modE.EVM_ONRAMP_CHAINS[route.chain];
      var src,dst,amtWei,outDec;
      if(route.dir==='native2usdc'){ src=NATIVE; dst=C.usdc; amtWei=String(Math.round(amount*1e18)); outDec=6; }
      else { src=C.usdc; dst=NATIVE; amtWei=String(Math.round(amount*1e6)); outDec=18; }
      var addr=(w&&w.address)||'0x0000000000000000000000000000000000000000';
      var qe=await modE.quoteEvm(route.chain,src,dst,amtWei,addr);
      return { out:qe.outAmount, minOut:qe.outAmount*0.99, via:qe._agg.name, _raw:qe, _kind:'evm' };
    }
  }

  // ---- verificare on-chain: succes DOAR daca tx e minata cu status 0x1 (regula 7+9) ----
  async function _evmReceipt(chain, hash){
    if(!hash || String(hash).slice(0,2)!=='0x' || String(hash).length<10) return {ok:false,reason:'no-hash'};
    for(var i=0;i<40;i++){
      try{ var rc=await evmRpc(chain,'eth_getTransactionReceipt',[hash]);
        if(rc && rc.status!=null){ return {ok:(rc.status==='0x1'),reason:rc.status}; } }catch(e){}
      await new Promise(function(r){ setTimeout(r,3000); });
    }
    return {ok:false,reason:'timeout'};
  }

  // ---- EXECUTA conversia (user semneaza, agregator executa, istoric CONVERT) ----
  window.cvExecute=async function(){
    var v=parseFloat(document.getElementById('cvAmount').value);
    if(!(v>0)){ showMsg(t('noamt'),'err'); return; }
    // garda onesta: sursa nativa trebuie sa acopere suma + taxele retelei (mesaj real, nu "revino mai tarziu")
    try{
      var _rsv=0, _sym='';
      if(_cur && _cur.chain==='solana' && _cur.from==='SOL'){ _rsv=0.004; _sym='SOL'; }
      else if(_cur && _cur.chain!=='solana' && _cur.from==='ETH'){ _rsv=0.0002; _sym='ETH'; }
      if(_rsv>0 && (v+_rsv)>_curBal){
        showMsg(t('nofee').replace(/\{sym\}/g,_sym).replace(/\{min\}/g,String(_rsv)),'err'); return;
      }
    }catch(_g){}
    if(!_lastQuote){ showMsg(t('unavail'),'err'); return; }
    var btn=document.getElementById('cvGoBtn'); var orig=btn.textContent; btn.disabled=true; btn.textContent=t('working');
    showMsg(t('signing'),'info');
    try{
      var w=null; try{ if(window.GBXSession){ w=GBXSession.activeWallet(); } if(!w){ var _u=JSON.parse(sessionStorage.getItem('gbx_unlocked_wallets')||'null'); if(_u && _u.wallets){ w=_u.wallets[_u.activeWalletId] || _u.wallets[Object.keys(_u.wallets)[0]]; } } }catch(_e){}
      var sig;
      if(_cur.chain==='solana'){
        var mod=window.GoldbrixOnrampSol;
        var deriv=await window.GoldbrixMultichain.deriveSOL(w.mnemonic);
        var kp=mod.solKeypairFromDerive(deriv); try{ window._cvOwner=(deriv&&deriv.address)||''; }catch(_o){}
        var SOLM2="So11111111111111111111111111111111111111112", USDCM2="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        var res;
        if(_cvAgg==='raydium'){
          res=await mod.swapRaydium({solKeypair:kp,
            inMint:(_cur.dir==='native2usdc'?SOLM2:USDCM2),
            outMint:(_cur.dir==='native2usdc'?USDCM2:SOLM2),
            amount:(_cur.dir==='native2usdc'?Math.round(v*1e9):Math.round(v*1e6)),
            slippageBps:50,onStatus:function(s){}});
        } else {
          res=await (_cur.dir==='native2usdc'
            ? mod.swapSolToUsdc({solKeypair:kp,solAmountLamports:Math.round(v*1e9),slippageBps:50,onStatus:function(s){}})
            : mod.swapUsdcToSol({solKeypair:kp,usdcAmount:Math.round(v*1e6),slippageBps:50,onStatus:function(s){}}));
        }
        sig=res.sig; if(!sig) throw new Error('sol-no-sig');
      } else {
        var modE=window.GoldbrixOnrampEvm;
        var ev=await window.GoldbrixMultichain.deriveEVM(w.mnemonic);
        var C2=modE.EVM_ONRAMP_CHAINS[_cur.chain];
        var rpc=window.GoldbrixEVMSend.makeRPC(C2.rpc);
        var evmSend=window.GoldbrixEVMSend.makeEVMSend({rpc:rpc,evm:window.GoldbrixEVM,chainId:C2.id});
        var pk=ev.privateKey||ev.priv||ev.secretKey; // cheia derivata a userului
        try{ window._cvOwner=ev.address; }catch(_o){}
        var signer={ address:ev.address, signAndSend:async function(tx){
          // _sendRaw DOVEDIT (acelasi ca send.html): semneaza cu cheia userului, broadcast la RPC
          var rc=await evmSend._sendRaw(pk, tx.to, tx.data, BigInt(tx.value||'0'));
          return (rc&&(rc.transactionHash||rc.hash))||'';
        }};
        var NATIVE=modE.EVM_NATIVE, C=modE.EVM_ONRAMP_CHAINS[_cur.chain];
        var src,dst,amtWei;
        if(_cur.dir==='native2usdc'){ src=NATIVE; dst=C.usdc; amtWei=String(Math.round(v*1e18)); }
        else { src=C.usdc; dst=NATIVE; amtWei=String(Math.round(v*1e6)); }
        var r2=await modE.swapEvm({chain:_cur.chain,srcTok:src,dstTok:dst,amountWei:amtWei,signer:signer,onStatus:function(s){}});
        sig=r2.sig;
          showMsg(t('working'),'info');
          var _rcp=await _evmReceipt(_cur.chain, sig);
          if(!_rcp.ok){ throw new Error('evm-onchain-'+_rcp.reason); }
      }
      // ISTORIC tip CONVERT (acelasi format ca GBX_BUY/SELL)
      try{
        var h=JSON.parse(localStorage.getItem('gbx_swaps_history')||'[]');
        var _own=''; try{ _own=(window._cvOwner||'').toLowerCase(); }catch(_o){}
        h.unshift({type:'CONVERT',chain:_cur.chain,cv_from:_cur.from,cv_to:_cur.to,owner:_own,
          cv_in:v,cv_out:_lastQuote.out,via:_lastQuote.via,tx_hash:sig||'',timestamp:Date.now(),status:'completed'});
        localStorage.setItem('gbx_swaps_history',JSON.stringify(h.slice(0,100)));
      }catch(e){}
      showMsg(t('done'),'ok');
      setTimeout(function(){ closeConvertModal(); try{ if(window.gbxRefresh_wallet_silent){ window.gbxRefresh_wallet_silent(); } else if(window.gbxRefresh_wallet){ window.gbxRefresh_wallet(); } }catch(e){} },1400);
    }catch(e){
      showMsg(t('unavail'),'err');
      try{console.error('CV_EXEC_ERR',e);}catch(_x){}
    }
    btn.disabled=false; btn.textContent=orig;
  };
})();
