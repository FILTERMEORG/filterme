'use strict';

// ---- AI 매니저 FILTERME: 최근 요약 + 채팅 분위기 패널 (SOOP SARSA 벤치마킹) ----
// DOM은 fm-ui.js가 관리하는 shadowRoot 안에 살고, 엘리먼트 참조는 fm-ui.js의 공유 els 맵을
// 통해서만 접근한다 — document.querySelector는 Shadow DOM 안을 못 뚫으므로 절대 쓰지 않는다.

let _managerState = {
  tab: 'recent',        // 'recent' | 'hottopic' | 'mood'
  summary: null,        // 서버가 보낸 마지막 summary payload
  hotTopics: null,      // 서버가 보낸 마지막 hot_topics payload
  mood: null,           // 서버가 보낸 마지막 mood percentages
  languages: null       // 서버가 보낸 마지막 시청자 언어 percentages
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
      <i class="fm-mgr-close" id="fmMgrClose">✕</i>
    </div>
    <div class="fm-mgr-tabs">
      <span class="fm-mgr-tab active" data-tab="recent"></span>
      <span class="fm-mgr-tab" data-tab="hottopic"></span>
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
  els.fmMgrClose.title = t('mgr_close_title');
  const tabLabels = { recent: t('mgr_tab_recent'), hottopic: t('mgr_tab_hottopic'), mood: t('mgr_tab_mood') };
  els.fmMgrPanel.querySelectorAll('.fm-mgr-tab').forEach((el) => {
    el.textContent = tabLabels[el.dataset.tab];
  });
}

function renderManagerBody() {
  if (!els.fmMgrBody) return;
  els.fmMgrPanel.querySelectorAll('.fm-mgr-tab').forEach((tabEl) => {
    tabEl.classList.toggle('active', tabEl.dataset.tab === _managerState.tab);
  });

  if (_managerState.tab === 'mood') {
    els.fmMgrBody.innerHTML = renderMoodTab(_managerState.mood, _managerState.languages);
  } else if (_managerState.tab === 'hottopic') {
    els.fmMgrBody.innerHTML = renderHotTopicTab(_managerState.hotTopics);
  } else {
    els.fmMgrBody.innerHTML = renderRecentTab(_managerState.summary);
  }
}

// "분석 중" 느낌을 주는 애니메이션 점 3개 + 문구 — LLM 호출이 실제로 진행 중일 때(phase:"analyzing")만 사용
function _analyzingHtml(label) {
  return `<div class="fm-mgr-empty fm-mgr-analyzing">
    <div class="fm-mgr-analyzing-dots"><span></span><span></span><span></span></div>
    <div>${label}</div>
  </div>`;
}

// 첫 분석 전, 아직 재료(채팅)가 부족할 때 — 애니메이션 없이 정적으로, "곧 시작됨"을 알림
function _insufficientHtml() {
  return `<div class="fm-mgr-empty">
    <div>${t('mgr_insufficient_title')}</div>
    <div class="fm-mgr-empty-sub">${t('mgr_insufficient_sub')}</div>
  </div>`;
}

// 첫 분석 전(available:false) 공용 처리 — phase가 analyzing이면 애니메이션, 아니면 "채팅 부족" 안내
function _pendingHtml(payload, analyzingLabel) {
  return payload && payload.phase === 'analyzing' ? _analyzingHtml(analyzingLabel) : _insufficientHtml();
}

function renderRecentTab(payload) {
  if (!payload || payload.available !== true) return _pendingHtml(payload, t('mgr_empty_recent'));
  const bullets = (payload.bullets || []).map((b) => `<div class="fm-mgr-bullet">· ${b}</div>`).join('');
  return `
    <div class="fm-mgr-status">${t('mgr_topic_label')}</div>
    <div class="fm-mgr-topic">${payload.topic || ''}</div>
    <div class="fm-mgr-status fm-mgr-bullets-label">${t('mgr_bullets_label')}</div>
    ${bullets}
    <div class="fm-mgr-footer">${t('mgr_footer_note')}</div>`;
}

