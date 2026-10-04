# 交接：新增星展、聯邦、Richart 連接器

> 這是暫時的工作交接文件，供沒有先前對話記憶的新 session 接手。三個連接器都完成並合併後，請刪除本文件。
> 最後更新：2026-10-04（台灣時間）

## 0. 新 session 先做這些

1. 讀根目錄 `AGENTS.md`，裡面有專案規範、目錄責任，以及**提交前必跑的檢查**。
2. 讀 `docs/004-connector-development.md`，特別是「新增流程」，以及文末的「將來銀行」「匯豐銀行」「Richart」三節。
3. 切到工作分支：
   ```bash
   git fetch origin claude/bold-dirac-c3ccja
   git checkout claude/bold-dirac-c3ccja
   ```
4. 提交前從 repo root 依序跑：`npm run format:check` → `npm run typecheck` → `npm run test:backend` → `npm run test:unit`（有改前端時）→ `npm run build`。
5. Code review、PR 說明、commit 訊息都用正體中文。

## 1. 需求

使用者要新增三個**只讀取資料**的銀行連接器，任何轉帳或寫入操作都不接：

| 連接器 ID | 銀行                                                         | 使用者提供的登入欄位                                                               |
| --------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `richart` | Richart（台新數位帳戶，與既有的 `taishin` 信用卡連接器分開） | 身分證字號、使用者代號（6～16 英數）、使用者密碼（6～16 英數）、4 位數字圖形檢核碼 |
| `dbs`     | 星展銀行 digibank 個人網銀                                   | 使用者代號、密碼；銀行可能有條件地要求簡訊 OTP                                     |
| `ubot`    | 聯邦銀行個人網銀                                             | 身分證字號、使用者代號、網路密碼、6 位圖形驗證碼                                   |

使用者在意的事：

- 驗證碼先由 Workers AI 自動辨識，失敗時改成人工輸入。
- 銀行臨時要求 OTP 時，顯示「需要人工驗證」，**排程同步不得主動觸發寄送 OTP**。
- 使用者的瀏覽器在這些銀行網站**無法開 DevTools**。替代方案是 附錄 B 的 `capture-har.mjs`：一支 Playwright 錄製腳本，在本機手動登入就能存下去識別化的 HAR。
- 使用者計畫先在本地（`npm run dev`，使用獨立的開發 D1）測試，再合併部署。

## 2. 已完成（在 `claude/bold-dirac-c3ccja` 上）

| Commit    | 內容                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `c3ab4d9` | Richart 端對端加密 `apps/worker/src/sources/richart/e2ee.ts`，附測試                                                                   |
| `2ec52ac` | **Richart 連接器完整實作**：後端、路由、catalog、前端、migration `0053_richart_sync_job.sql`、README、`docs/004` 的 Richart 章節、測試 |
| `1880350` | 星展登入密碼的 RSA 區塊加密 `apps/worker/src/sources/dbs/password.ts`，附測試                                                          |

這些 commit 推送前都跑過 `format:check`、`typecheck`、`test:backend`、`test:unit`、`build`，全部通過。

### 2.1 Richart：狀態與待確認事項

- 規格細節以 `docs/004-connector-development.md` 的「Richart」章節為準。
- **尚未用真實帳號登入過。** 端點和欄位都是從公開的前端 bundle 推出來的；只有加密已用官方 JS 產生的向量驗證過。
- 使用者測試後，請優先確認：
  1. `getSavingAccount` 的欄位 `account`、`balance`、`balanceAvailable` 是否存在。
  2. `getTransaction` 每筆交易的實際欄位：`date` 和 `amount` 已確認；說明文字欄位目前依序猜 `title`、`content`、`memo`、`postScript`，餘額欄位猜 `balance`。
  3. 某月份沒有交易時，是否仍回傳空的 `transLogList`。目前缺少這個欄位會被視為格式錯誤，整次同步失敗。
  4. 活存 `balance` 是否已包含罐子 `subAccountOverview.totalAmount`。目前假設不包含、分開記錄；若實際已包含，資產會重複計算。
  5. `isRepeated`／`login` 送出時，是否需要 `X-XSRF-TOKEN` 或其他標頭。
