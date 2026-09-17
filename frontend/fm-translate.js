'use strict';

// ---- 번역 (수신: 외국어→내 언어 / 송신: 한국어→상대 언어) ----
// Chrome 내장 Translator / LanguageDetector API 사용 (서버 무관, 전부 브라우저에서 처리).
// 주의: 언어팩이 없으면 Translator.create()에 user activation(클릭 등)이 필요하다 —
// 그래서 warmupTranslators()는 반드시 클릭 핸들러 안에서 호출해야 다운로드가 허용된다.

const _trs = new Map(); // 'from>to' -> Translator 인스턴스(프로미스)

// onProgress(0~1): 언어팩 다운로드 진행률 콜백 (선택).
async function getTranslator(from, to, onProgress) {
  if (!('Translator' in self) || !from || !to || from === to) return null;
  const key = from + '>' + to;
  if (_trs.has(key)) return _trs.get(key);

  const p = (async () => {
    let avail = 'downloadable';
    try {
      avail = await Translator.availability({ sourceLanguage: from, targetLanguage: to });
    } catch (e) { /* 구현에 따라 없을 수 있음 */ }
    if (avail === 'unavailable') return null;
    try {
      return await Translator.create({
        sourceLanguage: from,
        targetLanguage: to,
        monitor(m) {
          if (!onProgress) return;
          m.addEventListener('downloadprogress', (e) => {
            try { onProgress(typeof e.loaded === 'number' ? e.loaded : 0); } catch (_) { }
          });
        }
      });
    } catch (e) {
      return null;
    }
  })();
  _trs.set(key, p);

  const r = await p;
  if (!r) {
    // unavailable 확정이면 캐시 유지(재시도 안 함), 그 외(제스처 없음/다운로드 실패)엔 삭제해 재시도 가능
    let avail = 'unavailable';
    try {
      avail = await Translator.availability({ sourceLanguage: from, targetLanguage: to });
    } catch (e) { }
    if (avail !== 'unavailable') _trs.delete(key);
  }
  return r;
}

// 지금까지 화면에서 감지된 언어들 + 흔한 언어의 팩을 미리 받아둔다.
// user activation(셀렉트 change / 버튼 클릭) 컨텍스트에서 호출해야 다운로드가 허용됨.
const WARMUP_LANGS = ['en', 'es', 'ja', 'pt', 'zh'];
function warmupTranslators(to, onProgress) {
  if (!to || !('Translator' in self)) return;
  const langs = new Set(WARMUP_LANGS);
  document.querySelectorAll('yt-live-chat-text-message-renderer').forEach((n) => {
    if (n.dataset.fmLang) langs.add(n.dataset.fmLang);
  });
  langs.forEach((from) => {
    if (from && from !== to) getTranslator(from, to, onProgress);
  });
}

// 감지 언어 코드 → 국기 이모지 (미매핑 언어는 2글자 코드로 폴백)
const LANG_FLAG = {
  en: '🇺🇸', ja: '🇯🇵', zh: '🇨🇳', es: '🇪🇸', pt: '🇵🇹', fr: '🇫🇷', de: '🇩🇪',
  ru: '🇷🇺', id: '🇮🇩', th: '🇹🇭', vi: '🇻🇳', ar: '🇸🇦', hi: '🇮🇳', tr: '🇹🇷',
  it: '🇮🇹', pl: '🇵🇱', nl: '🇳🇱', uk: '🇺🇦'
};
let _detector = null;
async function getDetector() {
  if (!('LanguageDetector' in self)) return null;
  if (!_detector) _detector = LanguageDetector.create().catch(() => null);
  return _detector;
}

// 언어 감지 공용 함수 — 수신([2]) 노드별 1회 감지 / 발신([3]) 입력창 실시간 감지 양쪽에서 재사용.
// 신뢰도 낮거나 너무 짧으면 무시(이모지/짧은 텍스트 오탐 방지) — 임계값은 기존 그대로.
async function detectLang(text) {
  if (!text || !text.trim()) return { lang: '', confident: false };
  const det = await getDetector();
  if (!det) return { lang: '', confident: false };
  try {
    const r = await det.detect(text);
    const top = r && r[0];
    if (top && top.confidence >= 0.5 && text.trim().length >= 3) {
      return { lang: (top.detectedLanguage || '').toLowerCase(), confident: true };
    }
  } catch (e) { }
  return { lang: '', confident: false };
}

