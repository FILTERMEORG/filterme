'use strict';

// ---- 서버(AI 필터) WebSocket 연결 + 연결 상태 표시 ----
// Render 무료 인스턴스는 미사용 시 sleep 하므로 콜드스타트(수십 초)가 있을 수 있다.
// 그동안 사용자가 "멈췄나?" 오해하지 않도록 검은 바에 상태를 보여준다.

let _connTimer = null;
let _connT0 = 0;
let ws = null; // 모듈 스코프로 승격 — sendToServer()가 다른 파일(fm-manager.js)에서도 접근 가능하도록
function setConnState(state) {
  if (els.fmConnDot) els.fmConnDot.className = 'fm-conn-dot ' + state;
  if (!els.fmConnTxt) return;
  if (state === 'connected') {
    els.fmConnTxt.textContent = '';
  } else if (state === 'retrying') {
    els.fmConnTxt.textContent = '재연결 중…';
  } else {
    const s = Math.round((Date.now() - _connT0) / 1000);
    els.fmConnTxt.textContent = s > 3 ? `서버 깨우는 중… ${s}초` : '서버 연결 중…';
  }
}

function connectBackend() {
  let videoId = '';
  try { videoId = new URL(document.referrer).searchParams.get('v') || ''; } catch (e) { }
  const open = () => {
    _connT0 = Date.now();
    setConnState('connecting');
    clearInterval(_connTimer);
    _connTimer = setInterval(() => setConnState('connecting'), 1000);

    ws = new WebSocket(SERVER_WS);
    ws.onopen = () => {
      clearInterval(_connTimer);
      setConnState('connected');
      ws.send(JSON.stringify({ videoId }));
      const texts = [];
      document.querySelectorAll('yt-live-chat-text-message-renderer').forEach((node) => {
        const el = (node.shadowRoot || node).querySelector('#message');
        const tx = norm(el ? el.textContent : '');
        if (tx) texts.push(tx);
      });
      if (texts.length) ws.send(JSON.stringify({ type: 'backfill', texts }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'summary' || m.type === 'mood' || m.type === 'hot_topics') { onManagerServerMessage(m); return; } // fm-manager.js
      if (m.type !== 'analysis') return;
      serverCat.set(norm(m.text), resultToCategory(m.result));
      reclassifyAllVisible();
    };
    ws.onclose = () => {
      clearInterval(_connTimer);
      setConnState('retrying');
      setTimeout(open, 3000);
    };
    ws.onerror = () => ws.close();
  };
  open();
}

// 다른 파일(fm-manager.js)에서 서버로 메시지를 보낼 때 사용. 콜드스타트/재연결 중에는 조용히 드롭.
function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (e) { }
  }
}