- 加密有一個邊界情況還沒驗證：ECDH 共享金鑰的 X 座標第一個 byte 為 0 時（約 1/256 機率），官方 `elliptic` 可能輸出 31 bytes，WebCrypto 固定輸出 32 bytes，兩者會算出不同的金鑰。上一個 session 跑的 3000 次比對因超時中止、沒有結果。若真實登入偶發「密碼錯誤」，先查這裡。注意密碼錯誤會累積錯誤次數。
- 失敗時 Worker log 會印出 `richart_api_error`，內容只有操作名稱、錯誤類型和銀行錯誤代碼，可以依此定位問題。
- 尚未接入：外幣活存（`/HistoryService/getNtdAndForCurAccountInfo`）、外幣定存（`/DepositService/getFrDepositOverviewForWebBank`）。

### 2.2 星展：已完成的部分

- `password.ts`：區塊格式為「隨機填充（第 0、1、10 byte 固定為 00、02、00；其餘若為 0 改成 0x27）＋伺服器給的 random＋30 bytes 密碼（不足補 0xFF）」，再以 e=65537 做未填充 RSA，輸出補零到模數長度的 hex。測試向量在 `apps/worker/tests/sources/dbs/fixtures/password-vector.ts`。
- 2026-10-04 實測過：登入前的 `POST /iam/v2/random` 和 `POST /iam/v1/publickey/CN2048` 用一般 HTTP 呼叫都會回 200，沒有被 Cloudflare 擋。公鑰回應包含 512 位 hex 的 `modulus`（2048-bit）與 `exponent: "010001"`。因此星展可以比照 Richart 直接呼叫 API，不需要 Browser Rendering。

### 2.3 沒有提交的前端改動（以 patch 保存）

附錄 A 的 patch 把 `ConnectorPanel.svelte` 原本兆豐專用的簡訊 OTP 步驟改成兆豐與星展共用：

- 變數 `megabankOtp*` 改名為 `smsOtp*`。
- 新增 `smsOtpConnector`，判斷 `megabank` 或 `dbs`；新增 `smsOtpBankName`。
- OTP 送出改打 `/api/connectors/${connectorId}/sync`。
- `browser-captcha.ts` 的 `isSmsOtpRequired` 改為接受 `MEGABANK_SMS_OTP_REQUIRED` 和 `DBS_SMS_OTP_REQUIRED`；`smsOtpFailure` 改為接受 `MEGABANK_OTP_INVALID` 和 `DBS_OTP_INVALID`。

這個 patch 要在 `shared/connector-catalog.ts` 加入 `dbs` 之後才能通過型別檢查。套用方式：

```bash
# 把附錄 A 的 diff 區塊存成 /tmp/dbs-sms-otp-frontend.patch
git apply /tmp/dbs-sms-otp-frontend.patch
```

## 3. 待辦

### 3.1 星展 `dbs`（下一個要做）

**注意：** 上一個 session 在寫星展的登入／OTP API client 時，被安全分類器中斷。請由使用者決定這部分怎麼進行：使用者自己寫，或在使用者明確同意後再實作。可以先做下面不涉及登入的部分。

建議模式為 `api_credentials`。若要保存 OTP 待驗證狀態，可參考兆豐的 `pendingSession` 做法，或依 `docs/004` 的規範另行評估。

需要的註冊點與匯豐、Richart 相同（可參考 commit `2ec52ac` 的檔案清單）：

- `shared/connector-catalog.ts`
- `sources/config-registry.ts`
- `features/sync/registry.ts`
- `features/sync/route.ts`
- `features/notifications/payload.ts`
- `features/bank/display.ts`：銀行代碼 810
- `features/sync/connector-repository.ts` 的 `DIRECT_DEPOSIT_CONNECTOR_IDS`
- migration `0054_dbs_sync_job.sql`
- 前端 `definitions.ts`、`summary.ts`、`ConnectorPanel.svelte`、`schedule-after-sync.ts`
- README、`docs/004`

前端可以先套用 2.3 的 patch。星展沒有圖形驗證碼，**不要**放進 `ConnectorPanel` 的 `browserBank` 清單（那會顯示「人工重新驗證」按鈕），走一般的同步按鈕即可。簡訊 OTP 輸入框在 `browserBank` 區塊之外，可以共用。

從公開 bundle（`https://internet-banking.dbs.com.tw/digitw/` 的 `assets/js/index.<hash>.js`）整理出的資料端點如下。標記說明：[C] 已在程式碼確認，[I] 推測。

