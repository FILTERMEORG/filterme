'use strict';

// ---- 필터 판정 & 채팅 DOM 적용 ----
// 서버가 WebSocket으로 보내주는 분석 결과(serverCat)를 화면의 채팅 DOM과 매칭해
// 블러/차단을 적용한다. "유해한지 판정" 자체는 서버(analyzer.py)가 하고,
// 여기는 "그 판정을 켜진 항목·임계값과 비교해서 화면에 반영"만 한다.

const THRESHOLD = 70;
const SCORE_TO_CAT = { profanity: 'c02', political: 'c03', sexual: 'c04', spam: 'c05' };
const serverCat = new Map(); // norm(text) -> 'c02'|'c03'|'c04'|'c05'|null (fm-socket.js 가 채움) — id 없는 노드용 폴백
// 메시지 id(DOM node.id, YouTube가 메시지마다 발급) -> 카테고리. 같은 사람이 같은 말을 반복하면
// id가 달라서 "두 번째부터만 도배"처럼 메시지 단위 판정이 가능하다. 텍스트 키로는 구분 불가.
const serverCatById = new Map();
const SERVER_CAT_BY_ID_MAX = 3000;

function setServerCatById(id, cat) {
  serverCatById.set(id, cat);
  if (serverCatById.size > SERVER_CAT_BY_ID_MAX) {
    serverCatById.delete(serverCatById.keys().next().value); // Map은 삽입 순서 유지 → 가장 오래된 것
  }
}

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
// id가 있으면 id 결과만 본다 — 텍스트로 폴백하면 누군가의 반복(도배) 판정이 같은 텍스트의
// 다른 정상 메시지에까지 번지기 때문. id 없는 노드만 텍스트로 매칭.
function classify(text, id) {
  if (id) return serverCatById.get(id);
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

  // 필터 태그와 번역카드가 공유하는 고정 앵커. 재분류/노드 재활용 시에도 중복 생성되지 않음.
  let extraEl = messageEl.nextElementSibling;
  if (!extraEl || !extraEl.classList.contains('fm-extra')) {
    extraEl = document.createElement('div');
    extraEl.className = 'fm-extra';
    messageEl.parentNode.insertBefore(extraEl, messageEl.nextSibling);
  }
  return { authorEl, messageEl, extraEl };
}

function applyFilterToNode(node) {
  const parsed = extractMessage(node);
  if (!parsed) return;
  const { messageEl, extraEl } = parsed;
  // 번역으로 본문이 교체됐을 수 있으므로 분류·매칭은 항상 원문 기준
  const text = node.dataset.fmOrigText || messageEl.textContent || '';
  const category = classify(text, node.id);

  // 이전 처리 흔적 제거 (표시 방식이 바뀌었을 때 재적용하기 위함)
  node.classList.remove('fm-blur', 'fm-blocked', 'fm-revealed');
  delete node.dataset.fmLabel;
  messageEl.style.filter = '';
  node.style.display = '';
  // .fm-extra는 #message와 함께 유튜브 커스텀 엘리먼트의 shadow root 안에 있을 수 있어
  // 라이트 DOM 스타일시트(injectLabelStyle)가 못 미칠 수 있다 — 표시 여부는 inline style로 직접 제어.
  extraEl.style.display = '';

  translateNode(node, messageEl, extraEl, text); // fm-translate.js

  if (!settings.filterEnabled || !category || !settings.categories[category]) {
    const oldTag = extraEl.querySelector('.fm-filter-tag');
    if (oldTag) oldTag.remove();
    return; // Normal이거나, 필터가 꺼져 있거나, 해당 카테고리가 OFF면 그대로 노출
  }

  if (settings.displayMode === 'blur') {
    node.classList.add('fm-blur');
    node.dataset.fmLabel = blurLabel(category);
    messageEl.style.filter = 'blur(4px)';
    node.style.cursor = 'pointer';
    // 사용자가 클릭해서 열어둔 상태는 재분류 후에도 유지
    const revealed = node.dataset.fmRevealed === '1';
    if (revealed) node.classList.add('fm-revealed');
    // 필터 우선: 원문을 직접 공개(revealed)하기 전까지는 번역카드/필터태그도 함께 숨김
    extraEl.style.display = revealed ? '' : 'none';
    node.onclick = () => {
      node.classList.toggle('fm-revealed');
      const nowRevealed = node.classList.contains('fm-revealed');
      node.dataset.fmRevealed = nowRevealed ? '1' : '0';
      extraEl.style.display = nowRevealed ? '' : 'none';
    };

    let tag = extraEl.querySelector('.fm-filter-tag');
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'fm-filter-tag';
      tag.style.cssText = 'font-size:10px;color:#B3B3B3;margin:2px 0;';
      extraEl.insertBefore(tag, extraEl.firstChild); // 번역카드보다 항상 위 줄
    }
    tag.textContent = '🚫 ' + catLabel(category);
  } else {
    node.style.display = 'none';
  }
}

function reclassifyAllVisible() {
  const container = findItemsContainer();
  if (!container) return;
  container.childNodes.forEach((node) => applyFilterToNode(node));
}

// 새로 관찰된 채팅 하나를 서버로 올린다 — main.py가 YouTube API 없이 방송요약/핫토픽
// 재료를 모으는 유일한 경로(fm-socket.js의 sendToServer). 여러 시청자가 같은 채팅을
// 각자 올려도 서버가 메시지 id 기준으로 중복 제거하므로 여기선 그냥 보내기만 한다.
function _pushLiveChatToServer(node) {
  const parsed = extractMessage(node);
  if (!parsed) return;
  const { authorEl, messageEl } = parsed;
  const text = node.dataset.fmOrigText || messageEl.textContent || '';
  if (!text.trim()) return;
  sendToServer({ type: 'chat', id: node.id || '', author: authorEl ? authorEl.textContent : '', text });
}

function observeChat() {
  const container = findItemsContainer();
  if (!container) {
    setTimeout(observeChat, 500); // 채팅 DOM이 아직 준비되지 않았으면 재시도
    return;
  }

  // 이미 떠 있던 메시지도 한 번 처리 (필터만 — 서버 전송은 안 함, 그건 backfill의 역할)
  container.childNodes.forEach((node) => applyFilterToNode(node));

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        applyFilterToNode(node);
        _pushLiveChatToServer(node); // 진짜 신규 메시지만 서버로 push
      });
    });
  });
  observer.observe(container, { childList: true });
}
