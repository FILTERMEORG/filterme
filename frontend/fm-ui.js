'use strict';

// ---- Shadow DOM UI: 상단 스트립, 플로팅 버튼, 전체 설정 모달, 온보딩 ----
// 실제 설정 화면 마크업은 popup.html 하나뿐이고, 여기 모달은 그걸 iframe으로 불러와 보여준다.

let shadowRoot;
let els = {};

function buildUI() {
  const host = document.createElement('div');
  host.id = 'filterme-host';
  // 이 wrapper 자체는 문서 흐름에 전혀 영향을 주지 않아야 한다.
  // (전에는 body.prepend로 흐름에 끼워 넣어서 iframe 전체 높이를 넘겨버리는 바람에
  //  채팅 입력창이 화면 밖으로 밀려나는 문제가 있었음)
  host.style.cssText = 'all:initial; position:fixed; top:0; left:0; right:0; z-index:2147483000; pointer-events:none;';
  document.body.appendChild(host);
  shadowRoot = host.attachShadow({ mode: 'open' });

  reserveNativeChatSpace();

  shadowRoot.innerHTML = `
    <style>${STYLE}</style>
    <div class="fm-strip" id="fmStrip" style="pointer-events:auto;">
      <span class="fm-conn-dot connecting" id="fmConnDot"></span>
      <span class="fm-mark">F<span>M</span></span>
      <i class="fm-gear" id="fmGear">⚙</i>
      <span class="fm-toggle" id="fmToggle"><span class="dot"></span></span>
      <span class="fm-conn-txt" id="fmConnTxt"></span>
      <span class="fm-toggle" id="fmTrToggle"><span class="dot"></span></span>
      <span class="fm-tr-status" id="fmTrStatus"></span>
    </div>

    <div class="fm-fab" id="fmFab" style="pointer-events:auto;">
      F<span class="m">M</span>
      <div class="fm-fab-tip">
        <b class="fm-fab-tip-label"></b>
        <span class="fm-fab-tip-desc"></span>
      </div>
    </div>

    <div class="fm-backdrop" id="fmBackdrop" style="pointer-events:auto;"></div>

    <div class="fm-modal" id="fmModal" style="pointer-events:auto;">
      <div class="fm-modal-head">
        <span class="fm-modal-brand">FILTER<span>M</span>E</span>
        <span class="fm-modal-close" id="fmModalClose">✕</span>
      </div>
      <!-- 설정 화면 실제 마크업은 popup.html 하나에만 있고, 여기서는 그걸 그대로 불러와 보여준다.
           (web_accessible_resources로 노출된 확장 프로그램 자체 페이지라 chrome.storage 접근이
           popup.html을 툴바 아이콘으로 열었을 때와 완전히 동일하게 동작한다) -->
      <iframe id="fmModalFrame" class="fm-modal-iframe"></iframe>
    </div>

    <div class="fm-onboard" id="fmOnboard" style="pointer-events:auto;">
      <div class="ob-step" id="obStepCountry">
        <div class="ob-head">
          <h2>${t('country_select_title')}</h2>
          <p>${t('country_select_desc')}</p>
        </div>
        <div class="ob-country-list" id="obCountryList"></div>
      </div>
      <div class="ob-step" id="obStepCategory">
        <div class="ob-head">
          <span class="ob-badge" id="obBadge"></span>
          <h2 id="obTitle"></h2>
          <p id="obDesc"></p>
        </div>
        <div class="ob-body" id="obBody"></div>
        <div class="ob-footer">
          <button class="ob-cta" id="obApply"></button>
          <span class="ob-skip" id="obSkip"></span>
        </div>
      </div>
    </div>

    <div class="fm-lang-scrim" id="fmLangScrim" style="pointer-events:auto;"></div>
    <div class="fm-lang-sheet" id="fmLangSheet" style="pointer-events:auto;">
      <div class="fm-lang-sheet-head" id="fmLangSheetHead"></div>
      <div class="fm-lang-sheet-list" id="fmLangSheetList"></div>
    </div>
  `;

  shadowRoot.appendChild(buildManagerPanel()); // fm-manager.js — fm-modal/fm-backdrop과 같은 레벨

  els = {
    fmStrip: shadowRoot.getElementById('fmStrip'),
    fmGear: shadowRoot.getElementById('fmGear'),
    fmToggle: shadowRoot.getElementById('fmToggle'),
    fmConnDot: shadowRoot.getElementById('fmConnDot'),
    fmConnTxt: shadowRoot.getElementById('fmConnTxt'),
    fmTrToggle: shadowRoot.getElementById('fmTrToggle'),
    fmLangScrim: shadowRoot.getElementById('fmLangScrim'),
    fmLangSheet: shadowRoot.getElementById('fmLangSheet'),
    fmLangSheetHead: shadowRoot.getElementById('fmLangSheetHead'),
    fmLangSheetList: shadowRoot.getElementById('fmLangSheetList'),
    fmTrStatus: shadowRoot.getElementById('fmTrStatus'),
    fmFab: shadowRoot.getElementById('fmFab'),
    fmBackdrop: shadowRoot.getElementById('fmBackdrop'),
    fmModal: shadowRoot.getElementById('fmModal'),
    fmModalClose: shadowRoot.getElementById('fmModalClose'),
    fmModalFrame: shadowRoot.getElementById('fmModalFrame'),
    fmOnboard: shadowRoot.getElementById('fmOnboard'),
    obStepCountry: shadowRoot.getElementById('obStepCountry'),
    obStepCategory: shadowRoot.getElementById('obStepCategory'),
    obCountryList: shadowRoot.getElementById('obCountryList'),
    obBadge: shadowRoot.getElementById('obBadge'),
    obTitle: shadowRoot.getElementById('obTitle'),
    obDesc: shadowRoot.getElementById('obDesc'),
    obBody: shadowRoot.getElementById('obBody'),
    obApply: shadowRoot.getElementById('obApply'),
    obSkip: shadowRoot.getElementById('obSkip'),
    fmMgrPanel: shadowRoot.getElementById('fmMgrPanel'),
    fmMgrBody: shadowRoot.getElementById('fmMgrBody'),
    fmMgrClose: shadowRoot.getElementById('fmMgrClose')
  };

  // popup.html을 그대로 불러온다. chrome.runtime.getURL은 content script에서도 사용 가능.
  els.fmModalFrame.src = chrome.runtime.getURL('popup.html');

  renderCountryOptions();
  wireEvents();
  wireManagerEvents(); // fm-manager.js
  refreshManagerTexts(); // fm-manager.js
  syncAllUI();

  if (!settings.onboarded) {
    els.fmOnboard.classList.add('show');
  }
}