- **API 基底：** `https://internet-banking.dbs.com.tw/api/tw/v1`。
- **共用標頭：**
  - `Content-Type: application/json`
  - `clientId: web`
  - `channelId: DIB`
  - `correlationId`：每次請求產生一個 UUID
  - `actionId`：每支 API 各自不同
  - `Authorization: Bearer <access_token>`
  - `customerId`：取自回應標頭 `customerid`，之後每次請求都帶回 [C]
- **帳戶總覽：** `GET /dashboard/channels/customerFinancialOverview/assets`，`actionId: DASHBOARD-ASSET`，`x-version: 3.0.0`。
  - 回應結構：`{ casa: { accounts: [] }, fixedDeposit: { accounts: [] }, investment: {...}, insurance: { policies: [] } }` [C]
  - 活存帳戶欄位：`globalAccountId`、`accountId`、`displayAccountNumber`、`accountName`、`accountNickname`、`accountType`（`single`／`multi`／`sub`）、`currency`、`availableBalance`、`schemeName`、`masterGlobalAccountId`；多幣別帳戶的各幣別錢包在 `subAccounts[]` [C]
  - `availableBalance` 是數字、字串還是 `{balance, currency}` 物件，尚未確認 [I]
- **定存清單：** `GET /product-data-mapper/channels/fd-accounts`。
  - 欄位：`accountId`、`globalAccountId`、`principalBalance`、`availableBalance`、`maturityDate`、`periodMonths`、`displayAccountNumber` [C]
- **交易明細：** `POST /deposit-accounts-transactions-service/banking/deposit-accounts/transactions-history/inquiry`，`actionId: DEPOSIT-TXN-HISTORY`，`X-Version: 1.2.0`。
  - 請求 body：`{ globalAccountId, currencyWallet: "TWD", fromDate: { value: "2026-07-01T00:00:00+0800", format: "yyyy-MM-dd'T'HH:mm:ssZ" }, toDate: {...}, previouscursor: "", cursorID: "0", countPerPage: 20 }` [C]
  - 回應：`{ globalAccountId, pageInfo: { nextCursor, totalRecords }, records: [] }`；`nextCursor > 0` 代表還有下一頁 [C]
  - 每筆交易欄位：`side`、`amount: { balance, currency }`、`description: { textValue }`、`particular: { code, description[] }`、`transactionDate: { value }`、`postedDate: { value }`、`valueDate: { value }`、`transactionsequencenumber`、`runningBalance: { balance }`、`transactionReferenceNumber`、`remarks` [C]
  - **正負號：** `side` 符合 `/(D|DEBIT)$/i` 為支出，存成負數；其餘為存入，存成正數 [C]
  - 多幣別錢包查詢時，`globalAccountId` 應該帶子錢包自己的，還是主帳戶的，尚未確認 [I]
- **登出：** `POST https://internet-banking.dbs.com.tw/iam/v1/realms/tw/sessions?_action=logout`，`actionId: LOGOUT`。
- **信用卡：** 卡片明細由外部的 CardPlus 系統透過 SSO 提供，第一版不做。
- **登入流程摘要**（細節請由負責實作的人自行從 bundle 確認）：
  - 驗證後端是 ForgeRock AM：random → publickey → `authIndexValue=1fa` 驗證 → 視情況走 `2fa-sms-otp` → 以 `commCode` 換 `access_token`。
  - 1FA 回應帶 `commCode` 代表不需要 OTP。
  - 需要 OTP 時，回應的 `messageCode` 不等於成功值，並帶回 ForgeRock `callbacks`（`OTP_NUMBER` 等）。
  - 狀態碼：`8001` OTP 錯誤、`8002` OTP 逾時、`8009` OTP 錯誤次數過多、`9021` 重複登入、`17` 帳戶鎖定、`98` 帳戶停用。

### 3.2 聯邦 `ubot`

**必須使用 Browser Rendering（`browser_captcha_session`，參考永豐、華南）**，原因是：

- 網站前有 Cloudflare 與 F5 BIG-IP ASM WAF（cookie `TS01b93f6c`）。
- 每個請求都會經過一支會輪替的反機器人腳本 `/en476f6c.js`（`en.enFn1(req)`）改寫，直接 fetch 很可能被擋。

建議做法：在頁面內完成「驗證碼 → 加密 → 登入」，之後在同源頁面內呼叫 JSON API。Browser Run 免費額度每天台灣時間早上 8 點重置。

已知資訊（來自 `https://mybank.ubot.com.tw/ubot/` 的 Vue SPA，[C] 為已在程式碼確認）：

