if (location.pathname.startsWith("/live_chat")) {
  console.log("[FilterMe] 시작");

  // 1) videoId — live_chat iframe 은 부모 페이지를 referrer 로 가짐
  const ref = document.referrer || "";
  let videoId = "";
  try { videoId = new URL(ref).searchParams.get("v") || ""; } catch (e) {}

  const THRESHOLD = 70;
  const CONFIG = {
    profanity: { on: true, mode: "hide", label: "이 채팅은 욕설이 포함되어 있습니다." },
    political: { on: true, mode: "blur", label: "이 채팅은 정치적 발언이 포함되어 있습니다." },
    sexual:    { on: true, mode: "blur", label: "이 채팅은 성적 표현이 포함되어 있습니다." },
    spam:      { on: true, mode: "hide", label: "이 채팅은 도배로 분류되었습니다." },
  }

  console.log("[FilterMe] videoId:", videoId);

  // 2) 화면 채팅을 (작성자\0텍스트) 키로 보관 — 나중에 숨길 때 이 요소를 찾음
  const nodeByKey = new Map();
  const pendingResults = new Map();
  const mkKey = (a, t) => `${a}\u0000${t}`;

  const seen = new WeakSet();
  function handle(node) {
    if (seen.has(node)) return;
    seen.add(node);
    const author = node.querySelector("#author-name")?.textContent?.trim() ?? "";
    const text = node.querySelector("#message")?.textContent?.trim() ?? "";

    if (!text) return;
    const k = mkKey(author, text);
    nodeByKey.set(k, node);

    if (pendingResults.has(k)) {
      apply(node, pendingResults.get(k));
      pendingResults.delete(k);
    }
  }

  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 && node.tagName === "YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER") {
          handle(node);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll("yt-live-chat-text-message-renderer").forEach(handle);

  // 3) 백엔드 WebSocket
  let ws;

  const style = document.createElement("style");
  style.textContent = `
    .filterme-blur { position: relative; cursor: pointer; }
    .filterme-blur #content { filter: blur(6px); }
    .filterme-blur::after {
      content: attr(data-filterme-label);
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.6); color: #fff;
      font-size: 11px; text-align: center; padding: 0 6px;
      z-index: 2; pointer-events: none;
    }
  `;
  document.head.appendChild(style);

  function apply(node, result) {
    for (const [cat, cfg] of Object.entries(CONFIG)) {
      if (!cfg.on) continue;
      if ((result[cat] ?? 0) < THRESHOLD) continue;

      if (cfg.mode === "hide") {
        node.style.display = "none";
      } else {
        node.dataset.filtermeLabel = cfg.label;
        node.classList.add("filterme-blur");
        node.addEventListener("click", () => {
          node.classList.remove("filterme-blur");
        }, { once: true });
      }
      return;
    }
  }

  function connect() {
    ws = new WebSocket("ws://127.0.0.1:8000/ws");
    ws.onopen = () => {
      console.log("[FilterMe] 서버 연결됨");
      ws.send(JSON.stringify({ videoId }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "analysis") return;
      const node = nodeByKey.get(mkKey(msg.author, msg.text));
      if (node) apply(node, msg.result);
      else pendingResults.set(mkKey(msg.author, msg.text), msg.result);
    };
    ws.onclose = () => {
      console.log("[FilterMe] 연결 끊김, 3초 후 재연결");
      setTimeout(connect, 3000);
    };
    ws.onerror = () => ws.close();
  }
  connect();
}