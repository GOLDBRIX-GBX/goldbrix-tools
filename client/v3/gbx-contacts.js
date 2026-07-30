/* GBXContacts - shared local contact book (local-only, zero-ownership).
   One module, two consumers: send.html (L1 addresses), send-meme.html (public keys). */
(function(){
"use strict";
if(window.GBXContacts) return;
var TX={
 addr:{
  en:{contacts:"Saved Contacts",none:"No saved contacts",add:"+ Save current address",name:"Contact name?",exists:"Already saved",bad:"Invalid GoldBrix address",del:"Delete this contact?",offer:"Save {v} to contacts?"},
  ro:{contacts:"Contacte Salvate",none:"Niciun contact salvat",add:"+ Salveaza adresa curenta",name:"Nume contact?",exists:"Deja salvat",bad:"Adresa GoldBrix invalida",del:"Stergi acest contact?",offer:"Salvezi {v} in contacte?"},
  de:{contacts:"Gespeicherte Kontakte",none:"Keine Kontakte",add:"+ Aktuelle Adresse speichern",name:"Kontaktname?",exists:"Bereits gespeichert",bad:"Ungueltige Adresse",del:"Diesen Kontakt loeschen?",offer:"{v} speichern?"},
  zh:{contacts:"已存联系人",none:"无已存联系人",add:"+ 保存当前地址",name:"联系人名称?",exists:"已存在",bad:"无效地址",del:"删除此联系人?",offer:"保存 {v} 到联系人?"},
  ar:{contacts:"جهات الاتصال المحفوظة",none:"لا جهات اتصال",add:"+ حفظ العنوان",name:"اسم جهة الاتصال؟",exists:"محفوظ مسبقا",bad:"عنوان غير صالح",del:"حذف جهة الاتصال؟",offer:"حفظ {v}؟"}
 },
 key:{
  en:{contacts:"Saved Contacts",none:"No saved contacts",add:"+ Save current key",name:"Contact name?",exists:"Already saved",bad:"Not a public key (66 characters, starting 02 or 03).",del:"Delete this contact?",offer:"Save {v} to contacts?"},
  ro:{contacts:"Contacte Salvate",none:"Niciun contact salvat",add:"+ Salveaza cheia curenta",name:"Nume contact?",exists:"Deja salvat",bad:"Nu e o cheie publica (66 de caractere, incepe cu 02 sau 03).",del:"Stergi acest contact?",offer:"Salvezi {v} in contacte?"},
  de:{contacts:"Gespeicherte Kontakte",none:"Keine Kontakte",add:"+ Aktuellen Schluessel speichern",name:"Kontaktname?",exists:"Bereits gespeichert",bad:"Kein oeffentlicher Schluessel (66 Zeichen, 02/03).",del:"Diesen Kontakt loeschen?",offer:"{v} speichern?"},
  zh:{contacts:"已存联系人",none:"无已存联系人",add:"+ 保存当前公钥",name:"联系人名称?",exists:"已存在",bad:"不是公钥（66个字符，02或03开头）。",del:"删除此联系人?",offer:"保存 {v} 到联系人?"},
  ar:{contacts:"جهات الاتصال المحفوظة",none:"لا جهات اتصال",add:"+ حفظ المفتاح الحالي",name:"اسم جهة الاتصال؟",exists:"محفوظ مسبقا",bad:"ليس مفتاحا عاما (66 حرفا، يبدأ بـ 02 أو 03).",del:"حذف جهة الاتصال؟",offer:"حفظ {v}؟"}
 }
};
var CSS=".gbxab-bar{margin-top:6px}.gbxab-btn{background:var(--bg-elevated,#1a1a1a);color:var(--text-secondary,#888);border:1px solid #333;border-radius:8px;padding:6px 12px;font-size:14px;cursor:pointer}.gbxab-caret{font-size:11px}.gbxab-list{margin-top:8px;background:var(--bg-elevated,#1a1a1a);border:1px solid #333;border-radius:8px;padding:6px}.gbxab-empty{color:var(--text-secondary,#888);font-size:13px;padding:8px;text-align:center}.gbxab-item{display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:6px}.gbxab-tap{display:flex;flex-direction:column;cursor:pointer;flex:1}.gbxab-tap b{color:var(--text-primary,#fff);font-size:14px}.gbxab-tap small{color:var(--text-secondary,#888);font-size:12px;font-family:'JetBrains Mono',monospace}.gbxab-del{background:none;border:none;color:var(--red,#FF3B3B);font-size:14px;cursor:pointer;padding:4px 8px}.gbxab-add{width:100%;margin-top:6px;background:none;border:1px dashed #444;color:var(--primary,#F0C060);border-radius:6px;padding:8px;font-size:14px;cursor:pointer}";
function css(){ if(document.getElementById("gbxab-css")) return; var s=document.createElement("style"); s.id="gbxab-css"; s.textContent=CSS; document.head.appendChild(s); }
function lang(){ try{ return localStorage.getItem("gbx_lang")||localStorage.getItem("goldbrix_lang")||"en"; }catch(e){ return "en"; } }
function dP(m){ return window.gbxPrompt?window.gbxPrompt(m):Promise.resolve(window.prompt(m)); }
function dC(m){ return window.gbxConfirm?window.gbxConfirm(m):Promise.resolve(window.confirm(m)); }
function dA(m){ return window.gbxAlert?window.gbxAlert(m):Promise.resolve(window.alert(m)); }
function esc(s){ return String(s).replace(/</g,"&lt;"); }
window.GBXContacts={ mount:function(o){
 css();
 var TT=TX[o.kind||"addr"];
 var t=function(k){ var L=lang(); return (TT[L]&&TT[L][k])||TT.en[k]||k; };
 var input=document.getElementById(o.input);
 var host=document.getElementById(o.anchor);
 if(!input||!host) return null;
 var KEY=o.storageKey;
 function load(){ try{ return JSON.parse(localStorage.getItem(KEY)||"[]"); }catch(e){ return []; } }
 function store(a){ try{ localStorage.setItem(KEY,JSON.stringify(a)); }catch(e){} }
 function shortv(a){ return a.length>16?a.slice(0,10)+"\u2026"+a.slice(-5):a; }
 host.innerHTML='<div class="gbxab-bar"><button type="button" class="gbxab-btn"><span class="gbxab-label"></span> <span class="gbxab-caret">\u25BE</span></button></div><div class="gbxab-list" style="display:none"></div>';
 var btn=host.querySelector(".gbxab-btn"), lab=host.querySelector(".gbxab-label"), list=host.querySelector(".gbxab-list");
 lab.textContent=t("contacts");
 function render(){ var a=load(); var h=""; if(!a.length) h+='<div class="gbxab-empty">'+t("none")+'</div>'; a.forEach(function(c,i){ h+='<div class="gbxab-item"><span class="gbxab-tap" data-i="'+i+'"><b>'+esc(c.name||"")+'</b><small>'+shortv(c.v||c.addr||"")+'</small></span><button type="button" class="gbxab-del" data-i="'+i+'">\u2715</button></div>'; }); h+='<button type="button" class="gbxab-add">'+t("add")+'</button>'; list.innerHTML=h; }
 btn.addEventListener("click",function(){ if(list.style.display==="none"){ lab.textContent=t("contacts"); render(); list.style.display="block"; } else { list.style.display="none"; } });
 list.addEventListener("click",async function(ev){
  var el=ev.target.closest(".gbxab-tap,.gbxab-del,.gbxab-add"); if(!el) return;
  if(el.classList.contains("gbxab-tap")){ var c=load()[Number(el.dataset.i)]; if(!c) return; input.value=c.v||c.addr||""; try{ input.dispatchEvent(new Event("input",{bubbles:true})); }catch(e){} list.style.display="none"; window.gbxHaptic&&gbxHaptic("light"); return; }
  if(el.classList.contains("gbxab-del")){ if(!(await dC(t("del")))) return; var a=load(); a.splice(Number(el.dataset.i),1); store(a); render(); return; }
  await save((input.value||"").trim());
 });
 async function save(v){ if(!v) return; var a=load(); if(a.some(function(c){return (c.v||c.addr)===v;})){ await dA(t("exists")); return; } var ok=false; try{ ok=await o.validate(v); }catch(e){ ok=false; } if(!ok){ await dA(t("bad")); return; } var name=((await dP(t("name")))||"").trim(); if(!name) return; a.push({name:name,v:v,ts:Date.now()}); store(a); window.gbxHaptic&&gbxHaptic("success"); render(); list.style.display="block"; }
 async function offerSave(v){ try{ if(!v) return; var a=load(); if(a.some(function(c){return (c.v||c.addr)===v;})) return; if(!(await dC(t("offer").replace("{v}",shortv(v))))) return; var name=((await dP(t("name")))||"").trim(); if(!name) return; a.push({name:name,v:v,ts:Date.now()}); store(a); window.gbxHaptic&&gbxHaptic("success"); }catch(e){} }
 return { offerSave:offerSave, save:save };
}};
})();