- **API 基底：** `https://mybank.ubot.com.tw/MyBank/<代碼>`，一律 POST JSON。
- **回應：** `{ RespCode: { RtnCode, RtnDesc }, RespBody: {...} }`；成功為 `RtnCode == "0000"`（部分畫面也接受 `MA05`）。
- **登入：**
  - 驗證碼：`IBKQ000001` 回傳 `RespBody.imgBase64`（JPEG），6 碼。
  - 密碼公鑰：`GetPublicKey`。
  - 酬載金鑰：`IBKCM000003` 回傳 `k1`、`k2`。
  - 登入：`IBKI000001`，回應 `RespBody.SessionId` 與 `Sid`。
  - 登入之後的請求，body 會自動帶入 `sid`、`sessionId`，標頭帶 `x-ubotsn: btoa(身分證字號.slice(2))`。
- **單一登入：** `PS014` 代表在其他地方登入，`PS013` 代表逾時。閒置約 10 分鐘會逾時；保持連線用 `RefreshSession`。
- **登出：** `IBKI000002`。
- **唯讀查詢：**
  - 台幣帳戶：`IBKB010101` 回傳 `NTList`。
  - 台幣明細：`IBKB010102 {acctNo, beginDate, endDate}`，日期格式 `YYYYMMDD`，一次最多 3 個月。回應 `NTDetailList[]`，欄位：`TraDate`、`TraTime`、`AccountDate`、`Summary`、`Expenditure`（支出）、`Income`（存入）、`Balance`、`TraSum`、`PS`。支出與存入是兩個不同欄位，金額可能被遮罩成 `*******100.00`。
  - 外幣：`IBKB050101`、`IBKB050102 {acctNo, beginDate, endDate, currency: "99"}`。
  - 台幣定存：`IBKB020101`、`IBKB020102 {acctNo}` 回傳 `CtList`。
  - 總覽：`IBKA010001`（台幣）、`IBKA010002`（外幣）、`IBKA010003`（信用卡）。
  - 信用卡帳單：`IBKF020101 {month: "4"}` 回傳 `DateList`；`IBKF020102 {date}` 回傳 `CardHeader`（`stmtDate`、`dueDate`、`currBal`、`dueAmt`）與 `CardList[]`（`postDate`、`effectDate`、`txDesc`、`txAmt`）。未出帳：`IBKF030001`。
- 以上回應格式都只來自靜態分析，需用一次真實登入或 HAR 確認。

## 4. 研究方法（重新取得證據用）

上一個 session 下載的 bundle 存在已失效的容器裡，需要時請重新下載。

- 環境的網路 allowlist 需包含 `internet-banking.dbs.com.tw`、`www.dbs.com.tw`、`mybank.ubot.com.tw`、`www.ubot.com.tw`、`richart.tw`。
- 驗證加密實作的做法：
  1. 把銀行的原始 JS 用 Node `vm` 載入。
  2. 用合成金鑰（必要時把 `Math.random` 固定）產生測試向量。
  3. 用私鑰解開，確認區塊格式。
  4. 確認自己的 TypeScript 實作在相同輸入下輸出完全相同。
- 不要送出真實帳密，也不要在 log、fixture、commit 中留下帳號或 token。

## 5. 使用者端待辦

- 用 `npm run dev` 在本地測試 Richart 同步，把結果或 `richart_api_error` log 交給接手的 session。
- 星展、聯邦需要時，把 附錄 B 的 `capture-har.mjs` 複製到 repo 外的空資料夾，依檔頭說明安裝 Playwright 後執行 `node capture-har.mjs <dbs|ubot|richart>` 錄 HAR。腳本會先自動去識別化；傳出前仍要手動檢查姓名、地址、電話。

## 附錄 A：兆豐／星展共用簡訊 OTP 前端 patch

