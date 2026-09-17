'use strict';

// ---- 공유 상수/상태 ----
// FM 계열 파일들이 공통으로 쓰는 값들. manifest.json 의 로드 순서상 가장 먼저 실행된다.
// (모든 fm-*.js + content.js 는 같은 실행 컨텍스트에 순서대로 주입되므로,
//  여기서 선언한 const/let/function 은 이후 파일에서 이름 그대로 보인다.)

const STRIP_HEIGHT = 34; // fm-strip의 실제 높이(px). 레이아웃 보정에 사용됩니다.

// 서버(AI 필터) WebSocket 주소. 배포 후 'wss://<도메인>/ws' 로 교체.
const SERVER_WS = 'wss://filterme.onrender.com/ws';

const DEFAULTS = {
  country: '', // '' = 아직 선택 안 함. 'KR'|'US'|'JP'|'CN'|'ES'|'RU'
  uiLang: 'ko', // country로부터 파생되는 UI 언어. country 선택 전엔 'ko' 폴백
  translateRecvTo: '', // '' = 끄기, 아니면 'ko'|'en'|'ja'|'zh'|'es'|'ru'
  translateSendTo: 'en', // 송신 번역 대상 언어
  onboarded: false,
  filterEnabled: true,
  categories: { c02: true, c03: true, c04: true, c05: true },
  displayMode: 'blur' // 'blur' | 'block'
};

// 국가 선택(온보딩 0단계 / Settings 재선택) 공용 메타데이터
const COUNTRY_META = {
  KR: { lang: 'ko', flag: '🇰🇷', label: '대한민국' },
  US: { lang: 'en', flag: '🇺🇸', label: 'United States' },
  JP: { lang: 'ja', flag: '🇯🇵', label: '日本' },
  CN: { lang: 'zh', flag: '🇨🇳', label: '中国' },
  ES: { lang: 'es', flag: '🇪🇸', label: 'España' },
  RU: { lang: 'ru', flag: '🇷🇺', label: 'Россия' }
};

// 국가 선택 시 UI 언어 + 송신 번역 기본 언어를 한 번에 저장 (최초 온보딩/Settings 재선택 공용)
// 전체 번역(translateRecvTo)이 이미 켜져 있는 상태였다면, 꺼진 채 새로 켜기를 기다리게 하는 대신
// 그 값도 함께 새 국가 언어로 갱신해서 켜진 채로 바로 새 언어로 번역되게 한다.
//
// 송신 번역 기본 대상은 국가와 무관하게 항상 영어로 통일한다 — 영어가 한국 시청자에게도
// 널리 통용되는 다리 언어라서다. (uiLang이 이미 영어인 미국의 경우, 원문=영어=대상이라
// "내 언어를 내 언어로 번역"하는 셈이 되어 자동으로 번역 없이 원문 그대로 전송된다 — 정상 동작.)
// 이후 사용자는 언제든 송신 언어 칩을 눌러 다른 언어로 바꿀 수 있다(기존 동작 유지).
function applyCountry(code) {
  const meta = COUNTRY_META[code];
  if (!meta) return;
  const patch = { country: code, uiLang: meta.lang, translateSendTo: 'en' };
  if (settings && settings.translateRecvTo) patch.translateRecvTo = meta.lang;
  saveSettings(patch);
}

// 카테고리 표시명은 t()로 조회(다국어), name은 온보딩 카드의 고정 영문 서브라벨
const CATEGORY_META = {
  c02: { name: 'Profanity' },
  c03: { name: 'Political' },
  c04: { name: 'Sexual' },
  c05: { name: 'Spam' }
};
const CATEGORY_I18N_KEY = { c02: 'cat_profanity', c03: 'cat_political', c04: 'cat_sexual', c05: 'cat_spam' };
function catLabel(cat) { return t(CATEGORY_I18N_KEY[cat]); }

const BLUR_I18N_KEY = { c02: 'blur_profanity', c03: 'blur_political', c04: 'blur_sexual', c05: 'blur_spam' };
function blurLabel(cat) { return t(BLUR_I18N_KEY[cat]); }

// 번역 관련 기능([2] 채팅 번역카드 / [3] 입력창 상대 언어)이 공유하는 언어 메타데이터
const LANG_META = {
  '': { short: 'KO', label: '한국어 (원문 그대로)' },
  ko: { short: 'KO', label: '한국어' },
  en: { short: 'EN', label: 'English' },
  ja: { short: 'JA', label: '日本語' },
  zh: { short: 'ZH', label: '中文' },
  es: { short: 'ES', label: 'Español' },
  ru: { short: 'RU', label: 'Русский' }
};
// [3] 입력창 상대 언어(번역 대상) 목록 — 'ko'는 번역 없이 원문 그대로 전송(되돌리기용)
const SEND_LANG_CODES = ['ko', 'en', 'ja', 'zh', 'es', 'ru'];

// 채팅 텍스트 비교용 정규화(공백 정리). fm-filter.js classify(), fm-socket.js connectBackend() 양쪽에서 씀.
const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');

// ---- 설정 저장/로드 (chrome.storage.local) ----
// settings 는 이 파일에서 선언만 하고, 실제 값 채우기(로드)와 init() 호출은
// content.js(진입점)의 부트스트랩 코드가 한다.
let settings = null;

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (data) => resolve(data));
  });
}
function saveSettings(patch) {
  Object.assign(settings, patch);
  chrome.storage.local.set(patch);
}
