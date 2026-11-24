# 雲端帳號設定教學（Supabase）

照順序做完，大約 10 分鐘。做完後把第 5 步的兩個值傳給 Claude，就會幫你填進 `config.js` 並上線。

## 1. 註冊 Supabase、建立專案
1. 打開 https://supabase.com ，按 **Start your project**，建議直接用 **GitHub 帳號登入**。
2. 按 **New project**：
   - Name：`dog-survivors`
   - Database Password：按「Generate a password」，**把這組密碼存在安全的地方**（之後搬家、備份會用到，不要貼給任何人）
   - Region：選 **Northeast Asia (Tokyo)** 或 **Southeast Asia (Singapore)**，台灣連線最快
   - 方案選 **Free**
3. 等 1～2 分鐘專案建好。

## 2. 建立資料表與權限
1. 左邊選單點 **SQL Editor** → **New query**。
2. 把 repo 裡 `supabase/schema.sql` 的內容整份貼上，按 **Run**。
3. 看到「Success」就完成了。這一步會建立存檔表，並設定「每位玩家只能讀寫自己的存檔」。

## 3. 設定登入方式
左邊選單 **Authentication**：
1. **Sign In / Providers → Email**：
   - **Enable Email provider**：開
   - **Confirm email**：**關掉**（玩家用帳號註冊，沒有真的 Email 可以驗證）
   - **Minimum password length**：`8`
   - **Secure email change**：開
2. **URL Configuration**：
   - Site URL：`https://jameschen0712.github.io/dog-survivors/`
   - Redirect URLs：加入 `https://jameschen0712.github.io/dog-survivors/`
3. **Rate Limits**：維持預設即可（已內建防止暴力猜密碼）。

## 3.5 線上主城（Realtime）

1. 左側 **Realtime → Settings**，把 **Allow public access to channels** 關掉（只允許 private 頻道），按 Save changes。
2. `supabase/schema.sql` 第 6 段的 Realtime 權限（只有登入玩家能加入 `town:*` 頻道）要在 SQL Editor 執行過一次。
3. 免費方案每月 200 萬則 Realtime 訊息、同時 200 人連線。遊戲已經盡量省訊息（只在改變目的地時送位置、表情有冷卻），人多起來要升級 Pro 方案。要暫時關掉線上主城，在 `config.js` 加上 `town: false`。

## 4.（選用）讓「綁定 Email／忘記密碼」可以寄信
Supabase 內建的寄信服務只適合測試，每小時只能寄幾封。正式要讓玩家收信，需要接一個寄信服務（例如 Resend 免費方案）：
**Project Settings → Authentication → SMTP Settings** 填入寄信服務給的資料。這步之後再做也可以。

## 5. 把網址和公開金鑰給 Claude
**Project Settings → API**（或 **Data API**）：
- **Project URL**：像 `https://abcdxyz.supabase.co`
- **anon public** key：一長串 `eyJ...` 開頭的文字

這兩個本來就是要放在網頁上公開使用的，可以直接貼在對話裡。

> ⚠️ 同一頁還有一個 **service_role** key：**絕對不要給任何人、不要放進網頁或 GitHub**。它可以繞過所有權限。

## 安全性說明
- 密碼由 Supabase 用 bcrypt 加密保存，管理員也看不到原始密碼。
- 資料庫開啟 Row Level Security：每位玩家只能讀寫自己的存檔，未登入的人什麼都碰不到。
- 帳號格式、是否重複由伺服器檢查；單份存檔大小有上限，避免被塞爆。
- 網頁加了內容安全政策（CSP），只允許連到自己的網站和 Supabase。

## 備份與搬家
- 備份：Supabase 後台 **Database → Backups**（免費版沒有自動備份，建議定期用下面的指令自己備份）。
- 匯出全部資料（含帳號與加密後的密碼）：
  ```
  npx supabase db dump --db-url "你的資料庫連線字串" -f backup.sql
  ```
- 搬到其他 PostgreSQL 主機或自架 Supabase 時，玩家不需要重設密碼。
- 遊戲跟伺服器溝通的程式都在 `cloud.js`，換平台只要改這個檔案。