// 언어 감지는 노드당 1회. 번역은 대상 언어(settings.translateRecvTo)별로 캐시.
// 화면 표시(원문+번역카드, 국기 배지)는 현재 대상 언어에 맞춰 그때그때 결정.
async function translateNode(node, messageEl, extraEl, text) {
  if (!settings) return;
  const to = settings.translateRecvTo || '';
  const seen = node.dataset.fmLang !== undefined;

  if (!to) { // 끄기 — 이전에 번역됐던 노드는 원문만 노출
    if (seen) applyTranslationDisplay(node, messageEl, extraEl);
    return;
  }
  if (!text.trim() || node.style.display === 'none') return;

  if (!node.dataset.fmOrigText) node.dataset.fmOrigText = text;

  // 언어 감지 (1회)
  if (!seen) {
    const { lang } = await detectLang(text);
    node.dataset.fmLang = lang;
  }
  const lang = node.dataset.fmLang || '';

  if (!lang || lang === to || node.dataset.fmTrSkip) { applyTranslationDisplay(node, messageEl, extraEl); return; }
  if (node.dataset.fmTrText && node.dataset.fmTrTo === to) { applyTranslationDisplay(node, messageEl, extraEl); return; }

  const tr = await getTranslator(lang, to);
  if (tr) {
    try {
      const src = node.dataset.fmOrigText || text;
      const out = await tr.translate(src);
      if (out && out.trim() && out !== src) {
        node.dataset.fmTrText = out;
        node.dataset.fmTrTo = to;
      }
    } catch (e) { }
  } else if (_trs.has(lang + '>' + to)) {
    node.dataset.fmTrSkip = '1'; // availability=unavailable 확정 → 재시도 안 함
  }
  // 성공 못 했으면 fmProcessed 안 남김 → 다음 reclassifyAllVisible에서 재시도(팩 다운로드 대기)
  applyTranslationDisplay(node, messageEl, extraEl);
}

function applyTranslationDisplay(node, messageEl, extraEl) {
  const to = (settings && settings.translateRecvTo) || '';
  const lang = node.dataset.fmLang || '';
  const trg = (node.dataset.fmTrTo === to) ? node.dataset.fmTrText : '';

  // author 옆 국기 배지 — 기존 로직 그대로 유지
  const authorEl = (node.shadowRoot || node).querySelector('#author-name');
  let flagBadge = authorEl && authorEl.querySelector('.fm-lang');
  if (to && lang && lang !== to && authorEl) {
    if (!flagBadge) {
      flagBadge = document.createElement('span');
      flagBadge.className = 'fm-lang';
      authorEl.appendChild(flagBadge);
    }
    flagBadge.textContent = LANG_FLAG[lang] || lang.toUpperCase();
    flagBadge.dataset.lang = lang;
  } else if (flagBadge) {
    flagBadge.remove();
  }

  // 번역카드 — 원문(messageEl.textContent)은 절대 건드리지 않고, 카드를 원문 아래에 추가/갱신
  let card = extraEl.querySelector('.fm-tr-card');
  if (!to || !trg) {
    if (card) card.remove();
    messageEl.style.display = '';
    delete node.dataset.fmTrView;
    return;
  }

  if (!card) {
    // #message/.fm-extra가 유튜브 커스텀 엘리먼트의 shadow root 안에 있을 수 있어
    // 라이트 DOM 스타일시트가 못 미칠 수 있다 — 모양은 inline style로 직접 지정.
    card = document.createElement('div');
    card.className = 'fm-tr-card';
    card.style.cssText = 'display:flex;align-items:flex-start;gap:6px;margin-top:4px;padding:6px 10px;' +
      'background:#181818;border-left:3px solid #1DB954;border-radius:0 8px 8px 0;font-size:12px;color:#fff;';
    card.innerHTML = '<span class="fm-tr-lang"></span><span class="fm-tr-text"></span><span class="fm-tr-toggle"></span>';
    card.querySelector('.fm-tr-lang').style.cssText =
      'flex:0 0 auto;font-size:10px;font-weight:700;color:#1DB954;background:rgba(29,185,84,.16);border-radius:100px;padding:2px 6px;';
    card.querySelector('.fm-tr-text').style.cssText = 'flex:1;line-height:1.4;';
    card.querySelector('.fm-tr-toggle').style.cssText =
      'flex:0 0 auto;font-size:10px;color:#B3B3B3;text-decoration:underline;cursor:pointer;white-space:nowrap;';
    extraEl.appendChild(card); // 필터 태그(있으면) 다음 줄
    card.querySelector('.fm-tr-toggle').addEventListener('click', () => {
      node.dataset.fmTrView = node.dataset.fmTrView === 'original' ? 'translated' : 'original';
      renderTrView(node, messageEl, card);
    });
  }
  card.querySelector('.fm-tr-lang').textContent = lang.toUpperCase();
  card.querySelector('.fm-tr-text').textContent = trg;
  renderTrView(node, messageEl, card);
}