// ---- 국가 선택 (온보딩 0단계) ----
// 카드 목록 자체(국기+국가명)는 언어와 무관하게 고정이라 한 번만 렌더링한다.
function renderCountryOptions() {
  els.obCountryList.innerHTML = Object.entries(COUNTRY_META)
    .map(
      ([code, meta]) => `
      <div class="ob-country-card" data-code="${code}">
        <span class="ob-country-flag">${meta.flag}</span>
        <span class="ob-country-label">${meta.label}</span>
      </div>`
    )
    .join('');

  els.obCountryList.querySelectorAll('.ob-country-card').forEach((card) => {
    card.addEventListener('click', () => {
      applyCountry(card.dataset.code);
      syncAllUI();
    });
  });
}

// settings.country 유무에 따라 국가 선택 단계 / 카테고리 온보딩 단계를 전환
function showOnboardStep() {
  if (!els.obStepCountry) return;
  els.obStepCountry.classList.toggle('active', !settings.country);
  els.obStepCategory.classList.toggle('active', !!settings.country);
}

// 온보딩 안의 정적 문구(배지/제목/설명/버튼)와 카테고리 목록을 현재 언어로 다시 그림
function applyOnboardTexts() {
  if (!els.obBadge) return;
  els.obBadge.textContent = '✨ ' + t('ob_badge');
  els.obTitle.innerHTML = t('ob_title');
  els.obDesc.textContent = t('ob_desc');
  els.obApply.textContent = t('ob_apply');
  els.obSkip.textContent = t('ob_skip');
  renderOnboardCategories();
}

// ---- 전체 설정 모달 (플로팅 로고 버튼 클릭 시 그 자리에서 바로 열림) ----
function openModal() {
  closeManagerPanel(); // AI 매니저 패널과 상호 배타 (fm-manager.js)
  els.fmBackdrop.classList.add('open');
  els.fmModal.classList.add('open');
}
function closeModal() {
  els.fmBackdrop.classList.remove('open');
  els.fmModal.classList.remove('open');
}

