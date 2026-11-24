-- 汪汪倖存者：玩家帳號與雲端存檔
-- 在 Supabase 後台 SQL Editor 整份貼上執行一次即可（重複執行也不會出錯）。
-- 這份檔案只用標準 PostgreSQL，之後搬到其他 PostgreSQL 主機也能直接用。

-- 1) 玩家公開資料：帳號名稱
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  username   text not null unique check (username ~ '^[a-z0-9_]{3,16}$'),
  created_at timestamptz not null default now()
);

-- 2) 存檔：每位玩家一筆，整份存檔放在 data（JSON）
create table if not exists public.saves (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  data         jsonb not null check (pg_column_size(data) < 262144),  -- 單份存檔上限 256 KB
  game_version text,
  updated_at   timestamptz not null default now()
);

-- 3) 安全性：開啟列級權限（RLS），玩家只能讀寫「自己的」資料
alter table public.profiles enable row level security;
alter table public.saves    enable row level security;

drop policy if exists "profiles: read own"   on public.profiles;
drop policy if exists "saves: read own"      on public.saves;
drop policy if exists "saves: insert own"    on public.saves;
drop policy if exists "saves: update own"    on public.saves;

create policy "profiles: read own" on public.profiles
  for select to authenticated using (auth.uid() = user_id);
create policy "saves: read own" on public.saves
  for select to authenticated using (auth.uid() = user_id);
create policy "saves: insert own" on public.saves
  for insert to authenticated with check (auth.uid() = user_id);
create policy "saves: update own" on public.saves
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- 刻意不開放 delete：玩家端無法刪除存檔（刪除帳號時才會連帶刪除）

-- 未登入的訪客完全不能碰這兩張表
revoke all on public.profiles from anon;
revoke all on public.saves    from anon;
-- 只開放登入玩家需要的權限（新版 Supabase 預設不自動開放）
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update on public.saves to authenticated;

-- 4) 存檔時自動更新時間
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists saves_touch on public.saves;
create trigger saves_touch before update on public.saves
  for each row execute function public.touch_updated_at();

-- 5) 註冊時自動建立 profile（帳號名稱由伺服器檢查格式與是否重複）
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, username)
  values (new.id, lower(new.raw_user_meta_data ->> 'username'));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
