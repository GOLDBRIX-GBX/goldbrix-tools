/* GOLDBRIX — SESSION SINGLE SOURCE OF TRUTH
 * O singura definitie a sesiunii wallet. Toate ecranele o folosesc.
 * Autonom: consumatorii nu depind de cine a populat sesiunea.
 * NU atinge derivarea cheilor (crypto-utils-v2 / m/84'/0') — doar stratul de sesiune.
 */
(function () {
  'use strict';
  var KEY = 'gbx_unlocked_wallets';
  var STATE = 'goldbrix_state_v3';
  var TTL = 30 * 60 * 1000; // 30 min, identic cu checkLock existent

  function _read() {
    try { var r = sessionStorage.getItem(KEY); return r ? JSON.parse(r) : null; }
    catch (e) { return null; }
  }
  function _state() {
    try { var r = localStorage.getItem(STATE); return r ? JSON.parse(r) : null; }
    catch (e) { return null; }
  }

  var GBXSession = {
    // structura canonica — UN SINGUR loc unde se defineste forma sesiunii
    create: function (wallets, activeWalletId, mnemonicById) {
      var sess = {
        wallets: (wallets || []).map(function (w) {
          var m = null;
          if (mnemonicById && typeof mnemonicById === 'object') m = mnemonicById[w.id] || w.mnemonic || null;
          else m = w.mnemonic || null;
          return Object.assign({}, w, { mnemonic: m });
        }),
        activeWalletId: activeWalletId,
        unlocked_at: Date.now()
      };
      sessionStorage.setItem(KEY, JSON.stringify(sess));
      return sess;
    },

    get: function () { return _read(); },

    // intoarce wallet-ul activ valid, sau null. NU redirecteaza — decide apelantul.
    activeWallet: function () {
      var u = _read();
      if (!u || !u.unlocked_at) return null;
      if (Date.now() - u.unlocked_at > TTL) { GBXSession.clear(); return null; }
      if (!u.wallets || !u.wallets.length) return null;
      var w = u.wallets.find(function (x) { return x.id === u.activeWalletId; }) || u.wallets[0];
      return (w && w.address) ? w : null;
    },

    // 'ok' | 'retry' | 'expired' | 'none'
    // self-healing: if the session is missing but the local state is valid (unlockable),
    // intoarce 'retry' ca apelantul sa astepte propagarea, NU sa redirecteze brutal.
    status: function () {
      var u = _read();
      if (u) {
        if (!u.unlocked_at || (Date.now() - u.unlocked_at > TTL)) return 'expired';
        var w = (u.wallets || []).find(function (x) { return x.id === u.activeWalletId; }) || (u.wallets || [])[0];
        return (w && w.address) ? 'ok' : 'expired';
      }
      // missing session: is an account configured? then it just has not propagated yet
      var st = _state();
      if (st && st.wallets && st.wallets.length && st.salt && st.pwdHash) return 'retry';
      return 'none'; // niciun cont -> welcome
    },

    setActive: function (id) {
      var u = _read(); if (!u) return false;
      u.activeWalletId = id;
      sessionStorage.setItem(KEY, JSON.stringify(u));
      var st = _state();
      if (st) { st.activeWalletId = id; localStorage.setItem(STATE, JSON.stringify(st)); }
      return true;
    },

    clear: function () { try { sessionStorage.removeItem(KEY); } catch (e) {} }
  };

  window.GBXSession = GBXSession;
})();
