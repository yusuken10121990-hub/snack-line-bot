# スナック「コレカラ」LINEトーク完結 運用Bot（GAS + スプレッドシート + LINE Messaging API）

LIFFは使いません。**すべてLINEのトーク（テキスト）で完結**します。

## できること（トークコマンド）
- **シフト提出（1通でまとめて）**
  ```
  6月シフト
  1 20-2
  3 休
  5 △
  12 19:00-26:00
  ```
  解析ルール：`<日> <内容>`／`休`or`×`=休み、`△`=調整可、時間（`20-2`/`19:00-26:00`/`1900-0200`等）=出勤、`○`=出勤(既定20:00〜翌2:00)。1行目に`6月`等があればその月、無ければ今月。同じ形で再送すると上書き。
- **シフト確認** … 今月の確定シフトを返信／**希望確認** … 提出済みの希望を返信
- **交通費 出発 到着**（例「交通費 渋谷 新宿」）… 区間料金マスターを**双方向検索**→片道→往復を提示→「はい」で登録（給与明細の交通費に自動加算）。未登録区間は片道運賃を数字で返信→自動で往復計算＆マスター登録。
- **スポット 6/15 出発 到着 [片道円]** … 臨時の交通費を申請（管理者承認待ち）
- **交通費確認** … 今月の通常区間＋スポット申請一覧
- **メニュー/ヘルプ** … 使い方表示
- **友だち追加→「名前 田中花子」** … 登録済み氏名でLINE_IDを自動紐付け

## ③ Googleカレンダー反映＋個別通知
- 管理者が `confirmMonthToCalendar()` 実行（または `…/exec?action=confirm&ym=YYYYMM&key=ADMIN_KEY`）で、`シフト確定_YYYYMM` の確定分を**Googleカレンダーに自動作成＋各スタッフへLINE個別通知**。

## スプレッドシート（自動生成）
ID: `1gINCuthP8anV7TypfRg4i2Fu2NPk_tAqT4-DU_C-yu4`
- `Master`（氏名/LINE_ID/役割/メール/時給/出発駅/到着駅/往復交通費/振込先/登録日）
- `区間料金`（駅A/駅B/片道運賃 … 双方向）
- `シフト希望_YYYYMM`／`シフト確定_YYYYMM`／`交通費_YYYYMM`／`設定`／`状態`
初回アクセスでスタッフ19名・主要区間を自動投入。

---

## ✅ 一回設定（あなたのGoogle/LINE作業）
### A. GASにコードを入れる
1. いただいた既存GASプロジェクト（`…/exec` のもの）を開く（または https://script.google.com で新規）
2. `appsscript.json`（プロジェクト設定で「マニフェストを表示」ON）と `Code.gs` をこのリポジトリの内容に置き換え
3. **プロジェクトの設定 > スクリプト プロパティ** に登録（※トークン等はここに。コードに直書きしない）
   | プロパティ | 値 |
   |---|---|
   | `SPREADSHEET_ID` | 1gINCuthP8anV7TypfRg4i2Fu2NPk_tAqT4-DU_C-yu4 |
   | `LINE_CHANNEL_TOKEN` | （Messaging APIのチャネルアクセストークン） |
   | `LINE_CHANNEL_SECRET` | （チャネルシークレット） |
   | `CALENDAR_ID` | （反映先GoogleカレンダーID・任意） |
   | `ADMIN_KEY` | 任意の管理キー（既定 korekara2026） |
   | `OWNER_LINE_ID` | オーナーのuserId（新規登録通知用・任意） |
4. 「デプロイ > 新しいデプロイ > ウェブアプリ（実行=自分／アクセス=全員）」→ **/exec URL**

### B. LINE側
1. LINE Developers → Messaging APIチャネル → **Webhook URL = 上の /exec URL** を設定し「Webhookの利用」ON、応答メッセージOFF
2. 友だち追加 → 「名前 ○○○○」を送ってスタッフ紐付け

### C. リマインダー（月曜17時自動）
- GASエディタで `setupReminderTrigger` を1回実行（毎週月曜17時に全スタッフへ提出依頼を自動push）

### D. カレンダー連携（任意）
- 反映先カレンダーを用意し `CALENDAR_ID` を設定。確定時に `confirmMonthToCalendar()` を実行（管理メニュー or URL）