// popup.html(iframe 내부)이 자기 콘텐츠 높이를 알려주면 그 값대로 iframe 크기를 맞춘다.
// (탭마다 내용 길이가 달라서, 고정 높이 대신 실제 내용에 맞춰 자동으로 커지고 줄어듦)
// + "온보딩 다시 보기" 버튼처럼 팝업 쪽에서 모달을 닫아달라고 요청하는 경우도 처리한다.
window.addEventListener('message', (e) => {
  if (!e.data || e.data.source !== 'filterme-popup') return;
  if (typeof e.data.height === 'number' && els.fmModalFrame) {
    els.fmModalFrame.style.height = Math.max(e.data.height, 120) + 'px';
  }
  if (e.data.action === 'close') {
    // 팝업(iframe)이 방금 저장한 값이 storage.onChanged로 이 컨텍스트에 반영되기 전에
    // 도착할 수 있으므로, 온보딩을 다시 띄우기 전에 최신값을 한 번 직접 읽어온다.
    chrome.storage.local.get(['country', 'onboarded'], (fresh) => {
      Object.assign(settings, fresh);
      closeModal();
      syncAllUI();
      els.fmOnboard.classList.add('show');
    });
  }
});

// ---- 온보딩 화면 ----
function renderOnboardCategories() {
  els.obBody.innerHTML =
    Object.entries(CATEGORY_META)
      .map(
        ([key, meta]) => `
      <div class="ob-cat">
        <div><div class="ob-cat-title">${catLabel(key)}</div><div class="ob-cat-desc">${meta.name}</div></div>
        <div class="ob-switch" data-cat="${key}"></div>
      </div>`
      )
      .join('') +
    `<div class="ob-section-label">${t('ob_display_label')}</div>
     <div class="fm-mode-toggle" id="obModeToggle">
        <div class="fm-mode-opt blur" data-mode="blur">${t('mode_blur')}</div>
        <div class="fm-mode-opt block" data-mode="block">${t('mode_block')}</div>
     </div>`;

  els.obBody.querySelectorAll('.ob-switch').forEach((sw) => {
    sw.addEventListener('click', () => {
      const cat = sw.dataset.cat;
      const next = { ...settings.categories, [cat]: !settings.categories[cat] };
      saveSettings({ categories: next });
      syncAllUI();
    });
  });
  els.obBody.querySelectorAll('#obModeToggle .fm-mode-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      saveSettings({ displayMode: opt.dataset.mode });
      syncAllUI();
    });
  });
}

// ---- 스트립/온보딩을 현재 settings 기준으로 다시 그림 ----
// (전체 설정 모달 내부는 이제 popup.html이 알아서 자기 chrome.storage.onChanged로 갱신하므로
//  content.js가 그 안까지 직접 건드릴 필요가 없다 — 중복 동기화 코드가 통째로 사라짐)
function syncAllUI() {
  if (!els.fmToggle) return;

  els.fmFab.title = t('mgr_open_title');
  {
    const tipLabel = els.fmFab.querySelector('.fm-fab-tip-label');
    const tipDesc = els.fmFab.querySelector('.fm-fab-tip-desc');
    if (tipLabel) tipLabel.textContent = t('fab_tip_label');
    if (tipDesc) tipDesc.textContent = t('fab_tip_desc');
  }
  if (els.fmGear) els.fmGear.title = t('settings_gear_title');
  showOnboardStep();
  applyOnboardTexts();
  refreshManagerTexts(); // fm-manager.js
  renderManagerBody(); // fm-manager.js

  els.fmToggle.classList.toggle('on', settings.filterEnabled);
  els.fmToggle.classList.toggle('off', !settings.filterEnabled);
  els.fmToggle.innerHTML = `<span class="dot"></span>${settings.filterEnabled ? t('filter_on') : t('filter_off')}`;
  els.fmStrip.classList.toggle('disabled', !settings.filterEnabled);

  els.obBody.querySelectorAll('.ob-switch[data-cat]').forEach((sw) => {
    const on = !!settings.categories[sw.dataset.cat];
    sw.classList.toggle('on', on);
    sw.classList.toggle('off', !on);
  });
  shadowRoot.querySelectorAll('#obModeToggle .fm-mode-opt').forEach((o) => {
    o.classList.toggle('active', o.dataset.mode === settings.displayMode);
  });

  if (els.fmTrToggle) {
    const trOn = !!settings.translateRecvTo;
    els.fmTrToggle.classList.toggle('on', trOn);
    els.fmTrToggle.classList.toggle('off', !trOn);
    els.fmTrToggle.innerHTML = `<span class="dot"></span>${trOn ? t('translate_on') : t('translate_off')}`;
  }

  syncSendBar();
  refreshSendBarLangs();
  reclassifyAllVisible();
}

