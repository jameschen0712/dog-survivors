// coop.js：團隊副本的連線層。
// 房間內的玩家用 WebRTC 直接連線（房主 ↔ 每位隊員，星狀）；
// 連不上（例如某些行動網路）時，自動改走伺服器頻道轉送。
// 對外只提供 window.Coop.join(...)，回傳一個房間物件。
(function () {
  'use strict';
  const ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  const P2P_WAIT = 7000;

  // opts: { roomId, cloud, me:{...presence meta}, isHost, onMembers(list), onCtl(msg), onMsg(fromId, msg), onLink(id, kind) }
  async function join(opts) {
    const cloud = opts.cloud || window.DogCloud;
    const peers = new Map(); // id -> { pc, r, u, kind:'p2p'|'relay'|'wait', timer, q:[] }
    let hostId = opts.isHost ? null : (opts.hostId || null), closed = false, ch = null;
    const myId = () => (ch ? ch.id : '');
    const parse = (d) => { try { return typeof d === 'string' ? JSON.parse(d) : d; } catch (e) { return null; } };

    function deliver(from, d) { const m = parse(d); if (m && opts.onMsg) opts.onMsg(from, m); }
    function setKind(id, kind) { const pe = peers.get(id); if (!pe || pe.kind === kind) return; pe.kind = kind; if (opts.onLink) opts.onLink(id, kind); }

    function wireDC(id, dc, which) {
      const pe = peers.get(id); if (!pe) return;
      pe[which] = dc;
      dc.onopen = () => { if (pe.r && pe.r.readyState === 'open') { clearTimeout(pe.timer); setKind(id, 'p2p'); } };
      dc.onmessage = (ev) => deliver(id, ev.data);
      dc.onclose = () => { if (!closed && pe.kind === 'p2p') setKind(id, 'relay'); };
    }
    function newPeer(id, initiator) {
      let pe = peers.get(id);
      if (pe && pe.pc) return pe;
      pe = pe || { kind: 'wait', q: [] };
      peers.set(id, pe);
      let pc = null;
      try { pc = new RTCPeerConnection({ iceServers: ICE }); } catch (e) { pc = null; }
      pe.pc = pc;
      pe.timer = setTimeout(() => { if (pe.kind !== 'p2p') setKind(id, 'relay'); }, P2P_WAIT);
      if (!pc) { setKind(id, 'relay'); return pe; }
      pc.onicecandidate = (ev) => { if (ev.candidate) sig(id, 'ice', ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate); };
      pc.onconnectionstatechange = () => { const s = pc.connectionState; if ((s === 'failed' || s === 'disconnected' || s === 'closed') && !closed) setKind(id, 'relay'); };
      if (initiator) {
        wireDC(id, pc.createDataChannel('r', { ordered: true }), 'r');
        wireDC(id, pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }), 'u');
        pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => sig(id, 'offer', plainSD(pc.localDescription))).catch(() => setKind(id, 'relay'));
      } else {
        pc.ondatachannel = (ev) => wireDC(id, ev.channel, ev.channel.label === 'u' ? 'u' : 'r');
      }
      return pe;
    }
    const plainSD = (d) => ({ type: d.type, sdp: d.sdp });
    function sig(to, t, d) { if (ch) ch.send('sig', { to, t, d }); }
    async function onSig(p) {
      if (p.to !== myId()) return;
      const from = p.from;
      if (p.t === 'hello') { if (opts.isHost) { const old = peers.get(from); if (old && old.pc) { try { old.pc.close(); } catch (e) { /* ignore */ } peers.delete(from); } newPeer(from, true); } return; }
      const pe = newPeer(from, false), pc = pe.pc; if (!pc) return;
      try {
        if (p.t === 'offer') { await pc.setRemoteDescription(p.d); const a = await pc.createAnswer(); await pc.setLocalDescription(a); sig(from, 'answer', plainSD(pc.localDescription)); for (const c of pe.q) await pc.addIceCandidate(c).catch(() => {}); pe.q = []; }
        else if (p.t === 'answer') { await pc.setRemoteDescription(p.d); for (const c of pe.q) await pc.addIceCandidate(c).catch(() => {}); pe.q = []; }
        else if (p.t === 'ice') { if (pc.remoteDescription) await pc.addIceCandidate(p.d).catch(() => {}); else pe.q.push(p.d); }
      } catch (e) { setKind(from, 'relay'); }
    }

    ch = await cloud.openChannel('room:' + opts.roomId, {
      events: ['sig', 'rl', 'ctl'],
      presence: opts.me,
      onPresence: (list) => { if (opts.onMembers) opts.onMembers(list); },
      onEvent: (ev, p) => {
        if (ev === 'sig') onSig(p);
        else if (ev === 'rl') { if (p.to === myId() || p.to === '*') deliver(p.from, p.d); }
        else if (ev === 'ctl') { if (opts.onCtl) opts.onCtl(p); }
      }
    });

    const room = {
      id: opts.roomId,
      me: ch.id,
      members: () => ch.members(),
      // 房主連到所有隊員；隊員只連房主
      connectTo(id) { if (id === ch.id) return; if (opts.isHost) return; hostId = id; const pe = newPeer(id, false); sig(id, 'hello', 1); return pe; },
      linkKind(id) { const pe = peers.get(id); return pe ? pe.kind : 'none'; },
      // 送給某個人；rel=true 用可靠通道（升級選項、結算），false 用不保證送達的通道（位置、畫面狀態）
      send(to, msg, rel) {
        const pe = peers.get(to), d = JSON.stringify(msg);
        if (pe && pe.kind === 'p2p') { const dc = rel ? pe.r : (pe.u || pe.r); if (dc && dc.readyState === 'open') { try { dc.send(d); return true; } catch (e) { /* fall through */ } } }
        if (pe && pe.kind === 'wait' && !rel) return false;
        ch.send('rl', { to, d }); return true;
      },
      ctl(msg) { ch.send('ctl', msg); },
      track(meta) { return ch.track(meta); },
      async close() { closed = true; for (const pe of peers.values()) { clearTimeout(pe.timer); try { pe.pc && pe.pc.close(); } catch (e) { /* ignore */ } } peers.clear(); await ch.leave(); }
    };
    return room;
  }

  // 隨機配對大廳：同模式、同人數的玩家一起排隊；最早進來的人當房主，人滿或時間到就開房
  async function queue(opts) {
    const cloud = opts.cloud || window.DogCloud;
    let ch = null, done = false;
    const t0 = Date.now();
    ch = await cloud.openChannel('mm:' + opts.key, {
      events: ['go'],
      presence: Object.assign({ t: t0 }, opts.me),
      onPresence: (list) => { if (opts.onMembers) opts.onMembers(list); },
      onEvent: (ev, p) => { if (ev === 'go' && !done && (p.ids || []).includes(ch.id)) { done = true; if (opts.onGo) opts.onGo(p); } }
    });
    return {
      me: ch.id,
      members: () => ch.members().sort((a, b) => (a.t || 0) - (b.t || 0) || String(a.id).localeCompare(String(b.id))),
      go(payload) { done = true; ch.send('go', payload); },
      async leave() { done = true; await ch.leave(); }
    };
  }

  window.Coop = { join, queue };
})();
