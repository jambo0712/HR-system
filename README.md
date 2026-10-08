# 薪資保險人事系統

純靜態網站（HTML／CSS／JS），資料存在 Supabase，需登入才能存取。

## 上傳到 GitHub Pages
1. 把整個資料夾（index.html、css/、js/、images/）上傳到 GitHub 儲存庫。
2. Settings → Pages → Source 選 main 分支、根目錄 (/)。
3. 等 1～2 分鐘，開啟 https://<帳號>.github.io/<儲存庫>/ 。

## 安全提醒
- js/config.js 只能放 Supabase 網址與 publishable 金鑰，絕不放 service_role / secret 金鑰。
- 在 Supabase 後台 Authentication → Sign In / Providers 關閉「Allow new users to sign up」。
- 資料表已啟用 RLS，只有指定 Email 登入後可讀寫。