// 언어팩 다운로드 진행률을 스트립에 표시
function showTrStatus(loaded) {
  if (!els.fmTrStatus) return;
  if (loaded >= 1) { els.fmTrStatus.textContent = ''; return; }
  els.fmTrStatus.textContent = t('lang_pack_progress', { pct: Math.round((loaded || 0) * 100) });
}

// ---- 언어 선택 바텀시트 (표시 언어[1] / 보낼 언어[3]가 공유하는 컴포넌트) ----
let _langSheetOnSelect = null;
let _langSheetTrigger = null;

function openLangSheet({ title, codes, current, onSelect, triggerEl }) {
  els.fmLangSheetHead.textContent = title;
  els.fmLangSheetList.innerHTML = codes
    .map((code) => {
      const meta = LANG_META[code] || { short: code.toUpperCase(), label: code };
      return `<div class="fm-lang-item${code === current ? ' selected' : ''}" data-code="${code}">
        <span class="fm-lang-item-label">${meta.label}</span>
        <span class="fm-lang-item-check">✓</span>
      </div>`;
    })
    .join('');
  _langSheetOnSelect = onSelect;
  _langSheetTrigger = triggerEl || null;
  if (_langSheetTrigger) _langSheetTrigger.classList.add('active');
  els.fmLangScrim.classList.add('open');
  els.fmLangSheet.classList.add('open');
}
function closeLangSheet() {
  els.fmLangScrim.classList.remove('open');
  els.fmLangSheet.classList.remove('open');
  if (_langSheetTrigger) _langSheetTrigger.classList.remove('active');
  _langSheetTrigger = null;
}

function wireEvents() {
  els.fmToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    saveSettings({ filterEnabled: !settings.filterEnabled });
    syncAllUI();
    warmupTranslators(settings.translateRecvTo, showTrStatus); // 제스처 보강
  });

  // 번역 on/off — 켜면 전체 채팅을 한국어로 번역(국가별 분기 전까지는 대상 고정).
  // 이 click 이 user activation → 언어팩 다운로드 허용
  if (els.fmTrToggle) {
    els.fmTrToggle.addEventListener('click', () => {
      const next = settings.translateRecvTo ? '' : (settings.uiLang || 'ko');
      saveSettings({ translateRecvTo: next });
      if (els.fmTrStatus) els.fmTrStatus.textContent = '';
      warmupTranslators(next, showTrStatus);
      syncAllUI();
    });
  }
  if (els.fmLangSheetList) {
    els.fmLangSheetList.addEventListener('click', (e) => {
      const item = e.target.closest('.fm-lang-item');
      if (item && _langSheetOnSelect) _langSheetOnSelect(item.dataset.code);
    });
  }
  if (els.fmLangScrim) els.fmLangScrim.addEventListener('click', closeLangSheet);

  // FAB는 AI 매니저 패널을 토글(열려있으면 닫기)하고, 스트립의 톱니바퀴는 전체 설정 모달을 연다.
  els.fmFab.addEventListener('click', () => {
    toggleManagerPanel(); // fm-manager.js
    warmupTranslators(settings.translateRecvTo, showTrStatus); // 제스처 보강
  });
  if (els.fmGear) {
    els.fmGear.addEventListener('click', () => {
      openModal();
      warmupTranslators(settings.translateRecvTo, showTrStatus); // 제스처 보강
    });
  }
  els.fmModalClose.addEventListener('click', closeModal);
  els.fmBackdrop.addEventListener('click', closeModal);

  const finishOnboarding = () => {
    saveSettings({ onboarded: true });
    els.fmOnboard.classList.remove('show');
  };
  els.obApply.addEventListener('click', finishOnboarding);
  els.obSkip.addEventListener('click', finishOnboarding);
}

// ---- 네이티브 채팅 레이아웃 보정 ----
// FM 스트립은 position:fixed라 흐름에 영향을 주진 않지만, 그대로 두면
// 유튜브 헤더/채팅 상단을 그대로 덮어버린다. 실제 채팅 컨테이너에
// 스트립 높이만큼 상단 padding을 예약해서 겹치지 않게 만든다.
// (선택자가 유튜브 업데이트로 안 맞아도 fm-strip 자체는 fixed라 입력창을
//  밀어내는 원래 버그는 재발하지 않는다 — 최악의 경우 살짝 겹쳐 보일 뿐)
function reserveNativeChatSpace() {
  const style = document.createElement('style');
  style.id = 'filterme-native-space';
  style.textContent = `
    yt-live-chat-app {
      box-sizing: border-box !important;
      padding-top: ${STRIP_HEIGHT}px !important;
    }
  `;
  document.head.appendChild(style);
}

