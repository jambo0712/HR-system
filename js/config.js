// Supabase 連線設定。
// 這裡只能放「網址」和「publishable（公開）金鑰」，可以安全公開，因為資料由登入＋RLS 保護。
// ⚠ 永遠不要把 service_role / secret 金鑰放進來。
window.APP_CONFIG = {
  SUPABASE_URL: 'https://rxuunconwiojbfvzilby.supabase.co',
  SUPABASE_KEY: 'sb_publishable_-kOxIQWN3IXsWNpdm2ksWg_zAqzqv7O'
};
