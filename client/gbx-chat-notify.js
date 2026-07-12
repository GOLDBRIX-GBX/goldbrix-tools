/* GoldBrix — Chat unread badge + sound (in-app, polling) */
(function(){
  var API='https://goldbrix.app';
  var POLL=12000;
  var onChat=/\/v3\/chat\.html/.test(location.pathname);

  (function(){
    if(document.getElementById('gbx-chat-badge-css')) return;
    var st=document.createElement('style'); st.id='gbx-chat-badge-css';
    st.textContent='.gbx-chat-badge{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 5px;background:#ff3b30;color:#fff;border-radius:9px;font-size:11px;font-weight:800;display:none;align-items:center;justify-content:center;font-family:JetBrains Mono,monospace;box-shadow:0 0 0 2px #1a140d;animation:gbxBadgePulse 1.2s infinite;z-index:5;}@keyframes gbxBadgePulse{0%,100%{transform:scale(1);}50%{transform:scale(1.18);}}.gbx-chat-glow{animation:gbxChatGlow 1.4s infinite!important;}@keyframes gbxChatGlow{0%,100%{box-shadow:0 0 0 0 rgba(255,59,48,0);}50%{box-shadow:0 0 16px 2px rgba(255,59,48,0.55);}}';
    document.head.appendChild(st);
  })();

  function getRead(){ try{return parseInt(localStorage.getItem('gbx_chat_last_read')||'0')||0;}catch(e){return 0;} }
  function setRead(ts){ try{localStorage.setItem('gbx_chat_last_read',String(ts));}catch(e){} }
  function muted(){ try{return localStorage.getItem('gbx_chat_muted')==='1';}catch(e){return false;} }
  function myAddr(){ try{var r=localStorage.getItem('goldbrix_state_v3');if(r){var st=JSON.parse(r);return st.activeAddress||(st.wallets&&st.wallets[0]&&st.wallets[0].address)||null;}}catch(e){} return null; }

  // sunet scurt discret (WebAudio, fara fisier)
  function beep(){
    if(muted()) return;
    try{
      var ctx=new (window.AudioContext||window.webkitAudioContext)();
      var o=ctx.createOscillator(), g=ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value=880; o.type='sine';
      g.gain.setValueAtTime(0.0001,ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15,ctx.currentTime+0.01);
      g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.25);
      o.start(); o.stop(ctx.currentTime+0.26);
    }catch(e){}
  }

  function ensureBadge(host){
    if(!host) return null;
    if(getComputedStyle(host).position==='static'){ host.style.position='relative'; }
    var b=host.querySelector('.gbx-chat-badge');
    if(!b){ b=document.createElement('span'); b.className='gbx-chat-badge'; host.appendChild(b); }
    return b;
  }
  function setBadge(n){
    window.__GBX_CHAT_UNREAD__=n;
    var hosts=[document.getElementById('chatBannerHome'),document.getElementById('tabChat')];
    hosts.forEach(function(host){
      if(!host) return;
      var b=ensureBadge(host);
      if(b){ if(n>0){ b.textContent=n>99?'99+':String(n); b.style.display='flex'; host.classList.add('gbx-chat-glow'); } else { b.style.display='none'; host.classList.remove('gbx-chat-glow'); } }
    });
    window.dispatchEvent(new CustomEvent('gbx:chat-unread',{detail:{count:n}}));
  }

  var lastSeenTs=getRead();
  var prevUnread=0;

  async function check(){
    try{
      var r=await fetch(API+'/launchpad/chat/messages?lang=en&since=0&limit=50',{cache:'no-store'});
      var d=await r.json();
      var msgs=(d&&d.messages)||[];
      if(onChat){
        // pe chat: marcheaza tot citit
        if(msgs.length){ var maxTs=Math.max.apply(null,msgs.map(function(m){return m.created_at||0;})); setRead(maxTs); lastSeenTs=maxTs; }
        setBadge(0); prevUnread=0; return;
      }
      var read=getRead();
      var me=myAddr();
      var unread=msgs.filter(function(m){ return (m.created_at||0)>read && m.address!==me; });
      var n=unread.length;
      setBadge(n);
      // sunet doar cand creste numarul (mesaj nou aparut)
      if(n>prevUnread && prevUnread>=0 && read>0){ beep(); }
      prevUnread=n;
    }catch(e){}
  }

  window.gbxChatMarkRead=function(){ check(); };
  window.addEventListener('DOMContentLoaded',function(){ check(); setInterval(check,POLL); });
  if(document.readyState!=='loading'){ check(); setInterval(check,POLL); }
})();