// ---- 유튜브 라이트 DOM에 주입하는 스타일 (블러 라벨, 언어 배지, 송신 바) ----
function injectLabelStyle() {
  const s = document.createElement('style');
  s.textContent = `
    yt-live-chat-text-message-renderer.fm-blur { position: relative !important; }
    yt-live-chat-text-message-renderer.fm-blur::after {
      content: attr(data-fm-label);
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      text-align: center; font-size: 11px; color: #fff;
      background: rgba(0,0,0,0.62); padding: 0 8px;
      z-index: 3; pointer-events: none;
    }
    yt-live-chat-text-message-renderer.fm-blur.fm-revealed::after { display: none; }
    yt-live-chat-text-message-renderer.fm-blur.fm-revealed #message { filter: none !important; };
    .fm-lang { margin-left: 4px; font-size: 0.95em; vertical-align: middle; }

    /* [2] 번역카드 + 필터 태그 (원문 바로 아래, .fm-extra 앵커 안) */
    .fm-extra { display: block; }
    .fm-blur:not(.fm-revealed) .fm-extra { display: none; } /* 필터 우선: 원문 공개 전엔 번역카드도 숨김 */
    .fm-filter-tag { font-size: 10px; color: #B3B3B3; margin: 2px 0; }
    .fm-tr-card {
      display: flex; align-items: flex-start; gap: 6px; margin-top: 4px; padding: 6px 10px;
      background: #181818; border-left: 3px solid #1DB954; border-radius: 0 8px 8px 0;
      font-size: 12px; color: #fff;
    }
    .fm-tr-lang {
      flex: 0 0 auto; font-size: 10px; font-weight: 700; color: #1DB954;
      background: rgba(29,185,84,.16); border-radius: 100px; padding: 2px 6px;
    }
    .fm-tr-text { flex: 1; line-height: 1.4; }
    .fm-tr-toggle { flex: 0 0 auto; font-size: 10px; color: #B3B3B3; text-decoration: underline; cursor: pointer; white-space: nowrap; }

    /* [3] 입력창 언어 페어 바 */
    @keyframes fm-tr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
    #fm-send-bar { display: none; flex-direction: column; gap: 4px; padding: 6px 10px; background: #0f0f0f; border-top: 1px solid #2a2a2a; }
    #fm-lang-pair { display: flex; align-items: center; gap: 6px; }
    .fm-chip {
      display: inline-flex; align-items: center; gap: 4px; background: #282828; color: #fff;
      border: 1px solid #2A2A2A; border-radius: 100px; padding: 4px 9px; font-size: 11px; font-weight: 700;
    }
    .fm-chip-dst { cursor: pointer; }
    .fm-chip-caret { color: #B3B3B3; font-size: 9px; }
    .fm-arrow { color: #B3B3B3; font-size: 12px; padding: 0 2px; }
    #fm-send-row { display: flex; gap: 6px; align-items: center; }
    #fm-send-input { flex: 1; min-width: 0; background: #222; border: 1px solid #333; border-radius: 100px; color: #fff; padding: 6px 12px; font-size: 12px; outline: none; }
    #fm-send-input::placeholder { color: #888; }
    #fm-send-input:disabled { opacity: 0.5; }
    #fm-send-btn { background: #1DB954; color: #000; border: none; border-radius: 100px; padding: 6px 14px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
    #fm-send-btn:disabled { opacity: 0.5; cursor: default; }
    .fm-tr-preview { font-size: 12px; color: #B3B3B3; background: #181818; border: 1px solid #2A2A2A; border-radius: 10px; padding: 6px 10px; }
    .fm-tr-preview.loading { color: #727272; animation: fm-tr-pulse 1s ease-in-out infinite; }
    .fm-tr-preview.error { color: #F5A623; }
  `;
  document.head.appendChild(s);
}

