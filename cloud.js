// cloud.js：遊戲跟伺服器溝通的程式全部集中在這個檔案。
// 之後要從 Supabase 搬到別的平台，只需要改寫這個檔案，遊戲本體（index.html）不用動。
// 對外只提供 window.DogCloud 這個物件。
(function () {
  'use strict';
  const cfg = window.DOG_CLOUD || {};
  const enabled = !!(cfg.url && cfg.anonKey && window.supabase && window.supabase.createClient);
  // 只用「帳號＋密碼」註冊的玩家，系統內部用這個不存在的網域當作登入用 Email（不會寄信）
  const DOMAIN = 'players.dog-survivors.invalid';
  const SYNC_DELAY = 15000; // 存檔後最多等 15 秒上傳一次，避免太頻繁

  let sb = null, user = null, timer = null, pending = null, lastSync = 0, syncing = false, lastErr = '';
  const listeners = [];
  if (enabled) {
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }

  const toEmail = (u) => `${u.toLowerCase()}@${DOMAIN}`;
  const realEmail = (u) => (u && u.email && !u.email.endsWith('@' + DOMAIN)) ? u.email : '';
  const nameOf = (u) => (u && u.user_metadata && u.user_metadata.username) || '';

  function emit() { const s = api.status(); for (const f of listeners) { try { f(s); } catch (e) { /* ignore */ } } }
  function zh(e) {
    const m = String((e && e.message) || e || '').toLowerCase();
    if (m.includes('invalid login')) return '帳號或密碼錯誤';
    if (m.includes('already registered') || m.includes('already been registered') || m.includes('duplicate')) return '這個帳號已經有人用了';
    if (m.includes('database error saving new user')) return '這個帳號已經有人用了，或格式不正確';
    if ((e && e.status === 429) || m.includes('rate limit') || m.includes('too many')) return '嘗試太多次，請稍等幾分鐘再試';
    if (m.includes('weak') || m.includes('password should')) return '密碼太簡單，請至少 8 個字並混合英文和數字';
    if (m.includes('email not confirmed')) return 'Email 還沒驗證，請先到信箱點驗證連結';
    if (m.includes('failed to fetch') || m.includes('network')) return '連不上伺服器，請檢查網路';
    return '發生錯誤：' + ((e && e.message) || e);
  }
  function need() { if (!enabled) throw new Error('雲端存檔還沒啟用'); }
  function needUser() { need(); if (!user) throw new Error('請先登入'); }

  const api = {
    enabled,
    status() {
      return { enabled, loggedIn: !!user, username: nameOf(user), email: realEmail(user), lastSync, syncing, pending: !!pending, error: lastErr };
    },
    onChange(f) { listeners.push(f); },
    validName(u) { return /^[a-z0-9_]{3,16}$/i.test(u || ''); },
    validPass(p) { return typeof p === 'string' && p.length >= 8 && /[a-z]/i.test(p) && /[0-9]/.test(p); },

    myId() { return user ? user.id : ''; },
    async init() {
      if (!enabled) return;
      const { data } = await sb.auth.getSession();
      user = data.session ? data.session.user : null;
      sb.auth.onAuthStateChange((_evt, session) => { user = session ? session.user : null; emit(); });
      emit();
    },

    async signUp(username, password) {
      need();
      if (!api.validName(username)) throw new Error('帳號只能用 3～16 個英文字母、數字或底線');
      if (!api.validPass(password)) throw new Error('密碼至少 8 個字，而且要同時有英文和數字');
      const { data, error } = await sb.auth.signUp({
        email: toEmail(username), password,
        options: { data: { username: username.toLowerCase() } }
      });
      if (error) throw new Error(zh(error));
      if (!data.session) throw new Error('註冊成功，但伺服器要求 Email 驗證，請管理員關閉「Confirm email」');
      user = data.user; emit(); return user;
    },

    async signIn(id, password) {
      need();
      id = (id || '').trim();
      const email = id.includes('@') ? id : toEmail(id);
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(zh(error));
      user = data.user; emit(); return user;
    },

    async signOut() {
      if (!enabled) return;
      await api.flush();
      await sb.auth.signOut();
      user = null; emit();
    },

    // 綁定 Email：之後忘記密碼可以收信重設；綁定後也能用 Email 登入
    async bindEmail(email) {
      needUser();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new Error('Email 格式不正確');
      const { error } = await sb.auth.updateUser({ email }, { emailRedirectTo: location.origin + location.pathname });
      if (error) throw new Error(zh(error));
    },
    async changePassword(password) {
      needUser();
      if (!api.validPass(password)) throw new Error('密碼至少 8 個字，而且要同時有英文和數字');
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw new Error(zh(error));
    },
    async resetByEmail(email) {
      need();
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) throw new Error(zh(error));
    },

    // 讀取雲端存檔：沒有存檔時回傳 null
    async load() {
      needUser();
      const { data, error } = await sb.from('saves').select('data, updated_at').eq('user_id', user.id).maybeSingle();
      if (error) throw new Error(zh(error));
      return data ? { data: data.data, updatedAt: data.updated_at } : null;
    },

    // 排隊上傳（會合併成一次）；立刻上傳請用 flush()
    queue(save) {
      if (!enabled || !user) return;
      pending = save;
      if (!timer) timer = setTimeout(() => { api.flush(); }, SYNC_DELAY);
    },
    async flush(version) {
      clearTimeout(timer); timer = null;
      if (!enabled || !user || !pending || syncing) return;
      const data = pending; pending = null; syncing = true; emit();
      try {
        const { error } = await sb.from('saves').upsert({ user_id: user.id, data, game_version: version || null });
        if (error) throw error;
        lastSync = Date.now(); lastErr = '';
      } catch (e) {
        lastErr = zh(e); if (!pending) pending = data;
        if (!timer) timer = setTimeout(() => { api.flush(); }, SYNC_DELAY * 2);
      } finally { syncing = false; emit(); }
    }
  };

  // ---------- 線上主城（Supabase Realtime）----------
  // 只有登入的玩家可以加入；頻道是 private，伺服器端用 RLS 檢查是否登入。
  // 為了省訊息量：位置只在「目的地改變」時送出，表情、句子都有冷卻時間。
  const ROOM_CAP = 16, MAX_ROOM = 8;
  api.townEnabled = () => enabled && cfg.town !== false;
  api.userId = () => (user ? user.id : '');
  api.joinTown = async function (meta, h) {
    needUser();
    try { const { data } = await sb.auth.getSession(); await sb.realtime.setAuth(data.session ? data.session.access_token : undefined); } catch (e) { /* ignore */ }
    for (let room = 1; room <= MAX_ROOM; room++) {
      const ch = sb.channel('town:' + room, { config: { private: true, broadcast: { self: false }, presence: { key: user.id } } });
      const peers = () => { const st = ch.presenceState(), out = []; for (const k in st) { const m = st[k][st[k].length - 1]; if (k !== user.id && m) out.push(Object.assign({}, m, { id: k })); } return out; };
      let synced = false;
      ch.on('presence', { event: 'sync' }, () => { synced = true; if (h.onPeers) h.onPeers(peers()); });
      for (const ev of ['mv', 'em', 'say', 'it', 'ball', 'grab', 'inv', 'acc', 'unwalk', 'gift']) ch.on('broadcast', { event: ev }, (m) => { if (h.onEvent) h.onEvent(ev, m.payload || {}); });
      const status = await new Promise((res) => { let done = false; const t = setTimeout(() => { if (!done) { done = true; res('TIMED_OUT'); } }, 8000); ch.subscribe((s) => { if (done) { if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') { if (h.onState) h.onState('error'); } return; } if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { done = true; clearTimeout(t); res(s); } }); });
      if (status !== 'SUBSCRIBED') { try { await sb.removeChannel(ch); } catch (e) { /* ignore */ } throw new Error(status === 'CHANNEL_ERROR' ? '主城連線被拒絕（伺服器設定還沒完成）' : '連不上主城伺服器'); }
      const t0 = Date.now(); while (!synced && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 100));
      if (peers().length >= ROOM_CAP) { try { await sb.removeChannel(ch); } catch (e) { /* ignore */ } continue; }
      await ch.track(meta);
      return {
        room,
        id: user.id,
        send(ev, payload) { return ch.send({ type: 'broadcast', event: ev, payload: Object.assign({ id: user.id }, payload) }).catch(() => {}); },
        track(m) { return ch.track(m).catch(() => {}); },
        async leave() { try { await ch.untrack(); } catch (e) { /* ignore */ } try { await sb.removeChannel(ch); } catch (e) { /* ignore */ } }
      };
    }
    throw new Error('主城人太多了，稍後再試');
  };

  // ---------- 狗屋公開資料與訪客腳印 ----------
  api.putHome = async function (data) {
    if (!enabled || !user) return;
    const { error } = await sb.from('homes').upsert({ user_id: user.id, data });
    if (error) throw new Error(zh(error));
  };
  // ---------- 排行榜 ----------
  api.putScore = async function (row) {
    if (!enabled || !user) return;
    const { error } = await sb.from('leaderboard').upsert(Object.assign({ user_id: user.id }, row));
    if (error) throw new Error(zh(error));
  };
  api.topScores = async function (kind, n) {
    if (!enabled) return [];
    const col = kind === 'tower' ? 'tower' : 'score';
    const { data, error } = await sb.from('leaderboard').select('user_id, username, name, sk, j, w, reb, lv, para, tower').order(col, { ascending: false }).limit(n || 50);
    if (error) throw new Error(zh(error));
    return data || [];
  };
  api.getHome = async function (uid) {
    needUser();
    const { data, error } = await sb.from('homes').select('username, data, updated_at').eq('user_id', uid).maybeSingle();
    if (error) throw new Error(zh(error));
    return data;
  };
  api.addVisit = async function (hostId, phrase) {
    needUser();
    const { error } = await sb.from('visits').insert({ host_id: hostId, phrase: phrase | 0 });
    if (error) { if (String(error.code) === '23505') return 'dup'; throw new Error(zh(error)); }
    return 'ok';
  };
  api.myVisits = async function () {
    needUser();
    const since = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const { data, error } = await sb.from('visits').select('visitor_name, phrase, day, created_at').eq('host_id', user.id).gte('day', since).order('created_at', { ascending: false }).limit(50);
    if (error) throw new Error(zh(error));
    return data || [];
  };

  // ---------- 通用即時頻道：配對大廳、團隊房間、個人邀請信箱 ----------
  // topic 只能是 mm:* / room:* / user:*（伺服器端 RLS 也會檢查）
  api.openChannel = async function (topic, o) {
    needUser(); o = o || {};
    if (!/^(mm|room|user):[a-z0-9:_-]{1,80}$/i.test(topic)) throw new Error('bad topic');
    try { const { data } = await sb.auth.getSession(); await sb.realtime.setAuth(data.session ? data.session.access_token : undefined); } catch (e) { /* ignore */ }
    const cfgc = { private: true, broadcast: { self: false } };
    if (o.presence) cfgc.presence = { key: user.id };
    const ch = sb.channel(topic, { config: cfgc });
    const members = () => { const st = ch.presenceState(), out = []; for (const k in st) { const m = st[k][st[k].length - 1]; if (m) out.push(Object.assign({}, m, { id: k })); } return out; };
    if (o.presence) ch.on('presence', { event: 'sync' }, () => { if (o.onPresence) o.onPresence(members()); });
    for (const ev of (o.events || [])) ch.on('broadcast', { event: ev }, (m) => { if (o.onEvent) o.onEvent(ev, m.payload || {}); });
    const status = await new Promise((res) => { let done = false; const t = setTimeout(() => { if (!done) { done = true; res('TIMED_OUT'); } }, 8000); ch.subscribe((s2) => { if (done) { if ((s2 === 'CHANNEL_ERROR' || s2 === 'CLOSED') && o.onState) o.onState('error'); return; } if (s2 === 'SUBSCRIBED' || s2 === 'CHANNEL_ERROR' || s2 === 'TIMED_OUT') { done = true; clearTimeout(t); res(s2); } }); });
    if (status !== 'SUBSCRIBED') { try { await sb.removeChannel(ch); } catch (e) { /* ignore */ } throw new Error(status === 'CHANNEL_ERROR' ? '連線被拒絕（伺服器設定還沒完成）' : '連不上伺服器'); }
    if (o.presence) await ch.track(o.presence);
    return {
      id: user.id,
      members,
      send(ev, payload) { return ch.send({ type: 'broadcast', event: ev, payload: Object.assign({ from: user.id }, payload) }).catch(() => {}); },
      track(m) { return ch.track(m).catch(() => {}); },
      async leave() { try { if (o.presence) await ch.untrack(); } catch (e) { /* ignore */ } try { await sb.removeChannel(ch); } catch (e) { /* ignore */ } }
    };
  };

  // 不加入頻道、直接送一則訊息（例如送組隊邀請到對方的信箱 user:<id>）；伺服器只檢查「能不能寫」
  api.sendTo = async function (topic, ev, payload) {
    needUser();
    if (!/^(mm|room|user):[a-z0-9:_-]{1,80}$/i.test(topic)) throw new Error('bad topic');
    try { const { data } = await sb.auth.getSession(); await sb.realtime.setAuth(data.session ? data.session.access_token : undefined); } catch (e) { /* ignore */ }
    const ch = sb.channel(topic, { config: { private: true } });
    try { const r = await ch.send({ type: 'broadcast', event: ev, payload: Object.assign({ from: user.id }, payload) }); if (r !== 'ok') throw new Error('送不出去，請稍後再試'); }
    finally { try { await sb.removeChannel(ch); } catch (e) { /* ignore */ } }
  };

  // ---------- 好友 ----------
  api.touchSeen = async function () { if (!enabled || !user) return; try { await sb.rpc('touch_seen'); } catch (e) { /* ignore */ } };
  api.findPlayer = async function (username) {
    needUser();
    const { data, error } = await sb.rpc('find_player', { uname: String(username || '').toLowerCase() });
    if (error) throw new Error(zh(error));
    return data && data.length ? data[0] : null;
  };
  api.friends = async function () {
    needUser();
    const { data, error } = await sb.rpc('my_friends');
    if (error) throw new Error(zh(error));
    return data || [];
  };
  api.friendRequest = async function (uid) {
    needUser();
    if (uid === user.id) throw new Error('不能加自己為好友');
    // 如果對方已經先邀請我，直接接受
    const { data: back } = await sb.from('friends').select('status').eq('a', uid).eq('b', user.id).maybeSingle();
    if (back) { const { error } = await sb.from('friends').update({ status: 'accepted' }).eq('a', uid).eq('b', user.id); if (error) throw new Error(zh(error)); return 'accepted'; }
    const { error } = await sb.from('friends').insert({ a: user.id, b: uid });
    if (error) { if (String(error.code) === '23505') return 'dup'; throw new Error(zh(error)); }
    return 'sent';
  };
  api.friendAccept = async function (uid) {
    needUser();
    const { error } = await sb.from('friends').update({ status: 'accepted' }).eq('a', uid).eq('b', user.id);
    if (error) throw new Error(zh(error));
  };
  api.friendRemove = async function (uid) {
    needUser();
    await sb.from('friends').delete().eq('a', user.id).eq('b', uid);
    await sb.from('friends').delete().eq('a', uid).eq('b', user.id);
  };

  // 關掉分頁或切到背景時，把還沒上傳的存檔送出去
  document.addEventListener('visibilitychange', () => { if (document.hidden) api.flush(); });
  window.DogCloud = api;
})();