function renderHotTopicTab(payload) {
  if (!payload || payload.available !== true) return _pendingHtml(payload, t('mgr_empty_hottopic'));
  const rows = (payload.topics || []).map((tp, i) => `
    <div class="fm-mgr-topic-row">
      <span class="fm-mgr-topic-rank">${i + 1}</span>
      <span class="fm-mgr-topic-name">${tp.topic}</span>
      <span class="fm-mgr-topic-count">${t('mgr_hottopic_count', { n: tp.count })}</span>
    </div>`).join('');
  return `<div class="fm-mgr-mood-note">${t('mgr_hottopic_note')}</div>${rows}`;
}

function _renderBars(pct, entries) {
  return entries.map(([key, label, color]) => `
    <div class="fm-mgr-bar-col">
      <span class="fm-mgr-bar-pct">${pct[key] || 0}%</span>
      <div class="fm-mgr-bar-track"><div class="fm-mgr-bar" style="height:${Math.max(pct[key] || 0, 2)}%;background:${color}"></div></div>
      <span class="fm-mgr-bar-label">${label}</span>
    </div>`).join('');
}

// 무드와 달리 언어 비율은 "전체 100%의 분포"라서 참고용 단일 스택 바 + 범례로 압축 표현
function _renderStackBar(pct, entries) {
  const segs = entries.map(([key, , color]) => `<div class="fm-mgr-stackbar-seg" style="width:${pct[key] || 0}%;background:${color}"></div>`).join('');
  const legend = entries.map(([key, label, color]) => `
    <span class="fm-mgr-legend-item"><i class="fm-mgr-legend-dot" style="background:${color}"></i>${label} ${pct[key] || 0}%</span>`).join('');
  return `<div class="fm-mgr-stackbar">${segs}</div><div class="fm-mgr-legend">${legend}</div>`;
}

function renderMoodTab(pct, langPct) {
  if (!pct && !langPct) return _analyzingHtml(t('mgr_empty_mood'));
  const cats = [
    ['normal', t('mgr_cat_normal'), '#1D9E75'], ['profanity', t('mgr_cat_profanity'), '#D85A30'],
    ['spam', t('mgr_cat_spam'), '#BA7517'], ['sexual', t('mgr_cat_sexual'), '#D4537E'], ['political', t('mgr_cat_political'), '#7F77DD']
  ];
  const langs = [
    ['ko', t('mgr_lang_ko'), '#4F9DDE'], ['ja', t('mgr_lang_ja'), '#E85D75'],
    ['zh', t('mgr_lang_zh'), '#F2B84B'], ['en', t('mgr_lang_en'), '#57C785'], ['other', t('mgr_lang_other'), '#9C9FA6']
  ];
  const moodSection = pct
    ? `<div class="fm-mgr-mood-note">${t('mgr_mood_note')}</div><div class="fm-mgr-bars">${_renderBars(pct, cats)}</div>`
    : '';
  const langSection = langPct
    ? `<div class="fm-mgr-status fm-mgr-bullets-label">${t('mgr_lang_title')}</div>${_renderStackBar(langPct, langs)}`
    : '';
  return moodSection + langSection;
}

function openManagerPanel() {
  if (!els.fmMgrPanel) return;
  closeModal(); // 전체 설정 모달과 상호 배타 (fm-ui.js)
  els.fmMgrPanel.classList.add('open');
  renderManagerBody();
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
}

// fm-socket.js의 onmessage가 호출
function onManagerServerMessage(m) {
  if (m.type === 'summary') { _managerState.summary = m; renderManagerBody(); }
  else if (m.type === 'hot_topics') { _managerState.hotTopics = m; renderManagerBody(); }
  else if (m.type === 'mood') {
    if (m.percentages) _managerState.mood = m.percentages;
    if (m.languages) _managerState.languages = m.languages;
    renderManagerBody();
  }
}
