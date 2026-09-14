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

// 언어 감지는 노드당 1회. 번역은 대상 언어(settings.translateRecvTo)별로 캐시.
// 화면 표시(원문 ↔ 번역문 교체, 국기 배지)는 현재 대상 언어에 맞춰 그때그때 결정.
async function translateNode(node, messageEl, text) {
  if (!settings) return;
  const to = settings.translateRecvTo || '';
  const seen = node.dataset.fmLang !== undefined;

  if (!to) { // 끄기 — 이전에 번역됐던 노드는 원문 복구
    if (seen) applyTranslationDisplay(node, messageEl);
    return;
  }
  if (!text.trim() || node.style.display === 'none') return;

  if (!node.dataset.fmOrigText) node.dataset.fmOrigText = text;

  // 언어 감지 (1회) — 신뢰도 낮거나 너무 짧으면 무시 (이모지/짧은 텍스트 오탐 방지)
  if (!seen) {
    let lang = '';
    const det = await getDetector();
    if (det) {
      try {
        const r = await det.detect(text);
        const top = r && r[0];
        if (top && top.confidence >= 0.5 && text.trim().length >= 3) {
          lang = (top.detectedLanguage || '').toLowerCase();
        }
      } catch (e) { }
    }
    node.dataset.fmLang = lang;
  }
  const lang = node.dataset.fmLang || '';

  if (!lang || lang === to || node.dataset.fmTrSkip) { applyTranslationDisplay(node, messageEl); return; }
  if (node.dataset.fmTrText && node.dataset.fmTrTo === to) { applyTranslationDisplay(node, messageEl); return; }

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
  applyTranslationDisplay(node, messageEl);
}

function applyTranslationDisplay(node, messageEl) {
  const to = (settings && settings.translateRecvTo) || '';
  const lang = node.dataset.fmLang || '';
  const orig = node.dataset.fmOrigText;
  const trg = (node.dataset.fmTrTo === to) ? node.dataset.fmTrText : '';

  const authorEl = (node.shadowRoot || node).querySelector('#author-name');
  let badge = authorEl && authorEl.querySelector('.fm-lang');
  if (to && lang && lang !== to && authorEl) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'fm-lang';
      authorEl.appendChild(badge);
    }
    badge.textContent = LANG_FLAG[lang] || lang.toUpperCase();
    badge.dataset.lang = lang;
  } else if (badge) {
    badge.remove();
  }

  if (trg) {
    if (messageEl.textContent !== trg) messageEl.textContent = trg;
  } else if (orig != null && messageEl.textContent !== orig) {
    messageEl.textContent = orig;
  }
}

// ---- 송신 번역 (내가 쓴 한국어 → 대상 언어로 변환 후 유튜브 채팅으로 전송) ----
async function sendTranslated(koText) {
  const src = (koText || '').trim();
  if (!src) return;

  const to = (settings && settings.translateSendTo) || 'en';
  let out = src;
  if (to !== 'ko') {
    const tr = await getTranslator('ko', to);
    if (tr) {
      try { out = await tr.translate(src); } catch (e) { out = src; }
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
  const sel = document.getElementById('fm-send-lang');
  if (sel && settings) sel.value = settings.translateSendTo || 'en';
}

let _sendBarTries = 0;
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
    '<select id="fm-send-lang" title="보낼 언어">' +
    '<option value="en">EN</option><option value="ja">JA</option>' +
    '<option value="zh">ZH</option><option value="es">ES</option>' +
    '<option value="ru">RU</option>' +
    '</select>' +
    '<input id="fm-send-input" type="text" autocomplete="off" ' +
    'placeholder="한국어로 입력 → 번역해서 전송 (Enter)" />' +
    '<button id="fm-send-btn" type="button">번역 전송</button>';
  panel.parentNode.insertBefore(bar, panel);

  const sel = bar.querySelector('#fm-send-lang');
  const inp = bar.querySelector('#fm-send-input');
  const btn = bar.querySelector('#fm-send-btn');
  sel.addEventListener('change', () => {
    saveSettings({ translateSendTo: sel.value });
    getTranslator('ko', sel.value); // 이 change 도 제스처 → 팩 미리 받기
  });
  const go = async () => {
    const v = inp.value;
    if (!v.trim()) return;
    inp.value = '';
    inp.disabled = true; btn.disabled = true;
    try { await sendTranslated(v); }
    finally { inp.disabled = false; btn.disabled = false; inp.focus(); }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(); }
  });
  btn.addEventListener('click', go);

  syncSendBar();
}