```diff
diff --git a/apps/web/src/features/settings/connectors/ConnectorPanel.svelte b/apps/web/src/features/settings/connectors/ConnectorPanel.svelte
index dec1dc4..4c18d48 100644
--- a/apps/web/src/features/settings/connectors/ConnectorPanel.svelte
+++ b/apps/web/src/features/settings/connectors/ConnectorPanel.svelte
@@ -39,8 +39,8 @@
   import {
     browserCaptchaFailure,
     isManualCaptchaRequired,
-    isMegabankOtpRequired,
-    megabankOtpFailure,
+    isSmsOtpRequired,
+    smsOtpFailure,
     needsNextbankCaptcha,
   } from "./browser-captcha";
   import { shouldEnableScheduleAfterFirstSync } from "./schedule-after-sync";
@@ -87,12 +87,12 @@
   let bankCaptcha = $state("");
   let bankCaptchaDigitCount = $state(6);
   let bankCaptchaKind = $state<"numeric" | "alphanumeric">("numeric");
-  let megabankOtpStep = $state(false);
-  let megabankOtpMessage = $state("");
-  let megabankOtp = $state("");
-  let megabankOtpExpiresAt = $state<number | null>(null);
-  let megabankOtpSecondsRemaining = $state(0);
-  const MEGABANK_OTP_WINDOW_MS = 3 * 60_000;
+  let smsOtpStep = $state(false);
+  let smsOtpMessage = $state("");
+  let smsOtp = $state("");
+  let smsOtpExpiresAt = $state<number | null>(null);
+  let smsOtpSecondsRemaining = $state(0);
+  const SMS_OTP_WINDOW_MS = 3 * 60_000;
   let pendingSyncTarget = $state<SyncTarget>("default");
   let einvoiceSyncQueued = $state(false);
   let einvoiceSyncQueuedTimer: ReturnType<typeof setTimeout> | undefined;
@@ -126,9 +126,13 @@
   const browserBankSessionAvailable = $derived(
     browserBank && Boolean($settings.data?.sessionAvailable),
   );
-  const megabankOtpActive = $derived(
-    connectorId === "megabank" && megabankOtpStep,
+  const smsOtpConnector = $derived(
+    connectorId === "megabank" || connectorId === "dbs",
   );
+  const smsOtpBankName = $derived(
+    connectorId === "dbs" ? "星展銀行" : "兆豐銀行",
+  );
+  const smsOtpActive = $derived(smsOtpConnector && smsOtpStep);
   const tdccConnectionReady = $derived(
     connectorId === "tdcc" && Boolean($settings.data?.sessionAvailable),
   );
@@ -206,7 +210,7 @@
       bankCaptchaSeconds = bankCaptchaExpiresAt
         ? Math.max(0, Math.ceil((bankCaptchaExpiresAt - Date.now()) / 1000))
         : 0;
-      updateMegabankOtpCountdown();
+      updateSmsOtpCountdown();
     }, 1_000);
     return () => clearInterval(timer);
   });
@@ -330,11 +334,11 @@
     onError: (e) => {
       if (handleTdccVerificationRequired(e)) return;
       if (handleCathayVerificationRequired(e)) return;
-      if (connectorId === "megabank" && isMegabankOtpRequired(e)) {
-        enterMegabankOtp(
+      if (smsOtpConnector && isSmsOtpRequired(e)) {
+        enterSmsOtp(
           e instanceof Error
             ? e.message
-            : "兆豐銀行已寄出簡訊驗證碼，請於三分鐘內輸入。",
+            : `${smsOtpBankName}已寄出簡訊驗證碼，請於三分鐘內輸入。`,
         );
         qc.invalidateQueries({
           queryKey: queryKeys.connectorSettings(connectorId),
@@ -458,11 +462,11 @@
         qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
         return;
       }
-      if (connectorId === "megabank" && isMegabankOtpRequired(e)) {
-        enterMegabankOtp(
+      if (smsOtpConnector && isSmsOtpRequired(e)) {
+        enterSmsOtp(
           e instanceof Error
             ? e.message
-            : "兆豐銀行已寄出簡訊驗證碼，請於三分鐘內輸入。",
+            : `${smsOtpBankName}已寄出簡訊驗證碼，請於三分鐘內輸入。`,
         );
         qc.invalidateQueries({
           queryKey: queryKeys.connectorSettings(connectorId),
@@ -480,20 +484,20 @@
       }
     },
   });
-  const verifyMegabankOtp = createMutation({
+  const verifySmsOtp = createMutation({
     onMutate: () => ({
       enableSchedule: shouldEnableScheduleAfterFirstSync(connectorId, job),
     }),
     mutationFn: () => {
       if (demoMode) throw new Error("Demo site 已停用連接器同步。");
-      const trimmed = megabankOtp.trim();
+      const trimmed = smsOtp.trim();
       if (!/^\d{4,8}$/.test(trimmed))
         throw new Error("請輸入簡訊收到的 4-8 位數字驗證碼。");
-      return api.post(`/api/connectors/megabank/sync`, { otp: trimmed });
+      return api.post(`/api/connectors/${connectorId}/sync`, { otp: trimmed });
     },
     onSuccess: (_data, _variables, context) => {
       error = "";
-      resetMegabankOtp();
+      resetSmsOtp();
       bankCaptcha = "";
       bankCaptchaImage = "";
       qc.invalidateQueries({
@@ -507,16 +511,16 @@
       enableScheduleAfterSuccessfulSync(context.enableSchedule);
     },
     onError: (e) => {
-      if (megabankOtpFailure(e) === "retry") {
-        megabankOtp = "";
+      if (smsOtpFailure(e) === "retry") {
+        smsOtp = "";
         error =
           e instanceof Error
             ? e.message
-            : "兆豐銀行簡訊驗證碼不正確，請重新輸入。";
+            : `${smsOtpBankName}簡訊驗證碼不正確，請重新輸入。`;
         return;
       }
       const failure = browserCaptchaFailure(e);
-      resetMegabankOtp();
+      resetSmsOtp();
       error = failure.message;
       qc.invalidateQueries({
         queryKey: queryKeys.connectorSettings(connectorId),
@@ -688,35 +692,35 @@
     $sync.mutate("default");
   }

-  function enterMegabankOtp(message: string) {
+  function enterSmsOtp(message: string) {
     error = "";
     bankCaptcha = "";
     bankCaptchaImage = "";
-    megabankOtp = "";
-    megabankOtpMessage = message;
-    megabankOtpStep = true;
-    megabankOtpExpiresAt = Date.now() + MEGABANK_OTP_WINDOW_MS;
-    megabankOtpSecondsRemaining = Math.ceil(MEGABANK_OTP_WINDOW_MS / 1_000);
+    smsOtp = "";
+    smsOtpMessage = message;
+    smsOtpStep = true;
+    smsOtpExpiresAt = Date.now() + SMS_OTP_WINDOW_MS;
+    smsOtpSecondsRemaining = Math.ceil(SMS_OTP_WINDOW_MS / 1_000);
   }

-  function resetMegabankOtp() {
-    megabankOtpStep = false;
-    megabankOtp = "";
-    megabankOtpMessage = "";
-    megabankOtpExpiresAt = null;
-    megabankOtpSecondsRemaining = 0;
-    $verifyMegabankOtp.reset();
+  function resetSmsOtp() {
+    smsOtpStep = false;
+    smsOtp = "";
+    smsOtpMessage = "";
+    smsOtpExpiresAt = null;
+    smsOtpSecondsRemaining = 0;
+    $verifySmsOtp.reset();
   }

-  function updateMegabankOtpCountdown() {
-    if (!megabankOtpStep || megabankOtpExpiresAt === null) return;
-    megabankOtpSecondsRemaining = Math.max(
+  function updateSmsOtpCountdown() {
+    if (!smsOtpStep || smsOtpExpiresAt === null) return;
+    smsOtpSecondsRemaining = Math.max(
       0,
-      Math.ceil((megabankOtpExpiresAt - Date.now()) / 1_000),
+      Math.ceil((smsOtpExpiresAt - Date.now()) / 1_000),
     );
-    if (megabankOtpSecondsRemaining <= 0) {
-      error = "兆豐簡訊驗證碼已逾時，請重新取得驗證碼。";
-      resetMegabankOtp();
+    if (smsOtpSecondsRemaining <= 0) {
+      error = `${smsOtpBankName}簡訊驗證碼已逾時，請重新同步。`;
+      resetSmsOtp();
     }
   }

@@ -930,7 +934,7 @@
             disabled={demoMode ||
               $sync.isPending ||
               $verifyBrowserBank.isPending ||
-              megabankOtpActive}
+              smsOtpActive}
             onclick={() => {
               error = "";
               $sync.mutate("default");
@@ -945,7 +949,7 @@
             disabled={demoMode ||
               $prepareBrowserBank.isPending ||
               $verifyBrowserBank.isPending ||
-              megabankOtpActive}
+              smsOtpActive}
             onclick={() => {
               error = "";
               $prepareBrowserBank.mutate();
@@ -961,7 +965,7 @@
               $sync.isPending ||
               $prepareBrowserBank.isPending ||
               $verifyBrowserBank.isPending ||
-              megabankOtpActive}
+              smsOtpActive}
             onclick={() => {
               error = "";
               $sync.mutate("default");
@@ -977,7 +981,7 @@
               $sync.isPending ||
               $prepareBrowserBank.isPending ||
               $verifyBrowserBank.isPending ||
-              megabankOtpActive}
+              smsOtpActive}
             onclick={() => {
               error = "";
               $prepareBrowserBank.mutate();
@@ -1668,7 +1672,7 @@
       {/if}
     </div>
   {/if}
-  {#if megabankOtpActive}
+  {#if smsOtpActive}
     <div
       class="mt-3 overflow-hidden rounded-xl border border-steel/20 bg-steel/[0.055]"
     >
@@ -1681,10 +1685,10 @@
         <div>
           <p class="text-sm font-semibold text-fg">簡訊驗證碼已寄出</p>
           <p class="mt-0.5 text-sm leading-relaxed text-fg/60">
-            {megabankOtpMessage}
+            {smsOtpMessage}
           </p>
           <p class="mt-1 text-xs font-semibold text-steel" aria-live="polite">
-            請於 {cathayCountdownLabel(megabankOtpSecondsRemaining)} 內完成驗證
+            請於 {cathayCountdownLabel(smsOtpSecondsRemaining)} 內完成驗證
           </p>
         </div>
       </div>
@@ -1698,19 +1702,18 @@
             pattern={"[0-9]{4,8}"}
             maxlength={8}
             placeholder="4-8 位數字驗證碼"
-            bind:value={megabankOtp}
+            bind:value={smsOtp}
           />
         </label>
         <Button
           class="self-end"
           size="sm"
-          disabled={$verifyMegabankOtp.isPending ||
-            !/^\d{4,8}$/.test(megabankOtp.trim())}
+          disabled={$verifySmsOtp.isPending || !/^\d{4,8}$/.test(smsOtp.trim())}
           onclick={() => {
             error = "";
-            $verifyMegabankOtp.mutate();
+            $verifySmsOtp.mutate();
           }}
-          ><ShieldCheck class="size-4" />{$verifyMegabankOtp.isPending
+          ><ShieldCheck class="size-4" />{$verifySmsOtp.isPending
             ? "驗證並同步中…"
             : "驗證並同步"}</Button
         >
@@ -1723,7 +1726,7 @@
           class="text-sm font-semibold text-fg/55 underline-offset-4 hover:text-fg hover:underline"
           onclick={() => {
             error = "";
-            resetMegabankOtp();
+            resetSmsOtp();
           }}>取消</button
         >
       </div>
diff --git a/apps/web/src/features/settings/connectors/browser-captcha.ts b/apps/web/src/features/settings/connectors/browser-captcha.ts
index ce97aa1..ff40662 100644
--- a/apps/web/src/features/settings/connectors/browser-captcha.ts
+++ b/apps/web/src/features/settings/connectors/browser-captcha.ts
@@ -42,21 +42,22 @@ export function needsNextbankCaptcha(connectorId: string, error: unknown) {
   );
 }

-/** 兆豐登入成功後，銀行要求輸入簡訊驗證碼；伺服器暫時保留已登入的工作階段。 */
-export function isMegabankOtpRequired(error: unknown) {
+/** 兆豐、星展登入時銀行要求輸入簡訊驗證碼；伺服器暫時保留登入中的工作階段。 */
+export function isSmsOtpRequired(error: unknown) {
   return (
     error instanceof ApiRequestError &&
-    error.code === "MEGABANK_SMS_OTP_REQUIRED"
+    (error.code === "MEGABANK_SMS_OTP_REQUIRED" ||
+      error.code === "DBS_SMS_OTP_REQUIRED")
   );
 }

 /**
- * 兆豐簡訊驗證碼送出後失敗時的下一步：驗證碼本身錯誤可原地重新輸入，
+ * 兆豐、星展簡訊驗證碼送出後失敗時的下一步：驗證碼本身錯誤可原地重新輸入，
  * 其餘情況（工作階段逾時、連線失敗、同步中等）一律回到初始狀態重新取得驗證碼。
  */
-export function megabankOtpFailure(error: unknown): "retry" | "reset" {
+export function smsOtpFailure(error: unknown): "retry" | "reset" {
   return error instanceof ApiRequestError &&
-    error.code === "MEGABANK_OTP_INVALID"
+    (error.code === "MEGABANK_OTP_INVALID" || error.code === "DBS_OTP_INVALID")
     ? "retry"
     : "reset";
 }
```

