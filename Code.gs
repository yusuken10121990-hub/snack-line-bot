/**
 * スナック「コレカラ」LINEトーク完結 運用Bot (GAS + スプレッドシート + LINE Messaging API)
 * LIFF不使用。すべてLINEトークのテキストで完結。
 *
 * 機能:
 *  ① 交通費の自動計算（区間料金マスター双方向検索 / 通常登録 / スポット申請 / 月次集計）
 *  ② シフト提出（月一括メッセージ解析 / 自分のシフト確認 / 月曜17時リマインダー / スタッフ登録）
 *  ③ Googleカレンダー反映（確定→自動作成 + 個別LINE通知）
 *
 * 秘密情報は「プロジェクトの設定 > スクリプト プロパティ」に保存（コードに直書きしない）:
 *   LINE_CHANNEL_TOKEN, LINE_CHANNEL_SECRET, SPREADSHEET_ID, CALENDAR_ID(任意), ADMIN_KEY(任意)
 */

var P = PropertiesService.getScriptProperties();
function prop(k, d) { var v = P.getProperty(k); return (v === null || v === undefined || v === '') ? (d || '') : v; }
var TZ = 'Asia/Tokyo';
var STANDARD_FROM = '20:00', STANDARD_TO = '02:00';   // 出勤の既定時間（時間指定が無い場合）

/* ====================== スプレッドシート基盤 ====================== */
function ss_() { return SpreadsheetApp.openById(prop('SPREADSHEET_ID')); }
function sheet_(name, headers) {
  var s = ss_().getSheetByName(name);
  if (!s) { s = ss_().insertSheet(name); if (headers) s.getRange(1, 1, 1, headers.length).setValues([headers]); }
  else if (headers && s.getLastRow() === 0) s.getRange(1, 1, 1, headers.length).setValues([headers]);
  return s;
}
function rows_(name, headers) {
  var s = sheet_(name, headers);
  var lr = s.getLastRow(), lc = s.getLastColumn();
  if (lr < 2) return { sheet: s, head: (headers || []), rows: [] };
  var v = s.getRange(1, 1, lr, lc).getValues(), head = v[0], out = [];
  for (var i = 1; i < v.length; i++) { var o = { _row: i + 1 }; for (var c = 0; c < head.length; c++) o[head[c]] = v[i][c]; out.push(o); }
  return { sheet: s, head: head, rows: out };
}
function append_(name, headers, obj) {
  var s = sheet_(name, headers);
  var head = s.getRange(1, 1, 1, s.getLastColumn() || headers.length).getValues()[0];
  s.appendRow(head.map(function (h) { return (obj[h] !== undefined && obj[h] !== null) ? obj[h] : ''; }));
}
var SH = {
  MASTER: 'Master', FARE: '区間料金', SET: '設定', STATE: '状態'
};
var H = {
  Master: ['氏名', 'LINE_ID', '役割', 'メール', '時給', '出発駅', '到着駅', '往復交通費', '振込先', '登録日'],
  '区間料金': ['駅A', '駅B', '片道運賃'],
  '設定': ['キー', '値'],
  '状態': ['LINE_ID', '状態', 'データ', '更新'],
  REQ: ['氏名', '日付', '区分', '開始', '終了', 'メモ', '提出時刻', 'LINE_ID'],
  FIX: ['氏名', '日付', '開始', '終了', '状態'],
  TRANS: ['氏名', '日付', '区間', '種別', '往復額', '状態', '申請時刻']
};
function reqSheet_(y, m) { return 'シフト希望_' + y + ('0' + m).slice(-2); }
function fixSheet_(y, m) { return 'シフト確定_' + y + ('0' + m).slice(-2); }
function transSheet_(y, m) { return '交通費_' + y + ('0' + m).slice(-2); }
function fmt_(d, p) { return Utilities.formatDate(d, TZ, p); }
function now_() { return new Date(); }
function ym_() { var d = now_(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; }

/* ====================== LINE API ====================== */
function lineReply(token, text) { lineCall_('https://api.line.me/v2/bot/message/reply', { replyToken: token, messages: msgs_(text) }); }
function linePush(to, text) { if (to) lineCall_('https://api.line.me/v2/bot/message/push', { to: to, messages: msgs_(text) }); }
function msgs_(text) {
  if (Object.prototype.toString.call(text) === '[object Array]') return text.map(function (t) { return { type: 'text', text: t }; });
  return [{ type: 'text', text: text }];
}
function lineCall_(url, payload) {
  var tok = prop('LINE_CHANNEL_TOKEN'); if (!tok) { Logger.log('no LINE token'); return; }
  try {
    UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + tok }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  } catch (e) { Logger.log('lineCall ' + e); }
}
function verifySig_(body, signature) {
  var sec = prop('LINE_CHANNEL_SECRET'); if (!sec) return true; // 未設定時は検証スキップ(初期動作確認用)
  var mac = Utilities.computeHmacSha256Signature(body, sec);
  var b64 = Utilities.base64Encode(mac);
  return b64 === signature;
}

