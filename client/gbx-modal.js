// GoldBrix Modal — inlocuieste confirm/alert/prompt native (albe, ieftine) cu modale in tema gold/dark.
(function(){
  // i18n butoane (5 limbi) — urmeaza limba appului
  const MT = {
    en:{ok:'OK',cancel:'Cancel',continue:'Continue',save:'Save'},
    ro:{ok:'OK',cancel:'Anuleaza',continue:'Continua',save:'Salveaza'},
    de:{ok:'OK',cancel:'Abbrechen',continue:'Weiter',save:'Speichern'},
    zh:{ok:'确定',cancel:'取消',continue:'继续',save:'保存'},
    ar:{ok:'موافق',cancel:'إلغاء',continue:'متابعة',save:'حفظ'}
  };
  function lang(){
    try{ const l=(localStorage.getItem('gbx_lang')||localStorage.getItem('lang')||navigator.language||'en').slice(0,2).toLowerCase(); return MT[l]?l:'en'; }catch(e){ return 'en'; }
  }
  function mt(k){ return (MT[lang()]||MT.en)[k]||MT.en[k]; }

  function el(tag, cls, html){ const e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
  function overlay(){
    const o=el('div','gbxm-overlay');
    o.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.72);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px;animation:gbxmFade .15s ease;';
    return o;
  }
  function card(){
    const c=el('div','gbxm-card');
    c.style.cssText='width:100%;max-width:380px;background:linear-gradient(160deg,#221a10,#1a140d);border:1px solid #3a2e1c;border-radius:20px;padding:24px 22px;box-shadow:0 24px 60px rgba(0,0,0,.6),0 0 0 1px rgba(240,192,96,.08);animation:gbxmPop .2s cubic-bezier(.2,.9,.3,1.2);';
    return c;
  }
  function btn(label, primary){
    const b=el('button',null,label);
    b.style.cssText='flex:1;padding:14px 16px;border-radius:14px;font-size:15px;font-weight:700;font-family:Inter,sans-serif;cursor:pointer;transition:all .12s;border:none;'+
      (primary
        ? 'background:linear-gradient(135deg,#F0C060,#d4a544);color:#1a140d;box-shadow:0 4px 16px rgba(240,192,96,.25);'
        : 'background:rgba(255,255,255,.06);color:#cbb892;border:1px solid #3a2e1c;');
    b.onmouseover=()=>b.style.transform='translateY(-1px)';
    b.onmouseout=()=>b.style.transform='';
    return b;
  }
  function injectCSS(){
    if(document.getElementById('gbxm-css'))return;
    const s=el('style'); s.id='gbxm-css';
    s.textContent='@keyframes gbxmFade{from{opacity:0}to{opacity:1}}@keyframes gbxmPop{from{opacity:0;transform:scale(.92) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}.gbxm-input{width:100%;box-sizing:border-box;margin-top:14px;padding:13px 14px;background:#15100a;border:1px solid #3a2e1c;border-radius:12px;color:#f5e6c8;font-size:15px;font-family:Inter,sans-serif;outline:none}.gbxm-input:focus{border-color:#F0C060}';
    document.head.appendChild(s);
  }
  function base(msg, opts){
    injectCSS();
    return new Promise(resolve=>{
      const o=overlay(), c=card();
      const icon = opts.icon || '';
      if(icon){ const ic=el('div',null,icon); ic.style.cssText='font-size:28px;text-align:center;margin-bottom:10px;'; c.appendChild(ic); }
      const m=el('div',null,String(msg).replace(/\n/g,'<br>'));
      m.style.cssText='color:#f0e2c4;font-size:15px;line-height:1.5;font-family:Inter,sans-serif;text-align:center;margin-bottom:4px;word-break:break-word;';
      c.appendChild(m);
      let input=null;
      if(opts.prompt){ input=el('input','gbxm-input'); input.type='text'; input.value=opts.def||''; input.placeholder=opts.placeholder||''; c.appendChild(input); }
      const row=el('div'); row.style.cssText='display:flex;gap:10px;margin-top:20px;';
      function close(val){ o.style.animation='gbxmFade .12s ease reverse'; setTimeout(()=>{o.remove();resolve(val);},110); }
      if(opts.cancel!==false){
        const cb=btn(opts.cancelLabel||mt('cancel'),false);
        cb.onclick=()=>close(opts.prompt?null:false);
        row.appendChild(cb);
      }
      const ob=btn(opts.okLabel||mt('ok'),true);
      ob.onclick=()=>close(opts.prompt?(input?input.value.trim():''):true);
      row.appendChild(ob);
      c.appendChild(row); o.appendChild(c); document.body.appendChild(o);
      o.addEventListener('click',e=>{ if(e.target===o && opts.cancel!==false) close(opts.prompt?null:false); });
      if(input){ input.focus(); input.addEventListener('keydown',e=>{if(e.key==='Enter')ob.click();}); }
    });
  }
  window.gbxAlert   = (msg,icon)=>base(msg,{cancel:false,okLabel:mt('ok'),icon:icon||'⚠️'});
  window.gbxConfirm = (msg,icon)=>base(msg,{okLabel:mt('continue'),cancelLabel:mt('cancel'),icon:icon||''});
  window.gbxPrompt  = (msg,def,ph)=>base(msg,{prompt:true,def:def||'',placeholder:ph||'',okLabel:mt('save'),cancelLabel:mt('cancel'),icon:'✏️'});
})();
