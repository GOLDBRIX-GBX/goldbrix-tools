(function () {
  'use strict';
  var SESSION_KEY='gbx_unlocked_wallets', LOCK_SIGNAL='gbx_lock_signal', UNLOCK_URL='/v3/unlock.html';
  var IDLE_MS=5*60*1000, HIDDEN_MS=30*1000, MAX_AGE_MS=30*60*1000;
  function hasSession(){ try{ return !!sessionStorage.getItem(SESSION_KEY); }catch(e){ return false; } }
  function sessionAge(){ try{ var s=JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null'); return (s&&s.unlocked_at)?(Date.now()-s.unlocked_at):Infinity; }catch(e){ return Infinity; } }
  var locking=false;
  /* A long operation the user already started (proof-of-work, signing, a swap leg)
     must not be interrupted by the screen going off. The page raises window.__gbxBusy
     while it runs and clears it when it ends, on success or on failure. The flag lives
     on window only, so any reload drops it and the normal locking resumes. */
  function busy(){ try{ return !!window.__gbxBusy; }catch(e){ return false; } }
  function lock(broadcast){
    if(busy()) return;
    if(locking) return; locking=true;
    try{ sessionStorage.removeItem(SESSION_KEY); }catch(e){}
    if(broadcast!==false){ try{ localStorage.setItem(LOCK_SIGNAL,String(Date.now())); }catch(e){} }
    try{ window.location.replace(UNLOCK_URL); }catch(e){ window.location.href=UNLOCK_URL; }
  }
  window.gbxLock=function(){ lock(true); };
  window.addEventListener('storage',function(e){ if(e.key===LOCK_SIGNAL && hasSession()) lock(false); });
  var idleTimer=null;
  function resetIdle(){ if(!hasSession()) return; if(idleTimer) clearTimeout(idleTimer); idleTimer=setTimeout(function(){ lock(true); },IDLE_MS); }
  ['touchstart','mousedown','keydown','scroll','click'].forEach(function(ev){ window.addEventListener(ev,resetIdle,{passive:true}); });
  var hiddenTimer=null;
  document.addEventListener('visibilitychange',function(){
    if(!hasSession()) return;
    if(document.hidden){ hiddenTimer=setTimeout(function(){ lock(true); },HIDDEN_MS); }
    else { if(hiddenTimer){ clearTimeout(hiddenTimer); hiddenTimer=null; } if(sessionAge()>MAX_AGE_MS){ lock(true); return; } resetIdle(); }
  });
  if(hasSession()){ if(sessionAge()>MAX_AGE_MS) lock(true); else resetIdle(); }
})();
