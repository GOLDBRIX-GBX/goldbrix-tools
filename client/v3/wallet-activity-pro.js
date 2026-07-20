// === GoldBrix V4.9 — Wallet Activity (all tx types, 5 langs, clickable modal, auto-refresh) ===
(function(){
  const API = 'https://goldbrix.app';
  const I18N = {
    en:{title:'RECENT TRANSACTIONS',loading:'Loading...',empty:'No transactions yet',BUY:'Bought',SELL:'Sold',XFER_SENT:'Sent',XFER_RECEIVED:'Received',GBX_SENT:'Sent GBX',GBX_RECEIVED:'Received GBX',PROMOTE:'Promoted',GBX_BUY:'Bought GBX',GBX_SELL:'Sold GBX',CONVERT:'Converted',USDC_RECEIVED:'Received USDC',to:'to',from:'from',now:'now',m:'m',h:'h',d:'d',w:'w',details:'TRANSACTION DETAILS',status:'Status',success:'Success',pending:'Pending',trade:'TRADE',close:'CLOSE',txid:'TX ID',tapCopy:'tap to copy',copied:'Copied!',amount:'Amount',when:'Date',buyGbx:'BUY GBX',sellGbx:'SELL GBX',promoteBtn:'PROMOTE',viewExp:'View on Explorer ↗',chainBase:'Base'},
    ro:{title:'TRANZACȚII RECENTE',loading:'Se încarcă...',empty:'Nu există tranzacții',BUY:'Cumpărat',SELL:'Vândut',XFER_SENT:'Trimis',XFER_RECEIVED:'Primit',GBX_SENT:'GBX Trimis',GBX_RECEIVED:'GBX Primit',PROMOTE:'Promovat',GBX_BUY:'GBX Cumpărat',GBX_SELL:'GBX Vândut',CONVERT:'Convertit',USDC_RECEIVED:'USDC Primit',to:'către',from:'de la',now:'acum',m:'m',h:'h',d:'z',w:'săpt',details:'DETALII TRANZACȚIE',status:'Status',success:'Succes',pending:'În așteptare',trade:'TRANZACȚIONEAZĂ',close:'ÎNCHIDE',txid:'TX ID',tapCopy:'apasă pt copiere',copied:'Copiat!',amount:'Sumă',when:'Data',buyGbx:'CUMPĂRĂ GBX',sellGbx:'VINDE GBX',promoteBtn:'PROMOVEAZĂ',viewExp:'Vezi în Explorer ↗',chainBase:'Base'},
    de:{title:'LETZTE TRANSAKTIONEN',loading:'Lädt...',empty:'Keine Transaktionen',BUY:'Gekauft',SELL:'Verkauft',XFER_SENT:'Gesendet',XFER_RECEIVED:'Erhalten',GBX_SENT:'GBX Gesendet',GBX_RECEIVED:'GBX Erhalten',PROMOTE:'Beworben',GBX_BUY:'GBX Gekauft',GBX_SELL:'GBX Verkauft',CONVERT:'Umgewandelt',USDC_RECEIVED:'USDC Erhalten',to:'an',from:'von',now:'jetzt',m:'m',h:'Std',d:'T',w:'W',details:'TRANSAKTIONSDETAILS',status:'Status',success:'Erfolg',pending:'Ausstehend',trade:'HANDELN',close:'SCHLIESSEN',txid:'TX ID',tapCopy:'zum Kopieren tippen',copied:'Kopiert!',amount:'Betrag',when:'Datum',buyGbx:'GBX KAUFEN',sellGbx:'GBX VERKAUFEN',promoteBtn:'BEWERBEN',viewExp:'Im Explorer ansehen ↗',chainBase:'Base'},
    zh:{title:'最近交易',loading:'加载中...',empty:'暂无交易',BUY:'买入',SELL:'卖出',XFER_SENT:'已发送',XFER_RECEIVED:'已收到',GBX_SENT:'已发送GBX',GBX_RECEIVED:'已收到GBX',PROMOTE:'已推广',GBX_BUY:'买入GBX',GBX_SELL:'卖出GBX',CONVERT:'已兑换',USDC_RECEIVED:'收到USDC',to:'至',from:'来自',now:'刚才',m:'分',h:'时',d:'天',w:'周',details:'交易详情',status:'状态',success:'成功',pending:'待确认',trade:'交易',close:'关闭',txid:'交易ID',tapCopy:'点击复制',copied:'已复制!',amount:'金额',when:'日期',buyGbx:'购买 GBX',sellGbx:'出售 GBX',promoteBtn:'推广',viewExp:'在浏览器中查看 ↗',chainBase:'Base'},
    ar:{title:'المعاملات الأخيرة',loading:'جار التحميل...',empty:'لا توجد معاملات',BUY:'شراء',SELL:'بيع',XFER_SENT:'مرسل',XFER_RECEIVED:'مستلم',GBX_SENT:'GBX مرسل',GBX_RECEIVED:'GBX مستلم',PROMOTE:'مُروّج',GBX_BUY:'شراء GBX',GBX_SELL:'بيع GBX',CONVERT:'تم التحويل',USDC_RECEIVED:'USDC مستلم',to:'إلى',from:'من',now:'الآن',m:'د',h:'س',d:'ي',w:'أ',details:'تفاصيل المعاملة',status:'الحالة',success:'نجح',pending:'قيد الانتظار',trade:'تداول',close:'إغلاق',txid:'معرف TX',tapCopy:'اضغط للنسخ',copied:'تم النسخ!',amount:'المبلغ',when:'التاريخ',buyGbx:'شراء GBX',sellGbx:'بيع GBX',promoteBtn:'ترويج',viewExp:'عرض في المستكشف ↗',chainBase:'Base'}
  };
  function lang(){ return localStorage.getItem('gbx_lang') || localStorage.getItem('goldbrix_lang') || 'en'; }
  function t(k){ const l=lang(); return (I18N[l]&&I18N[l][k]) || I18N.en[k] || k; }
  function fmtNum(n){ n=Number(n)||0; const a=Math.abs(n); if(a>=1e9)return (n/1e9).toFixed(2)+'B'; if(a>=1e6)return (n/1e6).toFixed(2)+'M'; if(a>=1e3)return (n/1e3).toFixed(1)+'K'; if(a>=1)return n.toFixed(2); return n.toFixed(4); }
  function fmtGbx(n){ n=Math.abs(Number(n)||0); return n>=1?n.toFixed(2):n.toFixed(4); }
  function timeAgo(ts){ if(!ts)return ''; const s=Math.floor((Date.now()-ts)/1000); if(s<60)return t('now'); if(s<3600)return Math.floor(s/60)+t('m'); if(s<86400)return Math.floor(s/3600)+t('h'); if(s<604800)return Math.floor(s/86400)+t('d'); return Math.floor(s/604800)+t('w'); }
  function shortAddr(a){ return a ? (a.slice(0,8)+'…'+a.slice(-4)) : ''; }
  function cfg(type){
    const C={BUY:{i:'↘',c:'#00C864',b:'rgba(0,200,100,0.12)'},SELL:{i:'↗',c:'#FF6644',b:'rgba(255,100,68,0.12)'},XFER_SENT:{i:'↗',c:'#F0A030',b:'rgba(240,160,48,0.12)'},XFER_RECEIVED:{i:'↙',c:'#3498DB',b:'rgba(52,152,219,0.12)'},GBX_SENT:{i:'↗',c:'#F0A030',b:'rgba(240,160,48,0.12)'},GBX_RECEIVED:{i:'↙',c:'#3498DB',b:'rgba(52,152,219,0.12)'},PROMOTE:{i:'★',c:'#A855F7',b:'rgba(168,85,247,0.12)'},GBX_BUY:{i:'$',c:'#00C864',b:'rgba(0,200,100,0.12)'},GBX_SELL:{i:'$',c:'#FF6644',b:'rgba(255,100,68,0.12)'},USDC_RECEIVED:{i:'↙',c:'#3498DB',b:'rgba(52,152,219,0.12)'},CONVERT:{i:'⇄',c:'#00E5D4',b:'rgba(0,229,212,0.14)'}};
    return C[type]||{i:'•',c:'#888',b:'rgba(136,136,136,0.1)'};
  }
  function lines(a){
    const tk=a.ticker||''; let main='', sub='';
    if(a.type==='BUY'){ main='$'+tk; sub='+'+fmtNum(a.coin_amount)+' '+tk+' · −'+fmtGbx(a.gbx_amount)+' GBX'; }
    else if(a.type==='SELL'){ main='$'+tk; sub='−'+fmtNum(a.coin_amount)+' '+tk+' · +'+fmtGbx(a.gbx_amount)+' GBX'; }
    else if(a.type==='XFER_SENT'){ main='$'+tk; sub='−'+fmtNum(a.amount)+' '+tk+' · '+t('to')+' '+shortAddr(a.to); }
    else if(a.type==='XFER_RECEIVED'){ main='$'+tk; sub='+'+fmtNum(a.amount)+' '+tk+' · '+t('from')+' '+shortAddr(a.from); }
    else if(a.type==='GBX_SENT'){ main='GBX'; sub='−'+fmtGbx(a.amount)+' GBX · '+t('to')+' '+shortAddr(a.counterparty); }
    else if(a.type==='GBX_RECEIVED'){ main='GBX'; sub='+'+fmtGbx(a.amount)+' GBX · '+t('from')+' '+shortAddr(a.counterparty); }
    else if(a.type==='PROMOTE'){ main='$'+tk; sub='−'+fmtGbx(a.paid_gbx)+' GBX ($'+(Number(a.paid_usd)||0).toFixed(0)+') · '+(a.tier||''); }
    else if(a.type==='GBX_BUY'){ main='GBX'; sub='+'+fmtGbx(a.gbx_amount)+' GBX · '+(Number(a.usdc)||0).toFixed(2)+' USDC'; }
    else if(a.type==='GBX_SELL'){ main='GBX'; var _g=Number(a.gbx_amount)||0; sub=(_g>0?('−'+fmtGbx(_g)+' GBX · '):'')+'+'+(Number(a.usdc)||0).toFixed(2)+' USDC'; }
    else if(a.type==='CONVERT'){ main=(a.cv_from||'')+' → '+(a.cv_to||''); sub='−'+fmtNum(a.cv_in)+' '+(a.cv_from||'')+' · +'+fmtNum(a.cv_out)+' '+(a.cv_to||'')+' · '+(a.chain==='solana'?'Solana':a.chain==='arbitrum'?'Arbitrum':a.chain==='bsc'?'BNB':'Base')+(a.via?(' · '+a.via):''); }
    else if(a.type==='USDC_RECEIVED'){ main='USDC'; sub='+'+(Number(a.usdc)||0).toFixed(2)+' USDC · '+t('from')+' '+t('chainBase'); }
    return {main, sub};
  }
  function rowHtml(a, idx){
    const c=cfg(a.type), label=t(a.type), time=timeAgo(a.timestamp);
    const L=lines(a);
    return '<div data-idx="'+idx+'" class="gbx-act-row" style="display:flex;align-items:center;gap:11px;padding:11px 13px;background:#241d14;border-radius:12px;margin-bottom:6px;cursor:pointer;transition:background 0.15s;">'
      +'<div style="width:34px;height:34px;border-radius:50%;background:'+c.b+';color:'+c.c+';display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;flex-shrink:0;">'+c.i+'</div>'
      +'<div style="flex:1;min-width:0;">'
        +'<div style="display:flex;align-items:center;gap:6px;"><span style="font-size:12px;font-weight:700;color:'+c.c+';">'+label+'</span><span style="font-size:12px;font-weight:800;color:#F5CC75;font-family:JetBrains Mono,monospace;">'+L.main+'</span></div>'
        +'<div style="font-size:10px;color:#999;margin-top:2px;font-family:JetBrains Mono,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+L.sub+'</div>'
      +'</div>'
      +'<div style="font-size:10px;color:#777;flex-shrink:0;font-family:JetBrains Mono,monospace;">'+time+'</div>'
      +'</div>';
  }
  // === Modal ===
  function openModal(a){
    const c=cfg(a.type), L=lines(a);
    const isMeme = a.coin_id && a.ticker && a.ticker!=='GBX';
    const st = (a.status==='pending') ? ('⏳ '+t('pending')) : ('✓ '+t('success'));
    const stColor = (a.status==='pending') ? '#F0A030' : '#00C864';
    const dt = a.timestamp ? new Date(a.timestamp).toLocaleString() : '';
    const hash = a.tx_hash || '';
    let html='<div id="gbxActModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:flex-end;justify-content:center;" onclick="if(event.target===this)this.remove()">'
      +'<div style="background:#1a140d;border:1px solid #3a3025;border-radius:18px 18px 0 0;width:100%;max-width:460px;padding:20px 18px 28px;font-family:system-ui,sans-serif;">'
      +'<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">'
        +'<div style="width:40px;height:40px;border-radius:50%;background:'+c.b+';color:'+c.c+';display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;">'+c.i+'</div>'
        +'<div><div style="font-size:15px;font-weight:800;color:'+c.c+';">'+t(a.type)+' '+L.main+'</div>'
        +'<div style="font-size:12px;color:'+stColor+';font-weight:700;margin-top:2px;">'+st+'</div></div>'
      +'</div>'
      +'<div style="font-size:13px;color:#fff;font-family:JetBrains Mono,monospace;background:#241d14;padding:12px;border-radius:10px;margin-bottom:10px;">'+L.sub+'</div>'
      +'<div style="display:flex;justify-content:space-between;font-size:12px;color:#999;padding:6px 2px;"><span>'+t('when')+'</span><span style="color:#ccc;">'+dt+'</span></div>';
    if(hash){
      html+='<div onclick="(function(){navigator.clipboard&&navigator.clipboard.writeText(\''+hash+'\');var x=document.getElementById(\'gbxCopyHint\');if(x)x.textContent=\''+t('copied')+'\';})()" style="display:flex;justify-content:space-between;font-size:12px;color:#999;padding:6px 2px;cursor:pointer;"><span>'+t('txid')+'</span><span style="color:#F5CC75;font-family:JetBrains Mono,monospace;" id="gbxCopyHint">'+shortAddr(hash)+'</span></div>';
    }
    if(isMeme){
      html+='<button onclick="window.location.href=\'/v3/trade.html?coin='+a.coin_id+'\'" style="width:100%;margin-top:14px;padding:14px;background:linear-gradient(135deg,#F5CC75,#E0A845);border:none;border-radius:12px;color:#1a140d;font-size:14px;font-weight:800;cursor:pointer;font-family:system-ui,sans-serif;">'+t('trade')+' $'+a.ticker+' →</button>';
    }
    if(a.type==='PROMOTE' && a.coin_id){
      html+='<button onclick="window.location.href=\'/index.html?promote='+(a.ticker||'')+'\'" style="width:100%;margin-top:14px;padding:14px;background:linear-gradient(135deg,#A855F7,#7C3AED);border:none;border-radius:12px;color:#fff;font-size:14px;font-weight:800;cursor:pointer;font-family:system-ui,sans-serif;">'+t('promoteBtn')+' $'+a.ticker+' →</button>';
    }
    if(a.type==='GBX_BUY'){
      html+='<button onclick="window.location.href=\'/v3/swap.html\'" style="width:100%;margin-top:14px;padding:14px;background:linear-gradient(135deg,#00C864,#00A050);border:none;border-radius:12px;color:#fff;font-size:14px;font-weight:800;cursor:pointer;font-family:system-ui,sans-serif;">'+t('buyGbx')+' →</button>';
    } else if(a.type==='GBX_SELL'){
      html+='<button onclick="window.location.href=\'/v3/swap.html?dir=sell\'" style="width:100%;margin-top:14px;padding:14px;background:linear-gradient(135deg,#FF6644,#D84020);border:none;border-radius:12px;color:#fff;font-size:14px;font-weight:800;cursor:pointer;font-family:system-ui,sans-serif;">'+t('sellGbx')+' →</button>';
    }
    if(hash){ html+='<button onclick="window.gbxOpenExp(\''+hash+'\',\''+(a.chain||'')+'\')" style="width:100%;margin-top:14px;padding:14px;background:transparent;border:1px solid #F0C060;border-radius:12px;color:#F0C060;font-size:13px;font-weight:800;cursor:pointer;font-family:system-ui,sans-serif;">'+t('viewExp')+'</button>'; }
    html+='<button onclick="document.getElementById(\'gbxActModal\').remove()" style="width:100%;margin-top:8px;padding:13px;background:transparent;border:1px solid #3a3025;border-radius:12px;color:#999;font-size:13px;font-weight:700;cursor:pointer;font-family:system-ui,sans-serif;">'+t('close')+'</button>'
      +'</div></div>';
    const old=document.getElementById('gbxActModal'); if(old)old.remove();
    document.body.insertAdjacentHTML('beforeend', html);
  }
  window.gbxOpenExp=function(h,chain){var u=(chain==='base')?('https://basescan.org/tx/'+h):(chain==='arbitrum')?('https://arbiscan.io/tx/'+h):(chain==='solana')?('https://solscan.io/tx/'+h):('https://explorer.goldbrix.app/?tx='+h);var w=window.open(u,'_blank');if(!w){location.href=u;}};
  window.gbxTxView = async function(hash){
    if(!hash) return;
    var prev = document.getElementById('gbxTxModal'); if(prev) prev.remove();
    var ov = document.createElement('div');
    ov.id = 'gbxTxModal';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:100000;display:flex;align-items:flex-end;justify-content:center;';
    ov.onclick = function(e){ if(e.target===ov) ov.remove(); };
    ov.innerHTML = '<div style="background:#1a140d;border:1px solid #3a3025;border-radius:18px 18px 0 0;width:100%;max-width:460px;padding:22px 18px 28px;font-family:system-ui,sans-serif;color:#fff;"><div style="font-size:13px;color:#F5CC75;font-weight:800;letter-spacing:.6px;margin-bottom:14px;">\u26d3 ON-CHAIN</div><div id="gbxTxBody" style="font-size:13px;color:#999;padding:8px 2px;">'+t('loading')+'</div></div>';
    document.body.appendChild(ov);
    function row(lbl,val,col){ return '<div style="display:flex;justify-content:space-between;gap:12px;font-size:12px;color:#999;padding:7px 2px;border-bottom:1px solid #261f16;"><span>'+lbl+'</span><span style="color:'+(col||'#ccc')+';font-weight:700;text-align:right;word-break:break-all;">'+val+'</span></div>'; }
    function cls(){ return '<button onclick="document.getElementById(\'gbxTxModal\').remove()" style="width:100%;margin-top:16px;padding:13px;background:transparent;border:1px solid #3a3025;border-radius:12px;color:#999;font-size:13px;font-weight:700;cursor:pointer;font-family:system-ui,sans-serif;">'+t('close')+'</button>'; }
    try{
      var r = await fetch(API + '/explorer-api/api/tx/' + hash);
      if(!r.ok) throw new Error('HTTP '+r.status);
      var d = await r.json();
      var conf = d.confirmations || 0;
      var ok = d.in_active_chain && conf > 0;
      var dt = d.blocktime ? new Date(d.blocktime*1000).toLocaleString() : '';
      var memo = '';
      try{ var vo=d.vout||[]; for(var i=0;i<vo.length;i++){ var asm=(vo[i].scriptPubKey&&vo[i].scriptPubKey.asm)||''; if(asm.indexOf('OP_RETURN')===0){ var hx=asm.replace('OP_RETURN','').trim().split(' ')[0]; var x=''; for(var j=0;j<hx.length;j+=2){ x+=String.fromCharCode(parseInt(hx.substr(j,2),16)); } memo=x; break; } } }catch(_e){}
      var body = row(t('status'), (ok?'\u2705 '+t('success'):'\u23f3 '+t('pending')), (ok?'#00C864':'#F0A030'))
        + row('Confirmations', conf.toLocaleString(), '#ccc')
        + (dt ? row(t('when'), dt, '#ccc') : '')
        + (d.blockhash ? row('Block', shortAddr(d.blockhash), '#F5CC75') : '')
        + (memo ? row('Data', (memo.length>46?memo.slice(0,46)+'\u2026':memo), '#9fb8ff') : '')
        + '<div onclick="navigator.clipboard&&navigator.clipboard.writeText(\''+hash+'\');var bb=this.querySelector(\'b\');if(bb)bb.textContent=\''+t('copied')+'\';" style="display:flex;justify-content:space-between;gap:12px;font-size:12px;color:#999;padding:7px 2px;cursor:pointer;"><span>'+t('txid')+'</span><b style="color:#F5CC75;font-weight:700;font-family:JetBrains Mono,monospace;">'+shortAddr(hash)+'</b></div>'
        + cls();
      var b=document.getElementById('gbxTxBody'); if(b) b.innerHTML=body;
    }catch(err){
      var b2=document.getElementById('gbxTxBody'); if(b2) b2.innerHTML='<div style="color:#F0A030;padding:10px 2px;">'+t('pending')+' \u2014 '+String(err.message||err)+'</div>'+cls();
    }
  };

  window._gbxActs = [];
  async function render(addr){
    if(!addr) return;
    window._txCurrentAddr = addr;
    try{ if(window.GoldbrixMultichain){ const u=JSON.parse(sessionStorage.getItem('gbx_unlocked_wallets')||'null'); const ws=(u&&u.wallets)||[]; const w0=ws.find(function(x){return x.id===(u&&u.activeWalletId);})||ws[0]; if(w0&&w0.mnemonic){ const ek=await window.GoldbrixMultichain.deriveEVM(w0.mnemonic); window._txEvmAddr=ek.address; try{ const sk=await window.GoldbrixMultichain.deriveSOL(w0.mnemonic); window._txSolAddr=(sk&&sk.address)||''; }catch(_s){} } } }catch(_e){}
    const list=document.getElementById('txHistoryList');
    const title=document.getElementById('txSectionTitle');
    if(title) title.textContent=t('title');
    if(!list) return;
    if(!list.dataset.loaded) list.innerHTML='<div class="tx-empty">'+t('loading')+'</div>';
    try{
      const r=await fetch(API+'/launchpad/wallet/'+addr+'/activity?limit=100');
      const d=await r.json();
      let acts=(d.activity||[]);
      // ISTORIC ON-CHAIN (autonom, cross-device): GBX din nod + USDC din Base
      try{
          // 1) GBX received (the address's transactions on the node)
          const gr=await fetch(API+'/api/address/'+addr+'/txs');
          if(gr.ok){ const gtx=await gr.json(); (Array.isArray(gtx)?gtx:[]).forEach(function(x){
            if(x.coinbase) return; // sar coinbase (minat, nu swap)
            const amt=Number(x.amount_gbx)||0; if(amt<=0) return;
            acts.push({type:'GBX_RECEIVED',amount:amt,counterparty:'',timestamp:(x.height?Date.now()-(x.confirmations||0)*6000:Date.now()),tx_hash:x.txid||'',status:'completed'});
          }); }
      }catch(_e){ console.warn('[hist gbx]',_e); }
      try{
          // 2) USDC pe Base (Transfer in/out) - reconstructie din chain
          const evm=(window._txEvmAddr||'').toLowerCase(); 
          if(evm){
            const RPC='https://base-rpc.publicnode.com', USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
            const TR='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
            const pad='0x000000000000000000000000'+evm.replace(/^0x/,'');
            const bn=await (await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]})})).json();
            const latest=parseInt(bn.result,16);
            // ferestre de 9000 (limita RPC Base ~10000) - ca findLock
            const WIN=9000, SCAN=200000;
            for(let hi=latest; hi>Math.max(0,latest-SCAN); hi-=WIN){
              const lo=Math.max(0,hi-WIN+1);
              let r2; try{ r2=await (await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{address:USDC,fromBlock:'0x'+lo.toString(16),toBlock:'0x'+hi.toString(16),topics:[TR,null,pad]}]})})).json(); }catch(_e){ continue; }
              (r2&&r2.result||[]).forEach(function(l){ var _bn=l.blockNumber?parseInt(l.blockNumber,16):0; var _ts=_bn?( (latest-_bn)<0?Date.now():(Date.now()-(latest-_bn)*2000) ):Date.now(); acts.push({type:'USDC_RECEIVED',usdc:parseInt(l.data,16)/1e6,timestamp:_ts,tx_hash:l.transactionHash,status:'completed'}); });
            }
          }
      }catch(_e){ console.warn('[hist usdc]',_e); }
      try{
          const ro=await fetch(API+'/onramp/orders/by-address/'+addr);
          if(ro.ok){ const od=await ro.json(); ((od&&od.orders)||[]).forEach(function(o){
            if(o.status!=='completed')return;
            var __th=(o.order_type==='sell')?(o.sell_gbx_tx_id||''):(o.gbx_tx_hash||''); if(__th) acts=acts.filter(function(x){return x.tx_hash!==__th;});  // dedup: onramp castiga vs on-chain
            { var __ts2=o.completed_at||o.created_at; var __amt2=Number(o.gbx_amount)||0; var __ot2=(o.order_type==='sell')?'GBX_SELL':'GBX_BUY'; acts=acts.filter(function(x){ return !(x.type===__ot2 && Math.abs((x.timestamp||0)-__ts2)<15000 && Math.abs((Number(x.gbx_amount)||0)-__amt2)<0.001); }); }  // dedup buy+sell pe suma+timp
            if(o.order_type==='sell') acts.push({type:'GBX_SELL',gbx_amount:Number(o.gbx_amount)||0,usdc:Number(o.net_usdc!=null?o.net_usdc:o.usdc_amount)||0,timestamp:o.completed_at||o.created_at,tx_hash:o.sell_gbx_tx_id||'',status:'completed'});
            else if(o.order_type==='buy') acts.push({type:'GBX_BUY',gbx_amount:Number(o.gbx_amount)||0,usdc:Number(o.usdc_amount!=null?o.usdc_amount:o.net_usdc)||0,timestamp:o.completed_at||o.created_at,tx_hash:o.gbx_tx_hash||'',status:'completed'});
          }); }
        }catch(_e){ console.warn('[activity onramp]',_e); }
        // SEND-uri locale (ce a trimis userul: GBX/USDC/ETH/memecoins) din send.html
        try{
          const sh = JSON.parse(localStorage.getItem('goldbrix_sent_history')||'{}');
          const mine = sh[addr] || [];
          mine.forEach(function(s){
            const tp = s.type;
            if(tp==='GBX'){
              acts.push({type:'GBX_SENT', amount:Number(s.amount)||0, counterparty:s.to, timestamp:s.timestamp, tx_hash:s.txid, status:'completed', chain:'gbx'});
            } else if(tp==='EVM'){
              acts.push({type:'XFER_SENT', ticker:s.ticker, amount:Number(s.amount)||0, to:s.to, timestamp:s.timestamp, tx_hash:s.txid, status:'completed', chain:'base'});
            } else {
              acts.push({type:'XFER_SENT', ticker:s.ticker, amount:Number(s.amount)||0, to:s.to, coin_id:s.coin_id, timestamp:s.timestamp, tx_hash:s.txid, status:'completed', chain:'gbx'});
            }
          });
        }catch(_e){ console.warn('[activity sent]',_e); }
        // BUY/SELL GBX (swap.html salveaza in gbx_swaps_history - lista plata)
        try{
          const sw = JSON.parse(localStorage.getItem('gbx_swaps_history')||'[]');
          (Array.isArray(sw)?sw:[]).forEach(function(s){
            if(s.type==='CONVERT'){ var _meE=(window._txEvmAddr||'').toLowerCase(); var _meS=(window._txSolAddr||'').toLowerCase(); var _so=(s.owner||'').toLowerCase(); if(_so && !( _so===_meE || _so===_meS )){ return; } acts.push({type:'CONVERT',chain:s.chain,cv_from:s.cv_from,cv_to:s.cv_to,cv_in:Number(s.cv_in)||0,cv_out:Number(s.cv_out)||0,via:s.via,tx_hash:s.tx_hash||'',timestamp:s.timestamp,status:s.status||'completed'}); }
            else if(s.type==='GBX_BUY' || s.type==='GBX_SELL'){
              acts.push({type:s.type, gbx_amount:Number(s.gbx_amount)||0, usdc:Number(s.usdc)||0,
                timestamp:s.timestamp||Date.now(), tx_hash:s.tx_hash||'', status:s.status||'completed', chain:'base'});
            }
          });
        }catch(_e){ console.warn('[activity swaps]',_e); }
        acts.sort(function(a,b){return (b.timestamp||0)-(a.timestamp||0);});
        acts=acts.slice(0,50);
        window._gbxActs=acts;
      if(!acts.length){ list.innerHTML='<div class="tx-empty">'+t('empty')+'</div>'; return; }
      list.innerHTML=acts.map((a,i)=>rowHtml(a,i)).join('');
      list.dataset.loaded='1';
      // Bind clicks (delegation)
      if(!list.dataset.bound){
        list.addEventListener('click', function(e){
          const row=e.target.closest('.gbx-act-row'); if(!row)return;
          const idx=parseInt(row.getAttribute('data-idx')); 
          if(!isNaN(idx)&&window._gbxActs[idx]) openModal(window._gbxActs[idx]);
        });
        list.dataset.bound='1';
      }
    }catch(e){ console.warn('[activity]',e); if(!list.dataset.loaded) list.innerHTML='<div class="tx-empty">'+t('empty')+'</div>'; }
  }
  window.gbxRenderActivity=render;
  setInterval(function(){ const a=window._txCurrentAddr; if(a&&document.getElementById('txHistoryList')) render(a); }, 15000);
  window.addEventListener('storage', function(e){ if(e.key&&e.key.indexOf('lang')>-1&&window._txCurrentAddr) render(window._txCurrentAddr); });
})();
