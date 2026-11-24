// 雲端存檔設定：在 Supabase 後台 Project Settings → API Keys 複製 Project URL 和 Publishable key。
// anonKey（anon public）本來就是給網頁公開使用的，搭配資料庫的 RLS 權限是安全的。
// 千萬不要把 service_role key 放在這裡或任何網頁裡。
// 兩個都留空時，遊戲照常可以玩，只是沒有雲端存檔。
window.DOG_CLOUD = {
  url: 'https://rtdyhtgbhupblrclwpgt.supabase.co',
  anonKey: 'sb_publishable_YLpa3oJCIAEcIOzcXiFHOA_am7Uyap2'  // publishable key（可公開）
};
