'use strict';

// ---- 필터 판정 & 채팅 DOM 적용 ----
// 서버가 WebSocket으로 보내주는 분석 결과(serverCat)를 화면의 채팅 DOM과 매칭해
// 블러/차단을 적용한다. "유해한지 판정" 자체는 서버(analyzer.py)가 하고,
// 여기는 "그 판정을 켜진 항목·임계값과 비교해서 화면에 반영"만 한다.

const THRESHOLD = 70;
const SCORE_TO_CAT = { profanity: 'c02', political: 'c03', sexual: 'c04', spam: 'c05' };
const serverCat = new Map(); // norm(text) -> 'c02'|'c03'|'c04'|'c05'|null (fm-socket.js 가 채움)

// 서버 결과(5개 점수) → 임계값 넘는 것 중 최고점 카테고리 하나로 축약
function resultToCategory(r) {
  let best = null, top = THRESHOLD - 1;
  for (const [k, c] of Object.entries(SCORE_TO_CAT)) {
    const v = r[k] ?? 0;
    if (v >= THRESHOLD && v > top) { best = c; top = v; }
  }
  return best;
}

// 순수 함수로 유지할 것 — 부작용(카운터 누적 등)을 넣으면 reclassifyAllVisible()이
// 반복 호출할 때마다 상태가 쌓여 오판하는 버그가 났던 적이 있음.
function classify(text) {
  const t = norm(text);
  if (!t) return null;
  if (serverCat.has(t)) return serverCat.get(t);
}

// ---- 실제 채팅 DOM 관찰 & 필터 적용 ----
function findItemsContainer() {
  const listRenderer = document.querySelector('yt-live-chat-item-list-renderer');
  if (!listRenderer) return null;
  const root = listRenderer.shadowRoot || listRenderer;
  return root.querySelector('#items');
}

function extractMessage(node) {
  const tag = node.tagName ? node.tagName.toLowerCase() : '';
  if (tag !== 'yt-live-chat-text-message-renderer') return null; // 슈퍼챗/멤버십 등은 건드리지 않음
  const root = node.shadowRoot || node;
  const authorEl = root.querySelector('#author-name');
  const messageEl = root.querySelector('#message');
  if (!messageEl) return null;
  return { authorEl, messageEl };
}

function applyFilterToNode(node) {
  const parsed = extractMessage(node);
  if (!parsed) return;
  const { messageEl } = parsed;
  // 번역으로 본문이 교체됐을 수 있으므로 분류·매칭은 항상 원문 기준
  const text = node.dataset.fmOrigText || messageEl.textContent || '';
  const category = classify(text);

  // 이전 처리 흔적 제거 (표시 방식이 바뀌었을 때 재적용하기 위함)
  node.classList.remove('fm-blur', 'fm-blocked', 'fm-revealed');
  delete node.dataset.fmLabel;
  messageEl.style.filter = '';
  node.style.display = '';

  translateNode(node, messageEl, text); // fm-translate.js

  if (!settings.filterEnabled || !category || !settings.categories[category]) {
    return; // Normal이거나, 필터가 꺼져 있거나, 해당 카테고리가 OFF면 그대로 노출
  }

  if (settings.displayMode === 'blur') {
    node.classList.add('fm-blur');
    node.dataset.fmLabel = BLUR_LABEL[category] || '이 채팅은 필터되었습니다.';
    messageEl.style.filter = 'blur(4px)';
    node.style.cursor = 'pointer';
    // 사용자가 클릭해서 열어둔 상태는 재분류 후에도 유지
    if (node.dataset.fmRevealed === '1') node.classList.add('fm-revealed');
    node.onclick = () => {
      node.classList.toggle('fm-revealed');
      node.dataset.fmRevealed = node.classList.contains('fm-revealed') ? '1' : '0';
    };
  } else {
    node.style.display = 'none';
  }
}

function reclassifyAllVisible() {
  const container = findItemsContainer();
  if (!container) return;
  container.childNodes.forEach((node) => applyFilterToNode(node));
}

function observeChat() {
  const container = findItemsContainer();
  if (!container) {
    setTimeout(observeChat, 500); // 채팅 DOM이 아직 준비되지 않았으면 재시도
    return;
  }

  // 이미 떠 있던 메시지도 한 번 처리
  container.childNodes.forEach((node) => applyFilterToNode(node));

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (node.nodeType === 1) applyFilterToNode(node);
      });
    });
  });
  observer.observe(container, { childList: true });
}
