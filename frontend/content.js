/**
 * FILTERME - content.js
 * 유튜브 live_chat iframe에 직접 주입됩니다 (manifest.json matches 참고).
 * 채팅 DOM은 그대로 두고, 메시지 노드 자체에 블러/축약 처리를 인라인으로 적용합니다.
 *
 * 이 파일은 진입점(entry point)입니다. 실제 로직은 fm-*.js 여러 파일로 나뉘어 있고,
 * manifest.json 의 content_scripts.js 배열 순서
 * (fm-core → fm-filter → fm-translate → fm-socket → fm-ui → content.js)
 * 로 같은 실행 컨텍스트에 주입되어, 서로 다른 파일에 있어도 최상위 함수/변수를
 * 이름 그대로 참조할 수 있습니다(전역 스코프 공유. 별도 네임스페이스 객체 없음).
 * 전체 구조는 frontend/ARCHITECTURE.md 참고.
 *
 * v0.3.0:
 * - 전체 설정 화면(My Chat/Filter/Settings)을 여기 따로 그리지 않고, popup.html을
 *   <iframe>으로 그대로 재사용합니다. 이제 설정 마크업은 popup.html 한 곳에만 존재합니다.
 * - 모달을 여는 버튼을 플로팅 로고 버튼(fmFab) 하나로 통일했습니다.
 *   (상단 스트립의 로고/톱니바퀴는 더 이상 클릭해도 아무 일도 일어나지 않습니다 — 톱니바퀴는 제거)
 */
'use strict';

// ---- 부트스트랩: 설정을 로드한 뒤 UI/필터/번역/소켓을 초기화 ----
loadSettings().then((data) => {
  settings = data;
  init();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !settings) return;
  Object.keys(changes).forEach((key) => {
    settings[key] = changes[key].newValue;
  });
  // 수신 번역 대상 언어가 바뀌면 기존 번역 캐시 폐기 (언어 재감지는 불필요)
  if (changes.translateRecvTo) {
    document.querySelectorAll('yt-live-chat-text-message-renderer').forEach((n) => {
      delete n.dataset.fmTrText;
      delete n.dataset.fmTrTo;
      delete n.dataset.fmTrSkip;
    });
  }
  syncAllUI();
});

function init() {
  injectLabelStyle();  // fm-ui.js
  buildUI();           // fm-ui.js
  observeChat();       // fm-filter.js
  connectBackend();    // fm-socket.js
  injectSendBar();     // fm-translate.js
}
