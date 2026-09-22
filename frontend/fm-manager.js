'use strict';

// ---- AI 매니저 FILTERME: 최근 요약 + 채팅 분위기 패널 (SOOP SARSA 벤치마킹) ----
// DOM은 fm-ui.js가 관리하는 shadowRoot 안에 살고, 엘리먼트 참조는 fm-ui.js의 공유 els 맵을
// 통해서만 접근한다 — document.querySelector는 Shadow DOM 안을 못 뚫으므로 절대 쓰지 않는다.

let _managerState = {
  tab: 'recent',        // 'recent' | 'mood'
  summary: null,        // 서버가 보낸 마지막 summary payload
  mood: null            // 서버가 보낸 마지막 mood percentages
};

function buildManagerPanel() {
  const el = document.createElement('div');
  el.className = 'fm-mgr-panel';
  el.id = 'fmMgrPanel';
  el.style.cssText = 'pointer-events:auto;';
  el.innerHTML = `
    <div class="fm-mgr-head">
      <span class="fm-mgr-avatar">F<span>M</span></span>
      <span class="fm-mgr-title"></span>
      <i class="fm-mgr-refresh" id="fmMgrRefresh">⟳</i>
      <i class="fm-mgr-close" id="fmMgrClose">✕</i>
    </div>
    <div class="fm-mgr-tabs">
      <span class="fm-mgr-tab active" data-tab="recent"></span>
      <span class="fm-mgr-tab" data-tab="mood"></span>
    </div>
    <div class="fm-mgr-body" id="fmMgrBody"></div>
  `;
  return el;
}

// 온보딩/스트립과 동일한 패턴: 정적 문구는 처음 빈 채로 두고, 이 함수로 채우고 syncAllUI()에서
// 매번 다시 호출해 언어가 나중에 바뀌어도(국가 재선택 등) 이미 만들어진 패널이 갱신되게 한다.
function refreshManagerTexts() {
  if (!els.fmMgrPanel) return;
  els.fmMgrPanel.querySelector('.fm-mgr-title').textContent = t('mgr_title');
  els.fmMgrRefresh.title = t('mgr_refresh_title');
  els.fmMgrClose.title = t('mgr_close_title');
  els.fmMgrPanel.querySelectorAll('.fm-mgr-tab').forEach((el) => {
    el.textContent = el.dataset.tab === 'recent' ? t('mgr_tab_recent') : t('mgr_tab_mood');
  });
}

function renderManagerBody() {
  if (!els.fmMgrBody) return;
  els.fmMgrPanel.querySelectorAll('.fm-mgr-tab').forEach((tabEl) => {
    tabEl.classList.toggle('active', tabEl.dataset.tab === _managerState.tab);
  });
  els.fmMgrRefresh.style.display = _managerState.tab === 'recent' ? '' : 'none';

  if (_managerState.tab === 'mood') {
    els.fmMgrBody.innerHTML = renderMoodTab(_managerState.mood);
  } else {
    els.fmMgrBody.innerHTML = renderRecentTab(_managerState.summary);
  }
}

// "분석 중" 느낌을 주는 애니메이션 점 3개 + 문구 — 정적인 빈 상태 대신 사용
function _analyzingHtml(label) {
  return `<div class="fm-mgr-empty fm-mgr-analyzing">
    <div class="fm-mgr-analyzing-dots"><span></span><span></span><span></span></div>
    <div>${label}</div>
  </div>`;
}

function renderRecentTab(payload) {
  if (!payload || payload.available === false) {
    return _analyzingHtml(t('mgr_empty_recent'));
  }
  const bullets = (payload.bullets || []).map((b) => `<div class="fm-mgr-bullet">· ${b}</div>`).join('');
  const status = payload.cached ? t('mgr_status_cached') : t('mgr_status_now');
  return `
    <div class="fm-mgr-status">${status}</div>
    ${bullets}`;
}

function renderMoodTab(pct) {
  if (!pct) return _analyzingHtml(t('mgr_empty_mood'));
  const cats = [
    ['normal', t('mgr_cat_normal'), '#1D9E75'], ['profanity', t('mgr_cat_profanity'), '#D85A30'],
    ['spam', t('mgr_cat_spam'), '#BA7517'], ['sexual', t('mgr_cat_sexual'), '#D4537E'], ['political', t('mgr_cat_political'), '#7F77DD']
  ];
  const bars = cats.map(([key, label, color]) => `
    <div class="fm-mgr-bar-col">
      <span class="fm-mgr-bar-pct">${pct[key] || 0}%</span>
      <div class="fm-mgr-bar-track"><div class="fm-mgr-bar" style="height:${Math.max(pct[key] || 0, 2)}%;background:${color}"></div></div>
      <span class="fm-mgr-bar-label">${label}</span>
    </div>`).join('');
  return `<div class="fm-mgr-mood-note">${t('mgr_mood_note')}</div>
    <div class="fm-mgr-bars">${bars}</div>`;
}

function openManagerPanel() {
  if (!els.fmMgrPanel) return;
  closeModal(); // 전체 설정 모달과 상호 배타 (fm-ui.js)
  els.fmMgrPanel.classList.add('open');
  renderManagerBody();
  if (!_managerState.summary) sendToServer({ type: 'summary_request' }); // fm-socket.js
}
function closeManagerPanel() {
  if (els.fmMgrPanel) els.fmMgrPanel.classList.remove('open');
}

// FAB 클릭용 — 이미 열려 있으면 닫고, 닫혀 있으면 연다.
function toggleManagerPanel() {
  if (!els.fmMgrPanel) return;
  if (els.fmMgrPanel.classList.contains('open')) closeManagerPanel();
  else openManagerPanel();
}

function wireManagerEvents() {
  if (!els.fmMgrPanel) return;
  els.fmMgrPanel.querySelectorAll('.fm-mgr-tab').forEach((tabEl) => {
    tabEl.addEventListener('click', () => { _managerState.tab = tabEl.dataset.tab; renderManagerBody(); });
  });
  els.fmMgrClose.addEventListener('click', closeManagerPanel);
  els.fmMgrRefresh.addEventListener('click', () => {
    sendToServer({ type: 'summary_request' }); // fm-socket.js
  });
}

// fm-socket.js의 onmessage가 호출
function onManagerServerMessage(m) {
  if (m.type === 'summary') { _managerState.summary = m; renderManagerBody(); }
  else if (m.type === 'mood') { _managerState.mood = m.percentages; renderManagerBody(); }
}