## 動作確認
- GASエディタで `selftest` 実行 → ログに「区間検索」「シフト解析結果」が出ればロジックOK。
- LINEで友だち追加→名前送信→「交通費 渋谷 新宿」→「はい」→ Masterに往復登録、を確認。

## 補足
- 任意の全駅間を完全自動で運賃計算するには有料の運賃API（駅すぱあと等）が必要です。本Botは**区間料金マスター（双方向）＋未登録は片道手入力で往復自動**の方式です（`fareLookup_` を差し替えればAPI化可能）。

---

# LIFFアプリ（GitHub Pages・ボタンUI併用）

LIFFは**完全静的HTML（GitHub Pages）**、データは**GAS API（fetch）**経由。GASをLIFFエンドポイントにする方式（400エラー）は使いません。

## 構成
```
[LINE リッチメニュー] → [LIFF(GitHub Pages /docs)] → fetch → [GAS doGet/doPost(JSON)] → [スプレッドシート]
```
- `docs/index.html` … 入口（あいさつ＋大ボタン3つ）
- `docs/shift.html` … シフト提出（カレンダーUI・○△×・時間ピッカー）
- `docs/transit.html` … 交通費登録（駅サジェスト・双方向検索・往復自動）
- `docs/confirm.html` … 確定シフト確認（今月/来月・合計日数）
- `docs/admin.html` … **管理用シフト一覧**（提出された希望を 日付順/スタッフ順 で表示・管理キー保護）
- `docs/app.js` / `docs/style.css` … 共通

### 管理シフト一覧
- URL: `https://yusuken10121990-hub.github.io/snack-line-bot/admin.html`
- 初回に**管理キー**（GASの `ADMIN_KEY`・既定 `korekara2026`）を入力 → 当月/来月の提出を、**日付ごと（誰が何時〜何時）/ スタッフごと**に一覧表示。
- データ元はLIFF/LINE提出と同じ `シフト希望_YYYYMM` シート（GAS API `adminShifts`）。

## GAS API（doGet/doPost に追加済み）
| メソッド | action | 返り値 |
|---|---|---|
| GET | `profile&userId=` | `{ok,name,transit:{from,to,round}}` |
| GET | `getShiftRequest&userId=&ym=YYYYMM` | `{ok,requests:[{date,opt,from,to}]}` |
| GET | `getConfirmedShift&userId=&ym=YYYYMM` | `{ok,fixes:[{date,from,to}]}` |
| GET | `lookupFare&from=&to=` | `{ok,found,oneway}` |
| GET | `stationList` | `{ok,stations:[]}` |
| POST | body`{action:'submitShift',userId,ym,requests}` | `{ok,message}` |
| POST | body`{action:'saveTransit',userId,from,to,oneway}` | `{ok,round}` |

**CORS対策**：GASのGETはクロスオリジン取得可。POSTは LIFF 側で `fetch(GAS_URL,{method:'POST',body:JSON.stringify(...)})` と**ヘッダー無し（text/plain扱い＝プリフライト無し）**で送るので追加CORS設定不要。

## GitHub Pages デプロイ手順
1. このリポジトリに `docs/` を配置（済）
2. GitHub → リポジトリ **Settings → Pages**
   - Source: **Deploy from a branch**
   - Branch: **main** / folder: **/docs**（※GitHub Pagesはroot か /docs のみ選択可。/webは不可のため /docs を使用）
3. 公開URL: **https://yusuken10121990-hub.github.io/snack-line-bot/**
4. LINE Developers Console → LIFF（ID `2010418983-tAsscHwB`）
   - **エンドポイントURL** を `https://yusuken10121990-hub.github.io/snack-line-bot/` に変更
   - サイズ Full / scope: profile
5. リッチメニューの「シフト提出」等のリンクを **LIFF URL**（`https://liff.line.me/2010418983-tAsscHwB`）に設定
6. 動作確認：LINEからLIFFを開く→ 名前表示→ シフト提出/交通費/確認

> ブラウザ単体テスト：`…github.io/snack-line-bot/?uid=<LINEのuserId>` でLIFFなしでも各APIを確認できます（userIdはMasterに紐付け済みのもの）。
