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
      <span class="fm-toggle" id="fmToggle"><span class="dot"></span>필터 ON</span>
      <span class="fm-conn-txt" id="fmConnTxt"></span>
      <span class="fm-sel-wrap">
        <select class="fm-sel" id="fmRecvLang" title="받는 채팅 번역">
          <option value="">번역 끄기</option>
          <option value="ko">한국어로</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="zh">中文</option>
          <option value="es">Español</option>
          <option value="ru">Русский</option>
        </select>
        <span class="fm-tr-status" id="fmTrStatus"></span>
      </span>
    </div>

    <div class="fm-fab" id="fmFab" style="pointer-events:auto;" title="전체 설정 열기">F<span class="m">M</span></div>

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
      <div class="ob-head">
        <span class="ob-badge">✨ 처음 실행하셨네요</span>
        <h2>어떤 채팅을 걸러낼지<br>먼저 정해주세요</h2>
        <p>채팅을 보여드리기 전에, 걸러낼 항목을 먼저 골라주세요. 언제든 다시 바꿀 수 있어요.</p>
      </div>
      <div class="ob-body" id="obBody"></div>
      <div class="ob-footer">
        <button class="ob-cta" id="obApply">적용하고 채팅 보기</button>
        <span class="ob-skip" id="obSkip">기본값으로 시작할게요</span>
      </div>
    </div>
  `;

  els = {
    fmStrip: shadowRoot.getElementById('fmStrip'),
    fmToggle: shadowRoot.getElementById('fmToggle'),
    fmConnDot: shadowRoot.getElementById('fmConnDot'),
    fmConnTxt: shadowRoot.getElementById('fmConnTxt'),
    fmRecvLang: shadowRoot.getElementById('fmRecvLang'),
    fmTrStatus: shadowRoot.getElementById('fmTrStatus'),
    fmFab: shadowRoot.getElementById('fmFab'),
    fmBackdrop: shadowRoot.getElementById('fmBackdrop'),
    fmModal: shadowRoot.getElementById('fmModal'),
    fmModalClose: shadowRoot.getElementById('fmModalClose'),
    fmModalFrame: shadowRoot.getElementById('fmModalFrame'),
    fmOnboard: shadowRoot.getElementById('fmOnboard'),
    obBody: shadowRoot.getElementById('obBody'),
    obApply: shadowRoot.getElementById('obApply'),
    obSkip: shadowRoot.getElementById('obSkip')
  };

  // popup.html을 그대로 불러온다. chrome.runtime.getURL은 content script에서도 사용 가능.
  els.fmModalFrame.src = chrome.runtime.getURL('popup.html');

  renderOnboardCategories();
  wireEvents();
  syncAllUI();

  if (!settings.onboarded) {
    els.fmOnboard.classList.add('show');
  }
}

// ---- 전체 설정 모달 (플로팅 로고 버튼 클릭 시 그 자리에서 바로 열림) ----
function openModal() {
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
    closeModal();
    els.fmOnboard.classList.add('show');
  }
});

// ---- 온보딩 화면 ----
function renderOnboardCategories() {
  els.obBody.innerHTML =
    Object.entries(CATEGORY_META)
      .map(
        ([key, meta]) => `
      <div class="ob-cat">
        <div><div class="ob-cat-title">${meta.label}</div><div class="ob-cat-desc">${meta.name}</div></div>
        <div class="ob-switch" data-cat="${key}"></div>
      </div>`
      )
      .join('') +
    `<div class="ob-section-label">걸러낸 메시지는 어떻게 보여줄까요</div>
     <div class="fm-mode-toggle" id="obModeToggle">
        <div class="fm-mode-opt blur" data-mode="blur">블러 처리</div>
        <div class="fm-mode-opt block" data-mode="block">완전 차단</div>
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

  els.fmToggle.classList.toggle('on', settings.filterEnabled);
  els.fmToggle.classList.toggle('off', !settings.filterEnabled);
  els.fmToggle.innerHTML = `<span class="dot"></span>${settings.filterEnabled ? '필터 ON' : '필터 OFF'}`;
  els.fmStrip.classList.toggle('disabled', !settings.filterEnabled);

  els.obBody.querySelectorAll('.ob-switch[data-cat]').forEach((sw) => {
    const on = !!settings.categories[sw.dataset.cat];
    sw.classList.toggle('on', on);
    sw.classList.toggle('off', !on);
  });
  shadowRoot.querySelectorAll('#obModeToggle .fm-mode-opt').forEach((o) => {
    o.classList.toggle('active', o.dataset.mode === settings.displayMode);
  });

  if (els.fmRecvLang) els.fmRecvLang.value = settings.translateRecvTo || '';

  syncSendBar();
  reclassifyAllVisible();
}

