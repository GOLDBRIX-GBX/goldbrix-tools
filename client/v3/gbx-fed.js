// Federated data adapter: the old dashboard reads the chain through the
// federation layer (gbx-read) — /api/curves + /api/pools + /api/stats24.
// Serves the legacy coin shape so every renderer keeps working unchanged.
window.GBXFed=(function(){
  var C=null,T=0,S=null,TS=0,_logoMem={},_logoBusy={};
  async function j(p){
    for(var i=0;i<20&&!window.GBXRead;i++)await new Promise(function(r){setTimeout(r,100);});
    if(window.GBXRead) return await window.GBXRead.json(p);
    return await (await fetch(p)).json();
  }
  async function coins(){
    if(C&&Date.now()-T<15000)return C;
    var cd=await j('/api/curves'); var pools={};
    try{ ((await j('/api/pools')).pools||[]).forEach(function(p){pools[p.coin_id]=p;}); }catch(e){}
    C=(cd.curves||[]).map(function(c){
      var p=pools[c.coin_id], g=(c.status==='graduated');
      return { id:c.coin_id, ticker:c.ticker||c.coin_id.slice(0,6).toUpperCase(), name:c.name||'',
        graduated:g, holders:c.holders||0, height:c.height||0,
        reserve_gbx: (g&&p) ? Number(p.gbx_sat)/1e8 : Number(c.reserve_sat||0)/1e8,
        market_cap_gbx:null, image_url: _logoMem[c.coin_id]||null, has_logo: !!c.has_logo,
        created_at: (cd.scanned&&c.height) ? (Date.now()-(cd.scanned-c.height)*3000) : null,
        change_24h:null };
    });
    T=Date.now();
    /* the on-chain logo fills in silently: fetched once per coin, cached for the session */
    C.forEach(function(cc){
      if(!cc.has_logo || cc.image_url) return;
      try{ var hit=sessionStorage.getItem('gbx_lchain_'+cc.id);
        if(hit){ cc.image_url=hit; _logoMem[cc.id]=hit; return; } }catch(e){}
      if(_logoBusy[cc.id]) return; _logoBusy[cc.id]=1;
      j('/api/curves/'+cc.id).then(function(d){
        if(!d||!d.logo) return;
        _logoMem[cc.id]=d.logo; cc.image_url=d.logo;
        try{ sessionStorage.setItem('gbx_lchain_'+cc.id, d.logo); }catch(e){}
      }).catch(function(){});
    });
    return C;
  }
  var B=null,BT=0;
  async function burnStats(){
    if(B&&Date.now()-BT<300000)return B;
    var d=await j('/api/burns');
    B={total_gbx:Number(d.chain_total_sat||0)/1e8, utxos:Number(d.chain_burn_utxos||0)};
    BT=Date.now(); return B;
  }
  async function stats(){ if(S&&Date.now()-TS<15000)return S; S=await j('/api/stats24'); TS=Date.now(); return S; }
  return {coins:coins,stats:stats,burnStats:burnStats,j:j};
})();
