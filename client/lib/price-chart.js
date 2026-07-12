/* GOLDBRIX PriceChart — componenta UNICA de grafic (memecoin + GBX).
   O singura implementare, folosita de trade.html (coins/:id/candles) si gbx.html (gbx/candles).
   Toate functiile: candles/line toggle, MA7/14/28, timeframes, hi/lo lines, countdown, change%, x-fmt, PRO ZOOM.
   i18n 5 limbi inclus (citeste gbx_lang). usdMultiplier: memecoin=()=>GBX_USD, GBX=()=>1. */
window.PriceChart = (function () {
  var I18N = {
    en: { nodata: 'NO DATA YET', collecting: 'COLLECTING DATA…' },
    ro: { nodata: 'FĂRĂ DATE ÎNCĂ', collecting: 'SE ADUNĂ DATE…' },
    de: { nodata: 'NOCH KEINE DATEN', collecting: 'DATEN WERDEN GESAMMELT…' },
    zh: { nodata: '暂无数据', collecting: '正在收集数据…' },
    ar: { nodata: 'لا توجد بيانات بعد', collecting: 'جارٍ جمع البيانات…' }
  };
  function L(k){ var l=(localStorage.getItem('gbx_lang')||localStorage.getItem('goldbrix_lang')||'en'); return (I18N[l]&&I18N[l][k])||I18N.en[k]||k; }
  function $(id){ if(!id) return null; var v=document.querySelector('.spa-viewbox[style*="block"] #'+id)||document.querySelector('.spa-viewbox:not([style*="none"]) #'+id); return v||document.getElementById(id); }

  var cfg=null, chart=null, series=null, vol=null;
  var candles=[], tf='1m', chartType='candles', showMA=true;
  var pollTimer=null, cdTimer=null, hiLine=null, loLine=null, ma7=null, ma14=null, ma28=null, xFmtSet=false, resizeBound=false;

  function mul(){ return (cfg.usdMultiplier ? cfg.usdMultiplier() : 1) || 1; }
  function dec(){ return cfg.displayDecimals!=null ? cfg.displayDecimals : 8; }
  function prec(){ return cfg.precision!=null ? cfg.precision : 9; }
  function minMove(){ return cfg.minMove!=null ? cfg.minMove : 0.000000001; }

  function load(){
    var base = cfg.candlesUrl();
    var url = base + (base.indexOf('?')>=0?'&':'?') + 'interval='+tf+'&limit=100';
    return fetch(url).then(function(r){return r.json();}).then(function(d){
      candles = (d&&d.candles)||[]; draw();
    }).catch(function(e){ console.warn('PriceChart load:', e); });
  }

  function updateChange(){
    var ch=0;
    var W={'1m':3600000,'5m':21600000,'15m':43200000,'1h':86400000,'4h':345600000,'1d':2592000000};
    var windowMs=W[tf]||86400000, cutoff=Date.now()-windowMs;
    var inW=(candles||[]).filter(function(c){return c&&c.time>=cutoff;});
    if(inW.length>=2&&inW[0].open>0){ ch=((inW[inW.length-1].close-inW[0].open)/inW[0].open)*100; }
    else if(candles&&candles.length>=2&&candles[0].open>0){ ch=((candles[candles.length-1].close-candles[0].open)/candles[0].open)*100; }
    else if(window._lastStats){ ch=window._lastStats.change_24h||0; }
    var e=$(cfg.els&&cfg.els.change); if(!e) return;
    if(Math.abs(ch)<0.01){ e.className='t-price-change neu'; e.textContent='─ 0.00%'; }
    else if(ch>=0){ e.className='t-price-change pos'; e.textContent='▲ +'+ch.toFixed(2)+'%'; }
    else { e.className='t-price-change neg'; e.textContent='▼ '+ch.toFixed(2)+'%'; }
  }

  function draw(){
    updateChange();
    var container=$(cfg.container); if(!container||typeof LightweightCharts==='undefined') return;
    if(!candles.length){ container.innerHTML='<div class="t-chart-empty">'+L('nodata')+'</div>'; return; }
    if(chart){ try{chart.remove();}catch(e){} chart=null; }
    container.innerHTML='';
    var U=mul();
    chart=LightweightCharts.createChart(container,{
      width:container.clientWidth, height:cfg.height||260,
      layout:{background:{color:'#000'},textColor:'#fff'},
      grid:{vertLines:{color:'#0a0a0a'},horzLines:{color:'#0a0a0a'}},
      crosshair:{mode:1},
      rightPriceScale:{autoScale:true,scaleMargins:{top:0.05,bottom:0.25},borderColor:'#222',mode:0},
      timeScale:{borderColor:'#222',timeVisible:true,secondsVisible:true,rightOffset:5,barSpacing:8},
      handleScroll:true,handleScale:true
    });
    var pf={type:'price',precision:prec(),minMove:minMove()};
    if(chartType==='line'){
      series=chart.addLineSeries({color:'#1DB954',lineWidth:2,priceLineVisible:true,priceLineColor:'#F0C060',priceLineWidth:1,priceLineStyle:2,lastValueVisible:true,priceFormat:pf});
    } else {
      series=chart.addCandlestickSeries({upColor:'#1DB954',downColor:'#FF3B3B',wickUpColor:'#1DB954',wickDownColor:'#FF3B3B',borderUpColor:'#1DB954',borderDownColor:'#FF3B3B',priceLineVisible:true,priceLineColor:'#F0C060',priceLineWidth:1,priceLineStyle:2,lastValueVisible:true,priceFormat:pf});
    }
    var cleaned=candles.filter(function(c){return c&&c.time&&c.close!=null;}).map(function(c){return {time:Math.floor(c.time/1000),open:c.open,high:c.high,low:c.low,close:c.close};}).sort(function(a,b){return a.time-b.time;});
    var dedup=[],lastT=null;
    for(var i=0;i<cleaned.length;i++){ if(cleaned[i].time!==lastT){dedup.push(cleaned[i]);lastT=cleaned[i].time;} }
    var colored=dedup.map(function(c,idx){
      if(idx===0) return c; var prev=dedup[idx-1];
      var dir=c.close>prev.close?'up':(c.close<prev.close?'down':'flat');
      if(dir==='up'){ if(c.close<c.open){ c.open=Math.min(c.open,c.close); c.close=Math.max(c.open+0.000000001,c.close);} }
      else if(dir==='down'){ if(c.close>c.open){ c.open=Math.max(c.open,c.close); c.close=Math.min(c.open-0.000000001,c.close);} else if(c.close===c.open){ c.open=c.close+0.000000001; } }
      return c;
    });
    var usd=colored.map(function(c){return {time:c.time,open:c.open*U,high:c.high*U,low:c.low*U,close:c.close*U};});
    if(chartType==='line'){ series.setData(usd.map(function(c){return {time:c.time,value:c.close};})); }
    else { series.setData(usd); }

    // MA7/14/28
    try{
      var calcMA=function(n){ var out=[]; for(var i=0;i<colored.length;i++){ var aN=Math.min(n,i+1); var win=colored.slice(i-aN+1,i+1).map(function(c){return c.close;}).filter(function(v){return v!=null&&!isNaN(v);}); if(!win.length) continue; out.push({time:colored[i].time,value:(win.reduce(function(a,b){return a+b;},0)/win.length)*U}); } return out; };
      if(showMA){
        ma7=chart.addLineSeries({color:'#F0C060',lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
        ma14=chart.addLineSeries({color:'#54B8F0',lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
        ma28=chart.addLineSeries({color:'#A06FFF',lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
        ma7.setData(calcMA(7)); ma14.setData(calcMA(14)); ma28.setData(calcMA(28));
      } else { ma7=ma14=ma28=null; }
      var closes=colored.map(function(c){return c.close;}).filter(function(v){return v!=null&&!isNaN(v);});
      var lastMA=function(n){ if(!closes.length) return null; var sl=closes.slice(-Math.min(n,closes.length)); return sl.reduce(function(a,b){return a+b;},0)/sl.length; };
      var fmt=function(v){ return v==null?'--':'$'+(v*U).toFixed(dec()); };
      var e7=$(cfg.els&&cfg.els.ma7),e14=$(cfg.els&&cfg.els.ma14),e28=$(cfg.els&&cfg.els.ma28);
      if(!showMA){ if(e7)e7.textContent='—'; if(e14)e14.textContent='—'; if(e28)e28.textContent='—'; }
      else if(closes.length<5){ if(e7)e7.textContent='—'; if(e14)e14.textContent='—'; if(e28)e28.textContent='—'; }
      else { if(e7)e7.textContent=fmt(lastMA(7)); if(e14)e14.textContent=fmt(lastMA(14)); if(e28)e28.textContent=fmt(lastMA(28)); }
    }catch(e){ console.warn('MA:',e); }

    // hi/lo lines (USD)
    try{
      if(hiLine){try{series.removePriceLine(hiLine);}catch(e){}}
      if(loLine){try{series.removePriceLine(loLine);}catch(e){}}
      var highs=usd.map(function(c){return c.high;}).filter(function(v){return v!=null&&!isNaN(v);});
      var lows=usd.map(function(c){return c.low;}).filter(function(v){return v!=null&&!isNaN(v);});
      if(highs.length&&lows.length){
        var maxH=Math.max.apply(null,highs), minL=Math.min.apply(null,lows);
        hiLine=series.createPriceLine({price:maxH,color:'#fff',lineWidth:1,lineStyle:0,axisLabelVisible:true,title:maxH.toFixed(dec())});
        loLine=series.createPriceLine({price:minL,color:'#fff',lineWidth:1,lineStyle:0,axisLabelVisible:true,title:minL.toFixed(dec())});
      }
    }catch(e){ console.warn('HiLo:',e); }

    // countdown
    try{
      if(colored.length>=2){
        var minInt=Infinity; for(var i=1;i<colored.length;i++){ var d=colored[i].time-colored[i-1].time; if(d>0&&d<minInt)minInt=d; }
        var known=[5,15,60,300,900,3600,14400,86400], iv=60;
        for(var k=0;k<known.length;k++){ if(minInt<=known[k]*1.5){ iv=known[k]; break; } }
        if(cdTimer) clearInterval(cdTimer);
        var upd=function(){ var n=Math.floor(Date.now()/1000); var rem=iv-(n%iv); var mm=String(Math.floor(rem/60)).padStart(2,'0'); var ss=String(rem%60).padStart(2,'0'); var el=$(cfg.els&&cfg.els.countdown); if(el)el.textContent=mm+':'+ss; };
        upd(); cdTimer=setInterval(upd,1000);
      }
    }catch(e){ console.warn('CD:',e); }

    // x-axis HH:MM
    try{
      if(!xFmtSet&&chart&&chart.timeScale){ chart.timeScale().applyOptions({tickMarkFormatter:function(t){var d=new Date(t*1000);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}}); xFmtSet=true; }
    }catch(e){ console.warn('Xfmt:',e); }

    // PRO ZOOM (USD)
    try{
      if(usd.length>0){
        var prices=[]; usd.forEach(function(c){prices.push(c.high,c.low);});
        var mn=Math.min.apply(null,prices), mx=Math.max.apply(null,prices), pad=(mx-mn)*0.15;
        try{ series.priceScale().applyOptions({autoScale:false}); chart.priceScale('right').setVisibleRange({from:mn-pad,to:mx+pad}); }
        catch(e){ series.priceScale().applyOptions({autoScale:true,scaleMargins:{top:0.1,bottom:0.3}}); }
      }
    }catch(e){ console.warn('Zoom:',e); }

    // volume (optional)
    if(cfg.showVolume!==false){
      try{
        vol=chart.addHistogramSeries({priceFormat:{type:'volume'},priceScaleId:'',color:'#1DB95440'});
        vol.priceScale().applyOptions({scaleMargins:{top:0.85,bottom:0}});
        var sc=candles.slice().filter(function(c){return c&&c.time;}).sort(function(a,b){return a.time-b.time;});
        vol.setData(sc.map(function(c,idx){ var col='rgba(29,185,84,0.4)'; if(idx>0){ var p=sc[idx-1]; if(c.close<p.close)col='rgba(255,59,59,0.4)'; else if(c.close>p.close)col='rgba(29,185,84,0.4)'; else col='rgba(120,120,120,0.3)'; } return {time:Math.floor(c.time/1000),value:c.volume_gbx||0,color:col}; }));
      }catch(e){ console.warn('Vol:',e); }
    }
    if(cfg.fitContent===true){ try{ if(chart&&chart.timeScale) chart.timeScale().fitContent(); }catch(e){} }
    if(!resizeBound){ resizeBound=true; window.addEventListener('resize',function(){ if(chart)try{chart.applyOptions({width:container.clientWidth});}catch(e){} }); }
  }

  function setTimeframe(t){ tf=t; document.querySelectorAll('.t-tf-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.tf===t); }); load(); }
  function toggleType(){ chartType=chartType==='candles'?'line':'candles'; try{localStorage.setItem(cfg.storageKey||'gbx_chartType',chartType);}catch(e){} updateIcons(); draw(); }
  function toggleMA(){ showMA=!showMA; try{localStorage.setItem('gbx_showMA',showMA?'true':'false');}catch(e){} updateIcons(); draw(); }
  function updateIcons(){ var i1=$(cfg.els&&cfg.els.iconType),i2=$(cfg.els&&cfg.els.iconMA); if(i1)i1.classList.toggle('active',chartType==='line'); if(i2)i2.classList.toggle('active',!showMA); }

  function init(config){
    cfg=config;
    chartType=(localStorage.getItem(cfg.storageKey||'gbx_chartType')||cfg.defaultChartType||'candles');
    showMA=(localStorage.getItem('gbx_showMA')!=='false');
    tf=config.defaultTf||'1m';
    window.setInterval2=setTimeframe; window.toggleChartType=toggleType; window.toggleMA=toggleMA;
    setTimeout(function(){ var b1=$(cfg.els&&cfg.els.iconType),b2=$(cfg.els&&cfg.els.iconMA);
      if(b1) b1.onclick=function(e){e.preventDefault();toggleType();};
      if(b2) b2.onclick=function(e){e.preventDefault();toggleMA();}; },250);
    setTimeout(updateIcons,200);
    load();
    if(pollTimer) clearInterval(pollTimer);
    pollTimer=setInterval(load, config.pollMs||8000);
  }
  return { init:init, setTimeframe:setTimeframe, toggleType:toggleType, toggleMA:toggleMA, reload:load };
})();
