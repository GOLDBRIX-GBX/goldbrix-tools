/* GBX · token picker vizual peste #tokenSelect. Sursa de adevar = <select>.
   If it fails, the native <select> stays visible and functional (fail-safe). */
(function(){
  'use strict';
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function badge(ch,bg){ return '<span class="tk-ic" style="background:'+bg+'">'+esc(ch)+'</span>'; }
  var LOGO={ GBX:'/assets/coin/gbx-coin-128.png', USDC:'/assets/usdc/usdc-128.png', ETH:'/v3/icons/eth.svg', BNB:'/v3/icons/bnb.svg', SOL:'/v3/icons/sol.svg' };
  var FB={ GBX:['G','linear-gradient(135deg,#F0C060,#9a6b1a)'], USDC:['$','#2775CA'], ETH:['Ξ','#3c3c4e'] };
  function fixImg(u){ if(!u) return ''; return String(u).replace(/https?:\/\/[0-9.\-]+\.sslip\.io/i,'https://goldbrix.app'); }
  function fallbackBadge(type,ticker){
    ticker=(ticker||'').toUpperCase();
    if(FB[ticker]) return badge(FB[ticker][0],FB[ticker][1]);
    var h=0,i; for(i=0;i<ticker.length;i++){ h=(h*31+ticker.charCodeAt(i))%360; }
    return badge(ticker.charAt(0)||'?','hsl('+h+',58%,42%)');
  }
  // global handler: on image error -> replace with a fallback badge (no HTML in the attribute)
  window.__tkImgFail=function(img){
    try{ var b=document.createElement('span'); b.className='tk-ic';
      b.style.background=img.getAttribute('data-bg')||'#444';
      b.textContent=img.getAttribute('data-ch')||'?';
      img.parentNode.replaceChild(b,img);
    }catch(e){}
  };
  function fbParts(type,ticker){
    ticker=(ticker||'').toUpperCase();
    if(FB[ticker]) return {ch:FB[ticker][0],bg:FB[ticker][1]};
    var h=0,i; for(i=0;i<ticker.length;i++){ h=(h*31+ticker.charCodeAt(i))%360; }
    return {ch:(ticker.charAt(0)||'?'),bg:'hsl('+h+',58%,42%)'};
  }
  function imgIcon(src,type,ticker){
    var f=fbParts(type,ticker);
    return '<img class="tk-ic" src="'+esc(src)+'" alt="" loading="lazy" '+
           'data-ch="'+esc(f.ch)+'" data-bg="'+esc(f.bg)+'" onerror="window.__tkImgFail(this)">';
  }
  function iconFor(type,ticker,imgUrl,coinId){
    ticker=(ticker||'').toUpperCase();
    if(type==='GBX'||ticker==='GBX') return imgIcon(LOGO.GBX,'GBX','GBX');
    if(LOGO[ticker]) return imgIcon(LOGO[ticker],type,ticker);
    if(imgUrl){ var u=fixImg(imgUrl); if(u) return imgIcon(u,type,ticker); }
    // memecoin nativ: construieste logo din coin_id (endpoint /launchpad/coin/{id}/image)
    if(type==='NATIVE' && coinId && coinId!=='null') return imgIcon('https://goldbrix.app/launchpad/coin/'+coinId+'/image',type,ticker);
    return fallbackBadge(type,ticker);
  }
  function injectCSS(){
    if(document.getElementById('tk-pick-css')) return;
    var st=document.createElement('style'); st.id='tk-pick-css';
    st.textContent=[
      '.token-select.tk-hidden{display:none!important;}',
      '.tk-pick{position:relative;}',
      '.tk-trigger{display:flex;align-items:center;gap:10px;width:100%;background:#120d04;border:1px solid var(--gold,#F0C060);border-radius:12px;padding:12px 14px;cursor:pointer;color:#fff;font-size:15px;font-weight:600;text-align:left;}',
      '.tk-trigger.open{box-shadow:0 0 0 3px var(--gold-glow,rgba(240,192,96,.18));outline:none;}',
      '.tk-trigger .tk-caret{margin-left:auto;color:var(--gold,#F0C060);transition:transform .15s;font-size:12px;}',
      '.tk-trigger.open .tk-caret{transform:rotate(180deg);}',
      '.tk-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tk-panel{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:1000;background:#1a1408;border:1px solid var(--gold,#F0C060);border-radius:12px;padding:6px;max-height:300px;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.6);display:none;}',
      '.tk-panel.open{display:block;}',
      '.tk-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:9px;cursor:pointer;color:#eee;font-size:14px;font-weight:600;}',
      '.tk-row:hover{background:rgba(240,192,96,.12);}',
      '.tk-row.active{background:rgba(240,192,96,.16);outline:1px solid rgba(240,192,96,.4);}',
      'img.tk-ic{object-fit:cover;background:#120d04;}',
      '.tk-ic{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;flex-shrink:0;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15);}',
      '.tk-bal{margin-left:auto;color:#9a8f70;font-weight:600;font-size:13px;flex-shrink:0;}',
      'html[dir=rtl] .tk-trigger,html[dir=rtl] .tk-row{text-align:right;}',
      'html[dir=rtl] .tk-trigger .tk-caret,html[dir=rtl] .tk-bal{margin-left:0;margin-right:auto;}'
    ].join('');
    document.head.appendChild(st);
  }
  function rowHTML(value,text){
    var p=String(value).split('|'); var type=p[0], ticker=p[1]; var extra=p[3]||''; var imgUrl=p[4]||'';
    var parts=String(text).split(' · '); var name=parts[0]; var bal=parts.slice(1).join(' · ');
    return iconFor(type,ticker,imgUrl,extra)+'<span class="tk-name">'+esc(name)+'</span>'+(bal?'<span class="tk-bal">'+esc(bal)+'</span>':'');
  }
  function init(){
    var sel=document.getElementById('tokenSelect');
    if(!sel || sel.dataset.tkInit) return;
    try{
      injectCSS();
      var wrap=document.createElement('div'); wrap.className='tk-pick';
      sel.parentNode.insertBefore(wrap,sel); wrap.appendChild(sel);
      var trig=document.createElement('button'); trig.type='button'; trig.className='tk-trigger';
      var panel=document.createElement('div'); panel.className='tk-panel';
      wrap.appendChild(trig); wrap.appendChild(panel);
      sel.classList.add('tk-hidden'); sel.dataset.tkInit='1';
      function renderTrigger(){
        var o=sel.options[sel.selectedIndex];
        trig.innerHTML=(o?rowHTML(o.value,o.textContent):'<span class="tk-name">…</span>')+'<span class="tk-caret">▾</span>';
      }
      function renderPanel(){
        panel.innerHTML='';
        Array.prototype.forEach.call(sel.options,function(o){
          var row=document.createElement('div');
          row.className='tk-row'+(o.value===sel.value?' active':'');
          row.innerHTML=rowHTML(o.value,o.textContent);
          row.addEventListener('click',function(){
            sel.value=o.value; sel.dispatchEvent(new Event('change'));
            renderTrigger(); close();
            if(window.gbxHaptic){ try{ gbxHaptic('light'); }catch(e){} }
          });
          panel.appendChild(row);
        });
      }
      function open(){ renderPanel(); panel.classList.add('open'); trig.classList.add('open'); }
      function close(){ panel.classList.remove('open'); trig.classList.remove('open'); }
      function toggle(){ panel.classList.contains('open')?close():open(); }
      trig.addEventListener('click',function(e){ e.stopPropagation(); toggle(); });
      document.addEventListener('click',function(e){ if(!wrap.contains(e.target)) close(); });
      sel.addEventListener('change',renderTrigger);
      new MutationObserver(function(){ renderTrigger(); if(panel.classList.contains('open')) renderPanel(); })
        .observe(sel,{childList:true});
      renderTrigger();
    }catch(e){
      try{ sel.classList.remove('tk-hidden'); }catch(_){}
      console.warn('[token-picker] dezactivat, select nativ activ:',e);
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
