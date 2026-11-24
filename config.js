// 雲端存檔設定：在 Supabase 後台 Project Settings → API 複製這兩個值。
// anonKey（anon public）本來就是給網頁公開使用的，搭配資料庫的 RLS 權限是安全的。
// 千萬不要把 service_role key 放在這裡或任何網頁裡。
// 兩個都留空時，遊戲照常可以玩，只是沒有雲端存檔。
window.DOG_CLOUD = {
  url: '',
  anonKey: ''
};