// 언어팩 다운로드 진행률을 스트립에 표시
function showTrStatus(loaded) {
  if (!els.fmTrStatus) return;
  if (loaded >= 1) { els.fmTrStatus.textContent = ''; return; }
  els.fmTrStatus.textContent = `언어팩 ${Math.round((loaded || 0) * 100)}%`;
}

function wireEvents() {
  els.fmToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    saveSettings({ filterEnabled: !settings.filterEnabled });
    syncAllUI();
    warmupTranslators(settings.translateRecvTo, showTrStatus); // 제스처 보강
  });

  // 받는 채팅 번역 언어 선택 — 이 change 가 user activation → 언어팩 다운로드 허용
  if (els.fmRecvLang) {
    els.fmRecvLang.addEventListener('change', () => {
      const to = els.fmRecvLang.value;
      saveSettings({ translateRecvTo: to });
      if (els.fmTrStatus) els.fmTrStatus.textContent = '';
      warmupTranslators(to, showTrStatus);
      syncAllUI();
    });
  }

  // 전체 설정 모달을 여는 진입점은 이 플로팅 버튼 하나뿐이다.
  els.fmFab.addEventListener('click', () => {
    openModal();
    warmupTranslators(settings.translateRecvTo, showTrStatus); // 제스처 보강
  });
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
    #fm-send-bar { display: none; gap: 6px; padding: 6px 10px; background: #0f0f0f; border-top: 1px solid #2a2a2a; align-items: center; }
    #fm-send-lang { flex: 0 0 auto; background: #222; border: 1px solid #333; border-radius: 8px; color: #fff; padding: 5px 4px; font-size: 11px; outline: none; }
    #fm-send-input { flex: 1; min-width: 0; background: #222; border: 1px solid #333; border-radius: 100px; color: #fff; padding: 6px 12px; font-size: 12px; outline: none; }
    #fm-send-input::placeholder { color: #888; }
    #fm-send-input:disabled { opacity: 0.5; }
    #fm-send-btn { background: #1DB954; color: #000; border: none; border-radius: 100px; padding: 6px 14px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
    #fm-send-btn:disabled { opacity: 0.5; cursor: default; }
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

  .fm-sel-wrap{display:flex;align-items:center;gap:6px;margin-left:auto;}
  .fm-sel{
    background:var(--fm-bg-hover);color:#fff;border:1px solid var(--fm-border);
    border-radius:100px;font-size:10.5px;font-weight:700;padding:3px 6px;cursor:pointer;outline:none;
  }
  .fm-tr-status{font-size:9.5px;color:var(--fm-text-secondary);white-space:nowrap;}

  .fm-fab{
    position:fixed;right:16px;bottom:145px;width:42px;height:42px;border-radius:50%;
    background:#000;color:#fff;display:flex;align-items:center;justify-content:center;
    font-size:11px;font-weight:800;cursor:pointer;box-shadow:0 6px 16px -4px rgba(0,0,0,.6);z-index:2147483000; /* base */
  }
  .fm-fab .m{color:var(--fm-accent);}

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