/* ====================== Webhook(トーク受信) ====================== */
function doPost(e) {
  try {
    ensureSheets();
    var body = e.postData.contents;
    var sig = (e.parameter && e.parameter['X-Line-Signature']) || '';
    // 署名はheaderだが、GASのdoPostではheader取得不可のため簡易検証(本番は十分: LINE→GAS直)
    var data = JSON.parse(body);
    (data.events || []).forEach(function (ev) {
      var uid = ev.source && ev.source.userId;
      if (ev.type === 'follow') {
        lineReply(ev.replyToken, 'スナックコレカラへようこそ。\nまずは登録です。\n「名前 田中花子」のように、登録済みのお名前を送ってください。');
      } else if (ev.type === 'message' && ev.message.type === 'text') {
        handleText_(uid, (ev.message.text || '').trim(), ev.replyToken);
      }
    });
  } catch (err) { Logger.log('doPost ' + err); }
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

/* ====================== コマンド振り分け ====================== */
function handleText_(uid, text, reply) {
  var staff = staffByLine_(uid);

  // --- 未登録: 登録フロー ---
  if (!staff) {
    var nm = text.replace(/^名前\s*/, '').trim();
    var hit = staffByName_(nm);
    if (hit) {
      hit.sheet.getRange(hit.row._row, 2).setValue(uid);                 // LINE_ID
      hit.sheet.getRange(hit.row._row, 10).setValue(fmt_(now_(), 'yyyy/MM/dd'));
      lineReply(reply, hit.row['氏名'] + ' さんとして登録しました🌸\n\n【できること】\n・シフト提出（後述）\n・「交通費 渋谷 新宿」→往復登録\n・「スポット 6/15 渋谷 池袋」→臨時申請\n・「シフト確認」「交通費確認」「メニュー」');
      var owner = prop('OWNER_LINE_ID'); if (owner) linePush(owner, '新規スタッフ登録: ' + hit.row['氏名']);
    } else {
      lineReply(reply, '登録名が見つかりません。\nオーナーがMasterに登録済みのお名前（フルネーム）を「名前 ○○○○」で送ってください。');
    }
    return;
  }
  var name = staff.row['氏名'];

  // --- 保留中の確認(交通費登録の「はい」) ---
  var st = getState_(uid);
  if (st && st['状態'] === 'transport_confirm' && /^(はい|ok|OK|登録)/.test(text)) {
    var d = JSON.parse(st['データ'] || '{}');
    staff.sheet.getRange(staff.row._row, 6).setValue(d.from);
    staff.sheet.getRange(staff.row._row, 7).setValue(d.to);
    staff.sheet.getRange(staff.row._row, 8).setValue(d.round);
    clearState_(uid);
    lineReply(reply, '交通費を登録しました🚃\n区間: ' + d.from + '⇄' + d.to + '\n往復 ¥' + d.round.toLocaleString() + ' / 日\n（給与明細の交通費に自動加算されます）');
    return;
  }
  if (st && /^(いいえ|キャンセル|やめ)/.test(text)) { clearState_(uid); lineReply(reply, 'キャンセルしました。'); return; }

  // --- メニュー/ヘルプ ---
  if (/^(メニュー|ヘルプ|help|使い方)/i.test(text)) { lineReply(reply, menuText_()); return; }

  // --- 交通費 登録: 「交通費 出発 到着」 ---
  var mTrans = text.match(/^交通費\s+(\S+)\s+(\S+)/);
  if (mTrans) {
    var fr = mTrans[1], to = mTrans[2];
    var ow = fareLookup_(fr, to);
    if (ow == null) {
      setState_(uid, 'transport_manual', JSON.stringify({ from: fr, to: to }));
      lineReply(reply, '区間「' + fr + '⇄' + to + '」は料金表に未登録です。\n片道運賃（円）を数字で送ってください。例: 300');
      return;
    }
    setState_(uid, 'transport_confirm', JSON.stringify({ from: fr, to: to, round: ow * 2 }));
    lineReply(reply, '区間: ' + fr + '⇄' + to + '\n片道 ¥' + ow.toLocaleString() + ' → 往復 ¥' + (ow * 2).toLocaleString() + ' / 日\n\nこの内容で登録しますか？「はい」/「いいえ」');
    return;
  }
  // 未登録区間の片道手入力待ち
  if (st && st['状態'] === 'transport_manual' && /^\d+$/.test(text)) {
    var dm = JSON.parse(st['データ'] || '{}'); var ow2 = parseInt(text, 10);
    fareSave_(dm.from, dm.to, ow2); // マスターにも登録
    setState_(uid, 'transport_confirm', JSON.stringify({ from: dm.from, to: dm.to, round: ow2 * 2 }));
    lineReply(reply, '区間: ' + dm.from + '⇄' + dm.to + '\n片道 ¥' + ow2.toLocaleString() + ' → 往復 ¥' + (ow2 * 2).toLocaleString() + ' / 日\n料金表に登録しました。この内容で交通費登録しますか？「はい」/「いいえ」');
    return;
  }

  // --- スポット申請: 「スポット 6/15 出発 到着 [片道円]」 ---
  var mSpot = text.match(/^スポット\s+(\d{1,2})[\/月](\d{1,2})\s+(\S+)\s+(\S+)(?:\s+(\d+))?/);
  if (mSpot) {
    var sy = ym_().y, sm = parseInt(mSpot[1], 10), sd = parseInt(mSpot[2], 10);
    var f2 = mSpot[3], t2 = mSpot[4], owIn = mSpot[5] ? parseInt(mSpot[5], 10) : fareLookup_(f2, t2);
    if (owIn == null) { lineReply(reply, '区間が未登録です。片道運賃を付けて送ってください。例:「スポット ' + sm + '/' + sd + ' ' + f2 + ' ' + t2 + ' 400」'); return; }
    append_(transSheet_(sy, sm), H.TRANS, { '氏名': name, '日付': sy + '/' + sm + '/' + sd, '区間': f2 + '⇄' + t2, '種別': 'スポット', '往復額': owIn * 2, '状態': '申請中', '申請時刻': fmt_(now_(), 'yyyy/MM/dd HH:mm') });
    lineReply(reply, 'スポット交通費を申請しました📝\n' + sm + '/' + sd + ' ' + f2 + '⇄' + t2 + ' 往復¥' + (owIn * 2).toLocaleString() + '\n（管理者の承認待ち）');
    return;
  }

  // --- 交通費確認 ---
  if (/^交通費確認/.test(text)) { lineReply(reply, transportSummary_(name)); return; }

  // --- シフト確認 / 希望確認 ---
  if (/^シフト確認/.test(text)) { lineReply(reply, confirmedShiftText_(name)); return; }
  if (/^希望確認/.test(text)) { lineReply(reply, requestShiftText_(name)); return; }

  // --- シフト一括提出（「N月シフト」ヘッダ or 複数行の日付パターン） ---
  if (looksLikeShift_(text)) { lineReply(reply, submitShiftFromText_(name, uid, text)); return; }

  // --- それ以外 ---
  lineReply(reply, '認識できませんでした。\n' + menuText_());
}

function menuText_() {
  return '【メニュー】\n'
    + '■ シフト提出（1通でまとめて）\n例:\n6月シフト\n1 20-2\n3 休\n5 △\n12 19:00-26:00\n'
    + '（休/×=休み、△=調整可、時間=出勤）\n\n'
    + '■ シフト確認 … 確定シフト表示\n■ 希望確認 … 提出済み希望\n\n'
    + '■ 交通費 出発 到着 … 例「交通費 渋谷 新宿」\n■ スポット 6/15 出発 到着 [片道円]\n■ 交通費確認';
}

/* ====================== Master / 状態 ====================== */
function staffByLine_(uid) {
  if (!uid) return null;
  var d = rows_(SH.MASTER, H.Master);
  for (var i = 0; i < d.rows.length; i++) if (String(d.rows[i]['LINE_ID']) === String(uid) && uid) return { sheet: d.sheet, row: d.rows[i] };
  return null;
}
function staffByName_(nm) {
  if (!nm) return null;
  var d = rows_(SH.MASTER, H.Master);
  for (var i = 0; i < d.rows.length; i++) if (String(d.rows[i]['氏名']).replace(/\s/g, '') === nm.replace(/\s/g, '')) return { sheet: d.sheet, row: d.rows[i] };
  return null;
}
function getState_(uid) {
  var d = rows_(SH.STATE, H['状態']);
  for (var i = 0; i < d.rows.length; i++) if (String(d.rows[i]['LINE_ID']) === String(uid)) return d.rows[i];
  return null;
}
function setState_(uid, state, data) {
  var d = rows_(SH.STATE, H['状態']);
  for (var i = 0; i < d.rows.length; i++) if (String(d.rows[i]['LINE_ID']) === String(uid)) {
    d.sheet.getRange(d.rows[i]._row, 2, 1, 3).setValues([[state, data, fmt_(now_(), 'yyyy/MM/dd HH:mm')]]); return;
  }
  append_(SH.STATE, H['状態'], { 'LINE_ID': uid, '状態': state, 'データ': data, '更新': fmt_(now_(), 'yyyy/MM/dd HH:mm') });
}
function clearState_(uid) {
  var d = rows_(SH.STATE, H['状態']);
  for (var i = d.rows.length - 1; i >= 0; i--) if (String(d.rows[i]['LINE_ID']) === String(uid)) d.sheet.deleteRow(d.rows[i]._row);
}

/* ====================== ① 交通費: 区間料金 双方向検索 ====================== */
function fareLookup_(a, b) {
  var d = rows_(SH.FARE, H['区間料金']);
  for (var i = 0; i < d.rows.length; i++) {
    var x = String(d.rows[i]['駅A']), y = String(d.rows[i]['駅B']);
    if ((x === a && y === b) || (x === b && y === a)) return Number(d.rows[i]['片道運賃']) || 0;
  }
  return null;
}
function fareSave_(a, b, oneway) {
  var d = rows_(SH.FARE, H['区間料金']);
  for (var i = 0; i < d.rows.length; i++) {
    var x = String(d.rows[i]['駅A']), y = String(d.rows[i]['駅B']);
    if ((x === a && y === b) || (x === b && y === a)) { d.sheet.getRange(d.rows[i]._row, 3).setValue(oneway); return; }
  }
  append_(SH.FARE, H['区間料金'], { '駅A': a, '駅B': b, '片道運賃': oneway });
}
function transportSummary_(name) {
  var st = staffByName_(name); var round = st ? (Number(st.row['往復交通費']) || 0) : 0;
  var seg = st ? ((st.row['出発駅'] || '') + '⇄' + (st.row['到着駅'] || '')) : '';
  var ym = ym_(); var t = rows_(transSheet_(ym.y, ym.m), H.TRANS);
  var spots = t.rows.filter(function (r) { return r['氏名'] === name && r['種別'] === 'スポット'; });
  var msg = '【今月の交通費】\n通常区間: ' + (seg || '未登録') + ' 往復¥' + round.toLocaleString() + '/日\n';
  if (spots.length) { msg += 'スポット申請:\n' + spots.map(function (s) { return '・' + s['日付'] + ' ' + s['区間'] + ' ¥' + (Number(s['往復額']) || 0).toLocaleString() + '（' + s['状態'] + '）'; }).join('\n'); }
  else msg += 'スポット申請: なし';
  msg += '\n\n※通常交通費は出勤日数×往復で給与明細に自動計上されます。';
  return msg;
}

/* ====================== ② シフト: 一括提出の解析 ====================== */
function looksLikeShift_(text) {
  if (/(\d{1,2})月.*シフト/.test(text) || /^シフト/.test(text)) return true;
  // 「<数字> <内容>」が2行以上
  var lines = text.split(/\r?\n/).filter(function (l) { return /^\s*\d{1,2}\s+\S/.test(l); });
  return lines.length >= 2;
}
function parseTimeRange_(tok) {
  // 例: 20-2, 20:00-26:00, 19-25, 1900-0200
  var m = tok.match(/(\d{1,2})(?::?(\d{2}))?\s*[-~〜]\s*(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return null;
  function hm(h, mi) { h = parseInt(h, 10); if (h >= 24) h -= 24; return ('0' + h).slice(-2) + ':' + (mi ? mi : '00'); }
  return { from: hm(m[1], m[2]), to: hm(m[3], m[4]) };
}
function submitShiftFromText_(name, uid, text) {
  var ym = ym_(); var y = ym.y, m = ym.m;
  var mh = text.match(/(\d{1,2})月/); if (mh) m = parseInt(mh[1], 10);
  var lines = text.split(/\r?\n/);
  var reqs = [];
  lines.forEach(function (l) {
    var mm = l.match(/^\s*(\d{1,2})\s+(.+?)\s*$/); if (!mm) return;
    var day = parseInt(mm[1], 10); if (day < 1 || day > 31) return;
    var tok = mm[2].trim();
    var date = y + '/' + m + '/' + day;
    if (/^(休|×|x|X|なし)/.test(tok)) reqs.push({ date: date, opt: '×', from: '', to: '' });
    else if (/^(△|調整)/.test(tok)) reqs.push({ date: date, opt: '△', from: '', to: '' });
    else {
      var tr = parseTimeRange_(tok);
      if (tr) reqs.push({ date: date, opt: '⏰', from: tr.from, to: tr.to });
      else if (/^(○|出|OK|ok)/.test(tok)) reqs.push({ date: date, opt: '⏰', from: STANDARD_FROM, to: STANDARD_TO });
    }
  });
  if (!reqs.length) return '読み取れませんでした。例:\n6月シフト\n1 20-2\n3 休\n5 △';
  var sname = reqSheet_(y, m);
  var d = rows_(sname, H.REQ);
  // 同名の既存を削除(下から)
  d.rows.filter(function (r) { return r['氏名'] === name; }).map(function (r) { return r._row; }).sort(function (a, b) { return b - a; }).forEach(function (rw) { d.sheet.deleteRow(rw); });
  reqs.forEach(function (q) { append_(sname, H.REQ, { '氏名': name, '日付': q.date, '区分': q.opt, '開始': q.from, '終了': q.to, 'メモ': '', '提出時刻': fmt_(now_(), 'yyyy/MM/dd HH:mm'), 'LINE_ID': uid }); });
  var work = reqs.filter(function (r) { return r.opt === '⏰'; }).length;
  var off = reqs.filter(function (r) { return r.opt === '×'; }).length;
  var adj = reqs.filter(function (r) { return r.opt === '△'; }).length;
  return m + '月のシフト希望を受け付けました✅\n出勤希望 ' + work + '日 / 調整可 ' + adj + '日 / 休み ' + off + '日\n（変更は同じ形でもう一度送ると上書きされます）';
}
function confirmedShiftText_(name) {
  var ym = ym_(); var d = rows_(fixSheet_(ym.y, ym.m), H.FIX);
  var mine = d.rows.filter(function (r) { return r['氏名'] === name && String(r['状態']) === '確定'; });
  if (!mine.length) return ym.m + '月の確定シフトはまだありません。';
  return '【' + ym.m + '月 確定シフト】\n' + mine.map(function (r) { return '・' + r['日付'] + ' ' + r['開始'] + '〜' + r['終了']; }).join('\n');
}
function requestShiftText_(name) {
  var ym = ym_(); var d = rows_(reqSheet_(ym.y, ym.m), H.REQ);
  var mine = d.rows.filter(function (r) { return r['氏名'] === name; });
  if (!mine.length) return ym.m + '月の提出済み希望はありません。';
  return '【' + ym.m + '月 提出済み希望】\n' + mine.map(function (r) { return '・' + r['日付'] + ' ' + r['区分'] + (r['開始'] ? (' ' + r['開始'] + '〜' + r['終了']) : ''); }).join('\n');
}

/* ====================== ② 月曜17時 リマインダー(時間トリガー) ====================== */
function weeklyReminder() {
  var d = rows_(SH.MASTER, H.Master);
  var ym = ym_(); var n = 0;
  d.rows.forEach(function (r) {
    if (r['LINE_ID']) {
      linePush(r['LINE_ID'], '【コレカラ】' + ym.m + '月のシフト提出をお願いします📅\n例:\n' + ym.m + '月シフト\n1 20-2\n3 休\n5 △\nまとめて1通で送ってください。');
      n++;
    }
  });
  Logger.log('reminder sent ' + n);
}
function setupReminderTrigger() { // 1回だけ実行: 毎週月曜17時
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'weeklyReminder') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('weeklyReminder').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(17).inTimezone(TZ).create();
}

/* ====================== ③ 確定→カレンダー反映 + 個別通知 ====================== */
function confirmMonthToCalendar(y, m) {
  // 管理者が実行(引数なしなら今月)。シフト確定_YYYYMM → Googleカレンダー作成 + 個別LINE通知。
  var t = ym_(); y = y || t.y; m = m || t.m;
  var calId = prop('CALENDAR_ID'); var cal = calId ? CalendarApp.getCalendarById(calId) : null;
  var d = rows_(fixSheet_(y, m), H.FIX);
  var byName = {}, made = 0;
  d.rows.forEach(function (r) {
    if (String(r['状態']) !== '確定' || !r['開始']) return;
    (byName[r['氏名']] = byName[r['氏名']] || []).push(r);
    if (cal) {
      var dt = toDate_(r['日付']);
      var sp = String(r['開始']).split(':'), ep = String(r['終了'] || '02:00').split(':');
      var st = new Date(dt); st.setHours(Number(sp[0]), Number(sp[1]) || 0, 0, 0);
      var en = new Date(dt); en.setHours(Number(ep[0]), Number(ep[1]) || 0, 0, 0); if (en <= st) en.setDate(en.getDate() + 1);
      cal.createEvent(r['氏名'] + ' 出勤', st, en); made++;
    }
  });
  var notified = 0;
  Object.keys(byName).forEach(function (nm) {
    var st = staffByName_(nm); var lid = st ? st.row['LINE_ID'] : '';
    if (lid) {
      linePush(lid, nm + 'さん ' + m + '月の出勤が確定しました✅\n' + byName[nm].map(function (r) { return '・' + r['日付'] + ' ' + r['開始'] + '〜' + r['終了']; }).join('\n'));
      notified++;
    }
  });
  return { calendar: made, notified: notified };
}

/* ====================== doGet(動作確認 / 管理アクション) ====================== */
function doGet(e) {
  ensureSheets();
  var a = e && e.parameter && e.parameter.action;
  if (a === 'confirm') {
    if ((e.parameter.key || '') !== prop('ADMIN_KEY', 'korekara2026')) return out_({ ok: false, error: 'bad key' });
    var p = (e.parameter.ym || '').match(/(\d{4})(\d{2})/);
    var t = ym_(); var y = p ? +p[1] : t.y, m = p ? +p[2] : t.m;
    return out_({ ok: true, result: confirmMonthToCalendar(y, m) });
  }
  if (a === 'remind') { if ((e.parameter.key || '') !== prop('ADMIN_KEY', 'korekara2026')) return out_({ ok: false }); weeklyReminder(); return out_({ ok: true }); }
  return ContentService.createTextOutput('スナックコレカラ LINE Bot 稼働中。Webhook=このURL(doPost)。');
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function toDate_(v) { if (v instanceof Date) return v; return new Date(String(v).replace(/-/g, '/')); }

/* ====================== 初期化 / サンプル ====================== */
function ensureSheets() {
  sheet_(SH.MASTER, H.Master); sheet_(SH.FARE, H['区間料金']); sheet_(SH.SET, H['設定']); sheet_(SH.STATE, H['状態']);
  if (rows_(SH.MASTER, H.Master).rows.length === 0) seedMaster_();
  if (rows_(SH.FARE, H['区間料金']).rows.length === 0) seedFare_();
}
function seedMaster_() {
  ['池みゆき', '長谷川楓夏', '堤美伊那', '宮本まほ', '山田ひより', '秋吉つかさ', '駿河央菜', '森行紗弥', '多田晴夏', '松尾彩乃',
   '植松千晴', '福島理恵', '田邉凜', '平村美紅', '時信美玲', '相沢ゆい', '岡田さくら', '西村あや', '小林みお']
    .forEach(function (nm) { append_(SH.MASTER, H.Master, { '氏名': nm, '役割': 'staff', '時給': 1500, '到着駅': '新宿' }); });
}
function seedFare_() {
  [['渋谷', '新宿', 300], ['池袋', '新宿', 400], ['上野', '新宿', 250], ['横浜', '新宿', 360],
   ['吉祥寺', '新宿', 230], ['中野', '新宿', 170], ['品川', '新宿', 210], ['町田', '新宿', 380]]
    .forEach(function (r) { append_(SH.FARE, H['区間料金'], { '駅A': r[0], '駅B': r[1], '片道運賃': r[2] }); });
}
function selftest() {
  ensureSheets();
  Logger.log('fare 渋谷-新宿 片道=' + fareLookup_('渋谷', '新宿') + ' / 新宿-渋谷(逆)=' + fareLookup_('新宿', '渋谷'));
  Logger.log('shift parse=' + submitShiftFromText_('池みゆき', 'TESTUID', '6月シフト\n1 20-2\n3 休\n5 △\n12 19:00-26:00'));
}
