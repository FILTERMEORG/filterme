/**
 * FILTERME - content.js
 * 유튜브 live_chat iframe에 직접 주입됩니다 (manifest.json matches 참고).
 * 채팅 DOM은 그대로 두고, 메시지 노드 자체에 블러/축약 처리를 인라인으로 적용합니다.
 *
 * ⚠️ 로컬 테스트용 데모입니다.
 * classify() 함수는 실제 AI 분류 백엔드가 없는 상태에서 확인해보기 위한
 * "키워드 기반 임시 분류기"입니다. 실제 제품에서는 이 함수만 백엔드 API 호출로 교체하면 됩니다.
 *
 * v0.3.0:
 * - 전체 설정 화면(My Chat/Filter/Settings)을 여기 따로 그리지 않고, popup.html을
 *   <iframe>으로 그대로 재사용합니다. 이제 설정 마크업은 popup.html 한 곳에만 존재합니다.
 * - 모달을 여는 버튼을 플로팅 로고 버튼(fmFab) 하나로 통일했습니다.
 *   (상단 스트립의 로고/톱니바퀴는 더 이상 클릭해도 아무 일도 일어나지 않습니다 — 톱니바퀴는 제거)
 */

(function () {
  'use strict';

  const STRIP_HEIGHT = 34; // fm-strip의 실제 높이(px). 레이아웃 보정에 사용됩니다.

  const DEFAULTS = {
    onboarded: false,
    filterEnabled: true,
    categories: { c02: true, c03: true, c04: true, c05: true },
    displayMode: 'blur' // 'blur' | 'block'
  };

  const CATEGORY_META = {
    c02: { label: '욕설 / 비속어', name: 'Profanity' },
    c03: { label: '정치 관련 대화', name: 'Political' },
    c04: { label: '성적 표현', name: 'Sexual' },
    c05: { label: '도배 / 반복', name: 'Spam' }
  };

  const BLUR_LABEL = {
    c02: '이 채팅은 욕설이 포함되어 있습니다.',
    c03: '이 채팅은 정치적 발언이 포함되어 있습니다.',
    c04: '이 채팅은 성적 표현이 포함되어 있습니다.',
    c05: '이 채팅은 도배로 분류되었습니다.'
  };

  // ---- 백엔드(WebSocket) 연동 ----
  const THRESHOLD = 70;
  const SCORE_TO_CAT = { profanity: 'c02', political: 'c03', sexual: 'c04', spam: 'c05' };
  const serverCat = new Map();
  const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
  function resultToCategory(r) {
    let best = null, top = THRESHOLD - 1;
    for (const [k, c] of Object.entries(SCORE_TO_CAT)) {
      const v = r[k] ?? 0;
      if (v >= THRESHOLD && v > top) { best = c; top = v; }
    }
    return best;
  }

  function classify(text) {
    const t = norm(text);
    if (!t) return null;
    if (serverCat.has(t)) return serverCat.get(t);
  }

  // ---- storage ----
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(DEFAULTS, (data) => resolve(data));
    });
  }
  function saveSettings(patch) {
    Object.assign(settings, patch);
    chrome.storage.local.set(patch);
  }

  let settings = null;

  loadSettings().then((data) => {
    settings = data;
    init();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !settings) return;
    Object.keys(changes).forEach((key) => {
      settings[key] = changes[key].newValue;
    });
    syncAllUI();
  });

  // ---- Shadow DOM UI 루트 ----
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
        <span class="fm-mark">F<span>M</span></span>
        <span class="fm-toggle" id="fmToggle"><span class="dot"></span>필터 ON</span>
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

    reclassifyAllVisible();
  }

  function wireEvents() {
    els.fmToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      saveSettings({ filterEnabled: !settings.filterEnabled });
      syncAllUI();
    });

    // 전체 설정 모달을 여는 진입점은 이 플로팅 버튼 하나뿐이다.
    els.fmFab.addEventListener('click', openModal);
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
      yt-live-chat-app, yt-live-chat-renderer, #chat, #chat-container {
        box-sizing: border-box !important;
        padding-top: ${STRIP_HEIGHT}px !important;
      }
    `;
    document.head.appendChild(style);
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
    const text = messageEl.textContent || '';
    const category = classify(text);

    // 이전 처리 흔적 제거 (표시 방식이 바뀌었을 때 재적용하기 위함)
    node.classList.remove('fm-blur', 'fm-blocked', 'fm-revealed');
    delete node.dataset.fmLabel;
    messageEl.style.filter = '';
    node.style.display = '';

    if (!settings.filterEnabled || !category || !settings.categories[category]) {
      return; // Normal이거나, 필터가 꺼져 있거나, 해당 카테고리가 OFF면 그대로 노출
    }

    if (settings.displayMode === 'blur') {
      node.classList.add('fm-blur');
      node.dataset.fmLabel = BLUR_LABEL[category] || '이 채팅은 필터되었습니다.';
      messageEl.style.filter = 'blur(4px)';
      node.style.cursor = 'pointer';
      node.onclick = () => node.classList.toggle('fm-revealed');
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

  function connectBackend() {
    let videoId = '';
    try { videoId = new URL(document.referrer).searchParams.get('v') || ''; } catch (e) {}
    let ws;
    const open = () => {
      ws = new WebSocket('ws://127.0.0.1:8000/ws');
      ws.onopen = () => {
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
        if (m.type !== 'analysis') return;
        serverCat.set(norm(m.text), resultToCategory(m.result));
        reclassifyAllVisible();
      };
      ws.onclose = () => setTimeout(open, 3000);
      ws.onerror = () => ws.close();
    };
    open();
  }

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
      yt-live-chat-text-message-renderer.fm-blur.fm-revealed #message { filter: none !important; }
    `;
    document.head.appendChild(s);
  }

  function init() {
    injectLabelStyle();
    buildUI();
    observeChat();
    connectBackend();
  }

  // ---- Shadow DOM 안에서 쓰는 스타일 ----
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }

    .fm-strip{
      position:fixed;top:0;left:0;right:0;height:${STRIP_HEIGHT}px;z-index:2147483000; /* base */
      display:flex;align-items:center;gap:8px;padding:0 10px;box-sizing:border-box;
      background:#FBFAFF;border-top:2px solid #5B4DFF;border-bottom:1px solid #F1EFFF;
    }
    .fm-strip.disabled{border-top-color:#D1D5DB;}
    .fm-mark{font-size:11px;font-weight:800;color:#111827;} /* 더 이상 클릭 대상이 아님(장식용 로고) */
    .fm-mark span{color:#5B4DFF;}
    .fm-toggle{display:flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:100px;cursor:pointer;}
    .fm-toggle.on{background:#ECFDF3;color:#16803C;}
    .fm-toggle.on .dot{background:#22C55E;}
    .fm-toggle.off{background:#F3F4F6;color:#6B7280;}
    .fm-toggle.off .dot{background:#9CA3AF;}
    .fm-toggle .dot{width:5px;height:5px;border-radius:50%;display:inline-block;}

    .fm-fab{
      position:fixed;right:16px;bottom:76px;width:42px;height:42px;border-radius:50%;
      background:#111827;color:#fff;display:flex;align-items:center;justify-content:center;
      font-size:11px;font-weight:800;cursor:pointer;box-shadow:0 6px 16px -4px rgba(17,24,39,.4);z-index:2147483000; /* base */
    }
    .fm-fab .m{color:#5B4DFF;}

    /* ---- 전체 설정 모달: 플로팅 버튼 클릭 시 그 자리에서 바로 열림 ---- */
    .fm-backdrop{
      position:fixed;inset:0;background:rgba(17,24,39,.18);
      z-index:2147483001;display:none;
    }
    .fm-backdrop.open{display:block;}

    .fm-modal{
      position:fixed;top:${STRIP_HEIGHT + 8}px;left:10px;width:300px;
      background:#fff;border-radius:14px;box-shadow:0 20px 44px -14px rgba(17,24,39,.35);
      z-index:2147483002;display:none;overflow:hidden;
    }
    .fm-modal.open{display:block;}
    .fm-modal-head{padding:12px 14px;border-bottom:1px solid #E5E7EB;display:flex;align-items:center;justify-content:space-between;}
    .fm-modal-brand{font-size:13px;font-weight:800;color:#111827;}
    .fm-modal-brand span{color:#5B4DFF;}
    .fm-modal-close{cursor:pointer;color:#6B7280;font-size:14px;}
    .fm-modal-iframe{width:100%;border:none;display:block;min-height:200px;}

    .fm-mode-toggle{display:flex;border:1px solid #E5E7EB;border-radius:9px;overflow:hidden;}
    .fm-mode-opt{flex:1;text-align:center;padding:8px 0;font-size:11.5px;font-weight:700;color:#6B7280;cursor:pointer;border-left:1px solid #E5E7EB;}
    .fm-mode-opt:first-child{border-left:none;}
    .fm-mode-opt.blur.active{background:#FFFBEB;color:#B45309;}
    .fm-mode-opt.block.active{background:#FEF2F2;color:#B91C1C;}

    /* ---- 온보딩 (최초 실행 시 채팅 자리를 덮는 전체 화면) ---- */
    .fm-onboard{
      position:fixed;inset:0;background:#fff;z-index:2147483003;display:none;flex-direction:column; /* 최상단: 모달/스트립보다 위 */
    }
    .fm-onboard.show{display:flex;}
    .ob-head{padding:22px 20px 4px;}
    .ob-badge{display:inline-flex;font-size:10.5px;font-weight:800;color:#5B4DFF;background:#F1EFFF;padding:4px 10px;border-radius:100px;margin-bottom:12px;}
    .ob-head h2{font-size:17px;font-weight:800;margin:0 0 6px;color:#111827;line-height:1.4;}
    .ob-head p{font-size:12.5px;color:#6B7280;margin:0;line-height:1.6;}
    .ob-body{flex:1;overflow-y:auto;padding:14px 20px;}
    .ob-section-label{font-size:11.5px;font-weight:700;color:#6B7280;margin:14px 0 8px;}
    .ob-cat{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #E5E7EB;}
    .ob-cat-title{font-size:13px;font-weight:700;color:#111827;}
    .ob-cat-desc{font-size:10.5px;color:#6B7280;margin-top:1px;}
    .ob-switch{width:32px;height:19px;border-radius:100px;position:relative;cursor:pointer;flex-shrink:0;}
    .ob-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .12s;}
    .ob-switch.on{background:#5B4DFF;}
    .ob-switch.on::after{transform:translateX(13px);}
    .ob-switch.off{background:#E5E7EB;}
    .ob-footer{padding:12px 20px 18px;border-top:1px solid #E5E7EB;display:flex;flex-direction:column;gap:8px;}
    .ob-cta{width:100%;padding:13px;border:none;border-radius:10px;background:#5B4DFF;color:#fff;font-size:13.5px;font-weight:800;cursor:pointer;}
    .ob-skip{text-align:center;font-size:11.5px;color:#6B7280;font-weight:600;cursor:pointer;text-decoration:underline;}
  `;
})();
