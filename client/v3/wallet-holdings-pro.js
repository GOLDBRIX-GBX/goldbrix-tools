/* Holdings enrichment - federated, chain-derived.
   Value, 24h change and sparkline for every held coin, read through
   the federated layer (GBXRead). No fixed URL, no custodial source. */
(function(){
  var CACHE={};
  function fmtGbx(v){
    if(!isFinite(v)||v<=0)return '0';
    if(v>=1000000)return (v/1000000).toFixed(2)+'M';
    if(v>=1000)return (v/1000).toFixed(2)+'K';
    if(v>=1)return v.toFixed(2);
    return v.toFixed(4);
  }
  function spark(vals,up){
    if(!vals||vals.length<2)return '';
    var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals),rg=(mx-mn)||1;
    var W=56,H=22,pts=[];
    for(var i=0;i<vals.length;i++){
      var x=(i/(vals.length-1))*W, y=H-((vals[i]-mn)/rg)*H;
      pts.push(x.toFixed(1)+','+y.toFixed(1));
    }
    return '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" style="display:block">'+
      '<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+(up?'#57FF9E':'#FF6B5C')+
      '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }
  async function one(card){
    var id=card.getAttribute('data-coinid'); if(!id||!window.GBXRead)return;
    var bal=Number(card.getAttribute('data-bal'))||0;
    var vEl=card.querySelector('.mc-val'), cEl=card.querySelector('.mc-ch'), sEl=card.querySelector('.mc-spark');
    var st=CACHE[id];
    if(st===undefined){ try{ st=await window.GBXRead.json('/api/coin-stats/'+id); }catch(e){ st=null; } CACHE[id]=st; }
    if(st&&Number(st.price_sat)>0){
      if(vEl)vEl.textContent=fmtGbx(bal*Number(st.price_sat)/1e8)+' GBX';
      var ch=st.chg&&st.chg.d1;
      if(cEl){
        if(typeof ch==='number'&&ch!==0){
          cEl.textContent=(ch>0?'+':'')+ch.toFixed(1)+'%';
          cEl.style.color=ch>0?'#57FF9E':'#FF6B5C';
        } else { cEl.textContent=''; }
      }
    } else if(vEl){ vEl.textContent='\u2014'; }
    if(sEl&&!sEl.innerHTML){
      try{
        var cd=await window.GBXRead.json('/api/candles/'+id+'?interval=1h');
        var cl=((cd&&cd.candles)||[]).map(function(x){return Number(x.c!==undefined?x.c:x.close);}).filter(function(p){return p>0;});
        if(cl.length>=2)sEl.innerHTML=spark(cl,cl[cl.length-1]>=cl[0]);
      }catch(e){}
    }
  }
  window.enrichHoldings=function(){
    document.querySelectorAll('.my-coin-card[data-coinid]').forEach(function(c){ one(c); });
  };
})();