// ---- Shadow DOM 안에서 쓰는 스타일 ----
const STYLE = `
  :host {
    all: initial;
    --fm-bg:#121212; --fm-bg-elevated:#181818; --fm-bg-hover:#282828;
    --fm-border:#2A2A2A; --fm-text-secondary:#B3B3B3;
    --fm-accent:#1DB954; --fm-accent-bg:rgba(29,185,84,.16);
    --fm-warn:#F5A623; --fm-warn-bg:rgba(245,166,35,.16);
    --fm-danger:#E91429; --fm-danger-bg:rgba(233,20,41,.16);
  }
  * { box-sizing: border-box; font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }

  .fm-strip{
    position:fixed;top:0;left:0;right:0;height:${STRIP_HEIGHT}px;z-index:2147483000; /* base */
    display:flex;align-items:center;gap:8px;padding:0 10px;box-sizing:border-box;
    background:var(--fm-bg-elevated);border-top:2px solid var(--fm-accent);border-bottom:1px solid var(--fm-border);
  }
  .fm-strip.disabled{border-top-color:#535353;}
  .fm-mark{font-size:11px;font-weight:800;color:#fff;} /* 더 이상 클릭 대상이 아님(장식용 로고) */
  .fm-mark span{color:var(--fm-accent);}
  .fm-toggle{display:flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:100px;cursor:pointer;}
  .fm-toggle.on{background:var(--fm-accent-bg);color:var(--fm-accent);}
  .fm-toggle.on .dot{background:var(--fm-accent);}
  .fm-toggle.off{background:var(--fm-bg-hover);color:var(--fm-text-secondary);}
  .fm-toggle.off .dot{background:#727272;}
  .fm-toggle .dot{width:5px;height:5px;border-radius:50%;display:inline-block;}

  .fm-conn-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:#727272;}
  .fm-conn-dot.connected{background:var(--fm-accent);}
  .fm-conn-dot.connecting{background:var(--fm-warn);animation:fm-pulse 1s ease-in-out infinite;}
  .fm-conn-dot.retrying{background:var(--fm-danger);}
  @keyframes fm-pulse{0%,100%{opacity:1;}50%{opacity:.25;}}
  .fm-conn-txt{font-size:9.5px;color:var(--fm-text-secondary);white-space:nowrap;}

  #fmTrToggle{margin-left:auto;}
  .fm-tr-status{font-size:9.5px;color:var(--fm-text-secondary);white-space:nowrap;}

  .fm-lang-scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483004;display:none;}
  .fm-lang-scrim.open{display:block;}
  .fm-lang-sheet{position:fixed;left:0;right:0;bottom:0;background:var(--fm-bg-elevated);
    border-radius:16px 16px 0 0;z-index:2147483005;padding:10px 0 16px;
    transform:translateY(100%);transition:transform .2s ease;box-shadow:0 -16px 40px -12px rgba(0,0,0,.6);}
  .fm-lang-sheet.open{transform:translateY(0);}
  .fm-lang-sheet-head{font-size:12.5px;font-weight:800;color:#fff;padding:6px 18px 10px;}
  .fm-lang-item{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;
    font-size:13px;font-weight:600;color:#fff;cursor:pointer;}
  .fm-lang-item:active{background:var(--fm-bg-hover);}
  .fm-lang-item-check{color:var(--fm-accent);font-weight:800;visibility:hidden;}
  .fm-lang-item.selected .fm-lang-item-check{visibility:visible;}

  .fm-gear{
    font-size:15px;color:rgba(255,255,255,.65);cursor:pointer;font-style:normal;
    padding:4px 6px;border-radius:6px;line-height:1;
  }
  .fm-gear:hover{color:#fff;background:var(--fm-bg-hover);}

  @keyframes fm-fab-pulse {
    0%, 100% { box-shadow: 0 6px 16px -4px rgba(0,0,0,.6), 0 0 0 0 rgba(127,119,221,.55); }
    50% { box-shadow: 0 6px 16px -4px rgba(0,0,0,.6), 0 0 0 6px rgba(127,119,221,0); }
  }
  .fm-fab{
    position:fixed;right:16px;bottom:145px;width:42px;height:42px;border-radius:50%;
    background:#000;color:#fff;display:flex;align-items:center;justify-content:center;
    font-size:11px;font-weight:800;cursor:pointer;z-index:2147483000; /* base */
    border:2px solid #7F77DD;
    animation:fm-fab-pulse 2.4s ease-in-out infinite; /* 은은한 상시 펄스 — 호버 없이도 신호 */
  }
  .fm-fab-tip{
    position:absolute;right:52px;bottom:2px;width:168px;
    background:#1B1830;border:1px solid #7F77DD;border-radius:10px;
    padding:9px 11px;box-shadow:0 10px 26px -10px rgba(0,0,0,.7);
    opacity:0;transform:translateX(6px);pointer-events:none;
    transition:opacity .15s ease, transform .15s ease;
    text-align:left;
  }
  .fm-fab-tip-label{display:block;font-size:11.5px;font-weight:800;color:#fff;margin-bottom:2px;}
  .fm-fab-tip-desc{display:block;font-size:10.5px;color:var(--fm-text-secondary);line-height:1.4;font-weight:400;}
  .fm-fab-tip::after{
    content:"";position:absolute;right:-5px;bottom:16px;width:8px;height:8px;
    background:#1B1830;border-right:1px solid #7F77DD;border-bottom:1px solid #7F77DD;
    transform:rotate(-45deg);
  }
  .fm-fab:hover .fm-fab-tip{opacity:1;transform:translateX(0);}
  .fm-fab .m{color:#7F77DD;} /* AI 매니저 패널 헤더 로고(.fm-mgr-avatar span)와 동일한 색 */

  /* ---- AI 매니저 FILTERME: 독립 플로팅 패널(백드롭 없음, FAB 클릭 시 바로 열림) ---- */
  .fm-mgr-panel{
    position:fixed;top:${STRIP_HEIGHT + 8}px;left:10px;width:300px;
    background:var(--fm-bg-elevated);border-radius:14px;box-shadow:0 20px 44px -14px rgba(0,0,0,.6);
    z-index:2147483002;display:none;overflow:hidden;
  }
  .fm-mgr-panel.open{display:block;}
  .fm-mgr-head{padding:12px 14px;border-bottom:1px solid var(--fm-border);display:flex;align-items:center;gap:8px;}
  .fm-mgr-avatar{font-size:12px;font-weight:800;color:#fff;}
  .fm-mgr-avatar span{color:#7F77DD;}
  .fm-mgr-title{font-size:12.5px;font-weight:800;color:#fff;flex:1;}
  .fm-mgr-close{
    cursor:pointer;color:rgba(255,255,255,.65);font-size:16px;font-style:normal;
    margin-left:4px;padding:4px 6px;border-radius:6px;line-height:1;
  }
  .fm-mgr-close:hover{color:#fff;background:var(--fm-bg-hover);}
  .fm-mgr-tabs{display:flex;border-bottom:1px solid var(--fm-border);}
  .fm-mgr-tab{flex:1;text-align:center;padding:9px 0;font-size:11.5px;font-weight:700;color:var(--fm-text-secondary);cursor:pointer;border-bottom:2px solid transparent;}
  .fm-mgr-tab.active{color:#fff;border-bottom-color:#7F77DD;}
  .fm-mgr-body{padding:12px 14px;max-height:280px;overflow-y:auto;}
  .fm-mgr-empty{font-size:12px;color:var(--fm-text-secondary);text-align:center;padding:20px 0;}
  .fm-mgr-analyzing{display:flex;flex-direction:column;align-items:center;gap:10px;}
  .fm-mgr-analyzing-dots{display:flex;gap:5px;}
  .fm-mgr-analyzing-dots span{
    width:7px;height:7px;border-radius:50%;background:#7F77DD;
    animation:fm-mgr-dot-pulse 1.2s ease-in-out infinite;
  }
  .fm-mgr-analyzing-dots span:nth-child(2){animation-delay:.2s;}
  .fm-mgr-analyzing-dots span:nth-child(3){animation-delay:.4s;}
  @keyframes fm-mgr-dot-pulse{
    0%,60%,100%{opacity:.25;transform:scale(.8);}
    30%{opacity:1;transform:scale(1);}
  }
  .fm-mgr-status{font-size:10.5px;color:var(--fm-text-secondary);margin-bottom:8px;}
  .fm-mgr-status.fm-mgr-bullets-label{margin-top:12px;}
  .fm-mgr-topic{font-size:13px;color:#fff;line-height:1.5;font-weight:600;}
  .fm-mgr-bullet{font-size:12.5px;color:#fff;line-height:1.6;margin-bottom:4px;}
  .fm-mgr-footer{font-size:10px;color:var(--fm-text-secondary);margin-top:12px;padding-top:8px;border-top:1px solid var(--fm-border);}
  .fm-mgr-mood-note{font-size:10.5px;color:var(--fm-text-secondary);margin-bottom:12px;}
  .fm-mgr-bars{display:flex;gap:8px;align-items:flex-end;}
  .fm-mgr-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;}
  .fm-mgr-bar-track{height:56px;width:100%;max-width:28px;display:flex;align-items:flex-end;}
  .fm-mgr-bar{width:100%;min-height:2px;border-radius:4px 4px 0 0;}
  .fm-mgr-bar-pct{font-size:10px;color:#fff;font-weight:700;}
  .fm-mgr-bar-label{font-size:9.5px;color:var(--fm-text-secondary);white-space:nowrap;}
  .fm-mgr-stackbar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--fm-border);}
  .fm-mgr-stackbar-seg{height:100%;}
  .fm-mgr-legend{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:8px;}
  .fm-mgr-legend-item{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--fm-text-secondary);white-space:nowrap;}
  .fm-mgr-legend-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}

  /* ---- 전체 설정 모달: 플로팅 버튼 클릭 시 그 자리에서 바로 열림 ---- */
  .fm-backdrop{
    position:fixed;inset:0;background:rgba(0,0,0,.55);
    z-index:2147483001;display:none;
  }
  .fm-backdrop.open{display:block;}

  .fm-modal{
    position:fixed;top:${STRIP_HEIGHT + 8}px;left:10px;width:300px;
    background:var(--fm-bg-elevated);border-radius:14px;box-shadow:0 20px 44px -14px rgba(0,0,0,.6);
    z-index:2147483002;display:none;overflow:hidden;
  }
  .fm-modal.open{display:block;}
  .fm-modal-head{padding:12px 14px;border-bottom:1px solid var(--fm-border);display:flex;align-items:center;justify-content:space-between;}
  .fm-modal-brand{font-size:13px;font-weight:800;color:#fff;}
  .fm-modal-brand span{color:var(--fm-accent);}
  .fm-modal-close{cursor:pointer;color:var(--fm-text-secondary);font-size:14px;}
  .fm-modal-iframe{width:100%;border:none;display:block;min-height:200px;}

  .fm-mode-toggle{display:flex;border:1px solid var(--fm-border);border-radius:100px;overflow:hidden;}
  .fm-mode-opt{flex:1;text-align:center;padding:8px 0;font-size:11.5px;font-weight:700;color:var(--fm-text-secondary);cursor:pointer;border-left:1px solid var(--fm-border);}
  .fm-mode-opt:first-child{border-left:none;}
  .fm-mode-opt.blur.active{background:var(--fm-warn-bg);color:var(--fm-warn);}
  .fm-mode-opt.block.active{background:var(--fm-danger-bg);color:var(--fm-danger);}

  /* ---- 온보딩 (최초 실행 시 채팅 자리를 덮는 전체 화면) ---- */
  .fm-onboard{
    position:fixed;inset:0;background:var(--fm-bg);z-index:2147483003;display:none;flex-direction:column; /* 최상단: 모달/스트립보다 위 */
  }
  .fm-onboard.show{display:flex;}
  .ob-step{display:none;flex-direction:column;flex:1;min-height:0;}
  .ob-step.active{display:flex;}
  .ob-country-list{flex:1;overflow-y:auto;padding:6px 20px 20px;}
  .ob-country-card{display:flex;align-items:center;gap:10px;padding:13px 12px;border:1px solid var(--fm-border);border-radius:12px;margin-bottom:8px;cursor:pointer;}
  .ob-country-card:active{background:var(--fm-bg-hover);}
  .ob-country-flag{font-size:20px;}
  .ob-country-label{font-size:13.5px;font-weight:700;color:#fff;}
  .ob-head{padding:22px 20px 4px;}
  .ob-badge{display:inline-flex;font-size:10.5px;font-weight:800;color:var(--fm-accent);background:var(--fm-accent-bg);padding:4px 10px;border-radius:100px;margin-bottom:12px;}
  .ob-head h2{font-size:17px;font-weight:800;margin:0 0 6px;color:#fff;line-height:1.4;}
  .ob-head p{font-size:12.5px;color:var(--fm-text-secondary);margin:0;line-height:1.6;}
  .ob-body{flex:1;overflow-y:auto;padding:14px 20px;}
  .ob-section-label{font-size:11.5px;font-weight:700;color:var(--fm-text-secondary);margin:14px 0 8px;}
  .ob-cat{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--fm-border);}
  .ob-cat-title{font-size:13px;font-weight:700;color:#fff;}
  .ob-cat-desc{font-size:10.5px;color:var(--fm-text-secondary);margin-top:1px;}
  .ob-switch{width:32px;height:19px;border-radius:100px;position:relative;cursor:pointer;flex-shrink:0;}
  .ob-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .12s;}
  .ob-switch.on{background:var(--fm-accent);}
  .ob-switch.on::after{transform:translateX(13px);}
  .ob-switch.off{background:#535353;}
  .ob-footer{padding:12px 20px 18px;border-top:1px solid var(--fm-border);display:flex;flex-direction:column;gap:8px;}
  .ob-cta{width:100%;padding:13px;border:none;border-radius:500px;background:var(--fm-accent);color:#000;font-size:13.5px;font-weight:800;cursor:pointer;}
  .ob-skip{text-align:center;font-size:11.5px;color:var(--fm-text-secondary);font-weight:600;cursor:pointer;text-decoration:underline;}
`;