// 기본 노출은 번역문, 토글 시 원문 — messageEl과 카드를 서로 배타적으로 표시
function renderTrView(node, messageEl, card) {
  const view = node.dataset.fmTrView || 'translated';
  const toggle = card.querySelector('.fm-tr-toggle');
  if (view === 'translated') {
    messageEl.style.display = 'none';
    card.style.display = '';
    toggle.textContent = '원문 보기';
  } else {
    messageEl.style.display = '';
    card.style.display = 'none';
    toggle.textContent = '번역문 보기';
  }
}

// ---- 송신 번역 (한국어 → 선택한 상대 언어로 변환 후 유튜브 채팅으로 전송, 단방향) ----
async function sendTranslated(text, srcLang, dstLang) {
  const src = (text || '').trim();
  if (!src) return;

  let out = src;
  if (dstLang && srcLang && dstLang !== srcLang) {
    const tr = await getTranslator(srcLang, dstLang);
    if (tr) {
      try { out = await tr.translate(src); } catch (e) { out = src; } // 실패 시 원문으로 폴백
    }
  }

  const input =
    document.querySelector('yt-live-chat-text-input-field-renderer #input') ||
    document.querySelector('#input.yt-live-chat-text-input-field-renderer');
  if (!input) return;

  input.focus();
  // execCommand 경로가 유튜브 웹컴포넌트(Polymer)의 내부 상태·전송버튼 활성화를 제대로 갱신함
  try { document.execCommand('selectAll', false, null); } catch (e) { }
  try { document.execCommand('insertText', false, out); } catch (e) { }
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: out, inputType: 'insertText' }));

  // 전송 버튼이 활성화될 틈을 준 뒤 클릭
  setTimeout(() => {
    const btn = document.querySelector('#send-button button, yt-live-chat-message-input-renderer #send-button button');
    if (btn && !btn.disabled) btn.click();
  }, 60);
}

function syncSendBar() {
  const bar = document.getElementById('fm-send-bar');
  if (!bar) return;
  // 받는 번역이 꺼져 있어도 송신 번역은 독립적으로 쓸 수 있게 함
  bar.style.display = ('Translator' in self) ? 'flex' : 'none';
}

let _sendBarTries = 0;
let _previewTimer = null;
let _previewSeq = 0;
const SEND_SRC_LANG = 'ko'; // 소스는 항상 한국어로 고정 (단방향)