## 附錄 B：不需 DevTools 的 HAR 錄製腳本 `capture-har.mjs`

```js
// 不開 DevTools 錄製網銀流量並輸出去識別化 HAR。
// 用法（請複製到 repo 外的空資料夾執行，避免改動專案相依）：
//   npm init -y && npm i playwright && npx playwright install chromium
//   node capture-har.mjs dbs      # 或 ubot、richart
// 在開出的瀏覽器手動登入、看帳戶與明細、登出，然後回終端機按 Enter。
import { chromium } from "playwright";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

const BANKS = {
  dbs: {
    url: "https://internet-banking.dbs.com.tw/digitw/",
    host: /dbs\.com\.tw/,
  },
  ubot: { url: "https://mybank.ubot.com.tw/", host: /ubot\.com\.tw/ },
  richart: {
    url: "https://richart.tw/TSDIB_RichartWeb/RC00/RC000000",
    host: /richart\.tw/,
  },
};

const bank = BANKS[process.argv[2]];
if (!bank) {
  console.error("用法：node capture-har.mjs <dbs|ubot|richart>");
  process.exit(1);
}

const rawPath = `${process.argv[2]}-raw.har`;
const outPath = `${process.argv[2]}-sanitized.har`;

const browser = await chromium.launch({
  headless: false,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  recordHar: { path: rawPath, content: "embed", urlFilter: bank.host },
  locale: "zh-TW",
  viewport: { width: 1280, height: 860 },
});
const page = await context.newPage();
await page.goto(bank.url);

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question(
  "請在瀏覽器完成：登入 → 帳戶總覽 → 一個帳戶最近 3 個月明細 →（有卡則）信用卡帳單 → 登出。\n完成後按 Enter…",
);
rl.close();
await context.close();
await browser.close();

const har = JSON.parse(await readFile(rawPath, "utf8"));
await rm(rawPath);

const SECRET_HEADER =
  /^(cookie|set-cookie|authorization|.*token.*|.*csrf.*|.*session.*)$/i;
const SECRET_FIELD =
  /pass|pwd|pin|custid|cust_id|userid|user_id|uid|loginid|idno|id_no|captcha|chk|otp|token|key|sign|encrypt|cipher/i;
const TW_ID = /\b[A-Z][12890]\d{8}\b/g;
const LONG_DIGITS = /\b(\d{6,})(\d{4})\b/g;

function maskText(text) {
  return text
    .replace(TW_ID, "A123456789")
    .replace(LONG_DIGITS, (_, head, tail) => "0".repeat(head.length) + tail);
}

function maskFields(text) {
  try {
    const json = JSON.parse(text);
    return JSON.stringify(maskJson(json));
  } catch {
    const params = new URLSearchParams(text);
    if ([...params.keys()].length === 0) return maskText(text);
    for (const [key] of params) {
      if (SECRET_FIELD.test(key)) params.set(key, "<redacted>");
    }
    return maskText(params.toString());
  }
}

function maskJson(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => maskJson(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskJson(v, k)]),
    );
  }
  if (typeof value === "string") {
    return SECRET_FIELD.test(key) ? "<redacted>" : maskText(value);
  }
  return value;
}

for (const entry of har.log.entries) {
  const { request, response } = entry;
  request.headers = request.headers.filter((h) => !SECRET_HEADER.test(h.name));
  response.headers = response.headers.filter(
    (h) => !SECRET_HEADER.test(h.name),
  );
  request.cookies = [];
  response.cookies = [];
  request.url = maskText(request.url);
  request.queryString = (request.queryString ?? []).map((q) => ({
    ...q,
    value: SECRET_FIELD.test(q.name) ? "<redacted>" : maskText(q.value),
  }));
  if (request.postData?.text) {
    request.postData.text = maskFields(request.postData.text);
    delete request.postData.params;
  }
  const content = response.content;
  if (content?.text) {
    if (content.encoding === "base64") {
      // 圖片、字型等二進位內容不需要
      if (!/json|text|html|javascript/.test(content.mimeType ?? "")) {
        content.text = "";
        continue;
      }
      content.text = Buffer.from(content.text, "base64").toString("utf8");
      delete content.encoding;
    }
    content.text = /json/.test(content.mimeType ?? "")
      ? maskFields(content.text)
      : maskText(content.text);
  }
}

await writeFile(outPath, JSON.stringify(har, null, 2));
console.log(
  `已輸出 ${outPath}。請再搜尋一次你的姓名、地址、電話並手動取代後再傳給我。`,
);
```
