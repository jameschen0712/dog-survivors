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

-- 6) 線上主城（Realtime）：只有登入的玩家可以加入 town:* 頻道、收發表情和位置
--    另外要到 Project Settings → Realtime 把「Allow public access」關掉，強制只能用 private 頻道
drop policy if exists "town: read"  on realtime.messages;
drop policy if exists "town: write" on realtime.messages;
create policy "town: read" on realtime.messages
  for select to authenticated
  using (realtime.topic() like 'town:%' and realtime.messages.extension in ('broadcast', 'presence'));
create policy "town: write" on realtime.messages
  for insert to authenticated
  with check (realtime.topic() like 'town:%' and realtime.messages.extension in ('broadcast', 'presence'));
-- 7) 拜訪好友的家：每位玩家公開一份「狗屋擺設」，登入的玩家都可以看
create table if not exists public.homes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  username   text,
  data       jsonb not null check (pg_column_size(data) < 32768),
  updated_at timestamptz not null default now()
);
alter table public.homes enable row level security;
drop policy if exists "homes: read"       on public.homes;
drop policy if exists "homes: insert own" on public.homes;
drop policy if exists "homes: update own" on public.homes;
create policy "homes: read" on public.homes for select to authenticated using (true);
create policy "homes: insert own" on public.homes for insert to authenticated with check (auth.uid() = user_id);
create policy "homes: update own" on public.homes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.homes from anon;
grant select, insert, update on public.homes to authenticated;

-- 名字一律由伺服器從 profiles 帶入，玩家改不了
create or replace function public.homes_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.username := (select username from public.profiles where user_id = new.user_id);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists homes_fill on public.homes;
create trigger homes_fill before insert or update on public.homes for each row execute function public.homes_fill();

-- 8) 訪客腳印：同一個訪客對同一個家一天只能留一次；只有主人看得到誰來過
create table if not exists public.visits (
  id           bigserial primary key,
  host_id      uuid not null references auth.users(id) on delete cascade,
  visitor_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  visitor_name text,
  phrase       smallint not null default 0 check (phrase between 0 and 31),
  day          date not null default current_date,
  created_at   timestamptz not null default now(),
  unique (host_id, visitor_id, day)
);
alter table public.visits enable row level security;
drop policy if exists "visits: host reads" on public.visits;
drop policy if exists "visits: insert"     on public.visits;
create policy "visits: host reads" on public.visits for select to authenticated using (auth.uid() = host_id);
create policy "visits: insert" on public.visits for insert to authenticated with check (auth.uid() = visitor_id and host_id <> visitor_id);
revoke all on public.visits from anon;
grant select, insert on public.visits to authenticated;
grant usage on sequence public.visits_id_seq to authenticated;

create or replace function public.visits_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.visitor_id := auth.uid();
  new.visitor_name := (select username from public.profiles where user_id = auth.uid());
  new.day := current_date;
  return new;
end $$;
drop trigger if exists visits_fill on public.visits;
create trigger visits_fill before insert on public.visits for each row execute function public.visits_fill();

-- 9) 好友：a 送出邀請給 b；b 接受後變成好友。雙方都能刪除。
create table if not exists public.friends (
  a          uuid not null references auth.users(id) on delete cascade,
  b          uuid not null references auth.users(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a <> b)
);
alter table public.friends enable row level security;
drop policy if exists "friends: read"   on public.friends;
drop policy if exists "friends: ask"    on public.friends;
drop policy if exists "friends: accept" on public.friends;
drop policy if exists "friends: remove" on public.friends;
create policy "friends: read"   on public.friends for select to authenticated using (auth.uid() in (a, b));
create policy "friends: ask"    on public.friends for insert to authenticated with check (auth.uid() = a and status = 'pending');
create policy "friends: accept" on public.friends for update to authenticated using (auth.uid() = b) with check (auth.uid() = b and status = 'accepted');
create policy "friends: remove" on public.friends for delete to authenticated using (auth.uid() in (a, b));
revoke all on public.friends from anon;
grant select, insert, update, delete on public.friends to authenticated;

-- 線上狀態：玩家每分鐘回報一次
alter table public.profiles add column if not exists last_seen timestamptz;
create or replace function public.touch_seen() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_seen = now() where user_id = auth.uid();
$$;
revoke all on function public.touch_seen() from public, anon;
grant execute on function public.touch_seen() to authenticated;

-- 用帳號名稱找玩家（只回傳 id 和名稱）
create or replace function public.find_player(uname text) returns table (id uuid, username text)
language sql stable security definer set search_path = public as $$
  select p.user_id, p.username from public.profiles p where p.username = lower(uname) and auth.uid() is not null limit 1;
$$;
revoke all on function public.find_player(text) from public, anon;
grant execute on function public.find_player(text) to authenticated;

-- 我的好友清單（含對方狗狗名字、毛色、職業、最後上線時間）
create or replace function public.my_friends() returns table (id uuid, username text, status text, outgoing boolean, last_seen timestamptz, nm text, sk text, j text)
language sql stable security definer set search_path = public as $$
  select o.other, p.username, f.status, f.a = auth.uid(), p.last_seen,
         h.data->>'nm', h.data->>'sk', h.data->>'j'
  from public.friends f
  cross join lateral (select case when f.a = auth.uid() then f.b else f.a end as other) o
  join public.profiles p on p.user_id = o.other
  left join public.homes h on h.user_id = o.other
  where auth.uid() in (f.a, f.b)
  order by p.username;
$$;
revoke all on function public.my_friends() from public, anon;
grant execute on function public.my_friends() to authenticated;

-- 10) 團隊副本的即時頻道：配對大廳 mm:*、隊伍房間 room:*、個人邀請信箱 user:<自己的 id>（只有自己收得到）
drop policy if exists "team: read"  on realtime.messages;
drop policy if exists "team: write" on realtime.messages;
create policy "team: read" on realtime.messages
  for select to authenticated
  using ((realtime.topic() like 'mm:%' or realtime.topic() like 'room:%' or realtime.topic() = 'user:' || auth.uid()::text)
         and realtime.messages.extension in ('broadcast', 'presence'));
create policy "team: write" on realtime.messages
  for insert to authenticated
  with check ((realtime.topic() like 'mm:%' or realtime.topic() like 'room:%' or realtime.topic() like 'user:%')
              and realtime.messages.extension in ('broadcast', 'presence'));