function injectSendBar() {
  if (!('Translator' in self)) return;
  if (document.getElementById('fm-send-bar')) return;
  const panel = document.querySelector('yt-live-chat-message-input-renderer');
  if (!panel || !panel.parentNode) {
    if (_sendBarTries++ < 25) setTimeout(injectSendBar, 800); // 로그인 안 됨/채팅 종료 시 무한 재시도 방지
    return;
  }

  const bar = document.createElement('div');
  bar.id = 'fm-send-bar';
  bar.innerHTML =
    '<div id="fm-lang-pair">' +
    '<span class="fm-chip fm-chip-src">KO</span>' +
    '<span class="fm-arrow">→</span>' +
    '<span class="fm-chip fm-chip-dst" id="fmDstChip"><span class="fm-chip-code">EN</span><span class="fm-chip-caret">▾</span></span>' +
    '</div>' +
    '<div id="fm-send-row">' +
    '<input id="fm-send-input" type="text" autocomplete="off" placeholder="메시지를 입력하세요 (자동 번역 후 전송)" />' +
    '<button id="fm-send-btn" type="button">전송</button>' +
    '</div>' +
    '<div class="fm-tr-preview" id="fmTrPreview" style="display:none;"></div>';
  panel.parentNode.insertBefore(bar, panel);

  const dstChipCode = bar.querySelector('#fmDstChip .fm-chip-code');
  const dstChipEl = bar.querySelector('#fmDstChip');
  const inp = bar.querySelector('#fm-send-input');
  const btn = bar.querySelector('#fm-send-btn');
  const preview = bar.querySelector('#fmTrPreview');

  let dstLang = (settings && settings.translateSendTo) || 'en';
  dstChipCode.textContent = (LANG_META[dstLang] || {}).short || dstLang.toUpperCase();

  function setDst(code) {
    dstLang = code;
    dstChipCode.textContent = (LANG_META[code] || {}).short || code.toUpperCase();
    saveSettings({ translateSendTo: code });
    getTranslator(SEND_SRC_LANG, code); // 클릭 제스처 컨텍스트 → 언어팩 미리 받기
    schedulePreview(inp.value);
  }

  dstChipEl.addEventListener('click', () => {
    openLangSheet({ // fm-ui.js 공유 헬퍼 재사용
      title: '보낼 언어',
      codes: SEND_LANG_CODES,
      current: dstLang,
      triggerEl: dstChipEl,
      onSelect: (code) => { setDst(code); closeLangSheet(); }
    });
  });

  function schedulePreview(text) {
    clearTimeout(_previewTimer);
    if (!text.trim()) { preview.style.display = 'none'; return; }
    _previewTimer = setTimeout(() => runPreview(text), 400);
  }

  async function runPreview(text) {
    const seq = ++_previewSeq;
    if (dstLang === SEND_SRC_LANG) { // 원문 그대로 전송 — 번역 불필요(실패 아님)
      preview.style.display = '';
      preview.className = 'fm-tr-preview';
      preview.textContent = text;
      return;
    }
    preview.style.display = '';
    preview.className = 'fm-tr-preview loading';
    preview.textContent = '번역 중···';
    const tr = await getTranslator(SEND_SRC_LANG, dstLang);
    if (seq !== _previewSeq) return; // 늦게 도착한 응답 무시
    if (!tr) {
      preview.className = 'fm-tr-preview error';
      preview.textContent = '번역 실패, 원문으로 전송됩니다';
      return;
    }
    try {
      const out = await tr.translate(text);
      if (seq !== _previewSeq) return;
      preview.className = 'fm-tr-preview';
      preview.textContent = out;
    } catch (e) {
      if (seq !== _previewSeq) return;
      preview.className = 'fm-tr-preview error';
      preview.textContent = '번역 실패, 원문으로 전송됩니다';
    }
  }

  inp.addEventListener('input', () => schedulePreview(inp.value));

  const go = async () => {
    const v = inp.value;
    if (!v.trim()) return;
    inp.value = '';
    preview.style.display = 'none';
    inp.disabled = true; btn.disabled = true;
    try { await sendTranslated(v, SEND_SRC_LANG, dstLang); }
    finally { inp.disabled = false; btn.disabled = false; inp.focus(); }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); go(); }
  });
  btn.addEventListener('click', go);

  syncSendBar();
}
