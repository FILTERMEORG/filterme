'use strict';

// ---- 공유 상수/상태 ----
// FM 계열 파일들이 공통으로 쓰는 값들. manifest.json 의 로드 순서상 가장 먼저 실행된다.
// (모든 fm-*.js + content.js 는 같은 실행 컨텍스트에 순서대로 주입되므로,
//  여기서 선언한 const/let/function 은 이후 파일에서 이름 그대로 보인다.)

const STRIP_HEIGHT = 34; // fm-strip의 실제 높이(px). 레이아웃 보정에 사용됩니다.

// 서버(AI 필터) WebSocket 주소. 배포 후 'wss://<도메인>/ws' 로 교체.
const SERVER_WS = 'wss://filterme.onrender.com/ws';

const DEFAULTS = {
  translateRecvTo: '', // '' = 끄기, 아니면 'ko'|'en'|'ja'|'zh'|'es'|'ru'
  translateSendTo: 'en', // 송신 번역 대상 언어
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
