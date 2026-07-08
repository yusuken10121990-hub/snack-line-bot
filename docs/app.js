/* 共通: LIFF初期化 + GAS API + UI補助 */
var LIFF_ID = '2010418983-tAsscHwB';
var GAS_URL = 'https://script.google.com/macros/s/AKfycbzOLuWAbU1Td4VMCVGEK2nWRZ4WpUFGMLBvplH1aPaZx0sdF60u1o3G1aKOW02nLd07jg/exec';

var ME = { userId: '', displayName: '' };

function $(id) { return document.getElementById(id); }
function spin(on) { var s = $('spin'); if (s) s.classList.toggle('on', !!on); }
function toast(msg) { var t = $('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('on'); setTimeout(function () { t.classList.remove('on'); }, 2500); }
function qparam(k) { return new URLSearchParams(location.search).get(k); }

/* LIFF初期化。失敗/未設定時は ?uid= でテスト可 */
function initLiff() {
  return new Promise(function (resolve) {
    function fallback() { ME.userId = qparam('uid') || ''; ME.displayName = qparam('name') || 'ゲスト'; resolve(ME); }
    try {
      if (typeof liff === 'undefined') return fallback();
      liff.init({ liffId: LIFF_ID }).then(function () {
        if (!liff.isLoggedIn()) { liff.login(); return; }
        liff.getProfile().then(function (p) { ME.userId = p.userId; ME.displayName = p.displayName; resolve(ME); }).catch(fallback);
      }).catch(fallback);
    } catch (e) { fallback(); }
  });
}
function closeWin() { try { if (typeof liff !== 'undefined' && liff.isInClient()) liff.closeWindow(); else history.back(); } catch (e) { history.back(); } }

/* GAS GET API (admin.html専用。旧スプレッドシート集計はそのまま利用) */
function apiGet(action, params) {
  var qs = 'action=' + encodeURIComponent(action);
  Object.keys(params || {}).forEach(function (k) { qs += '&' + k + '=' + encodeURIComponent(params[k]); });
  return fetch(GAS_URL + '?' + qs).then(function (r) { return r.json(); });
}
/* GAS POST API: text/plain で送りプリフライト回避(CORS対策)。admin.html専用。 */
function apiPost(obj) {
  return fetch(GAS_URL, { method: 'POST', body: JSON.stringify(obj) }).then(function (r) { return r.json(); });
}
function ymStr(d) { return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2); }
function monthOf(offset) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset); return { y: d.getFullYear(), m: d.getMonth() + 1, ym: ymStr(d) }; }

/* ====== 新システム(snack-korekara-web) API: shift/transit/confirm/index が使用 ====== */
var API_BASE = 'https://snack-web-production.up.railway.app';
function liffGet(path, params) {
  var qs = Object.keys(params || {}).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  return fetch(API_BASE + path + (qs ? ('?' + qs) : '')).then(function (r) { return r.json(); });
}
function liffPost(path, obj) {
  return fetch(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }).then(function (r) { return r.json(); });
}
/* 日付キー変換: 画面内部キー(Y/M/D, ゼロ埋め無し) <-> API日付(YYYY-MM-DD) */
function pad2_(n) { return ('0' + n).slice(-2); }
function toApiDate(key) { var p = String(key).split('/'); return p[0] + '-' + pad2_(p[1]) + '-' + pad2_(p[2]); }
function toLocalKey(d) { var p = String(d).split('-'); return parseInt(p[0], 10) + '/' + parseInt(p[1], 10) + '/' + parseInt(p[2], 10); }
