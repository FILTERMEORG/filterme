/**
 * VS Code / 브라우저에서 확장 프로그램 없이 UI만 미리보기 위한 chrome.* API 가짜 구현체.
 * 실제 chrome.storage.local과 동작을 최대한 비슷하게 흉내 냅니다.
 *
 * localStorage를 저장소로 쓰기 때문에, index.html(팝업 미리보기)과 mock-chat.html(채팅 미리보기,
 * iframe으로 로드됨)이 서로 다른 브라우징 컨텍스트여도 네이티브 'storage' 이벤트를 통해
 * 실시간으로 동기화됩니다 — 실제 chrome.storage.onChanged가 여러 컨텍스트에 전파되는 것과
 * 비슷한 경험을 줍니다.
 *
 * ⚠️ file:// 로 직접 열면 브라우저에 따라 origin이 "null"로 처리되어 storage 이벤트가
 * 안 나눠질 수 있습니다. 꼭 VS Code Live Server 같은 로컬 서버(http://localhost)로 여세요.
 */
(function () {
  const NS = 'filterme_dev_';
  const listeners = [];

  function readAll() {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(NS) === 0) {
        try {
          result[key.slice(NS.length)] = JSON.parse(localStorage.getItem(key));
        } catch (e) {
          /* 무시 */
        }
      }
    }
    return result;
  }

  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.runtime.lastError = null;
  // 실제로는 chrome-extension://<id>/popup.html 같은 절대 URL을 반환하지만,
  // 이 미리보기 환경에서는 그냥 상대 경로로 대체한다.
  // (mock-chat.html이 dev/ 폴더 안에 있고 popup.html은 그 한 단계 위에 있으므로 '../' 접두사 사용)
  window.chrome.runtime.getURL = window.chrome.runtime.getURL || function (path) {
    // popup.html은 이 미리보기 환경에서 chrome-mock.js가 먼저 로드되도록 감싸놓은
    // popup-embed.html로 대신 연결한다 (실제 확장 프로그램에선 필요 없는 우회로).
    if (path === 'popup.html') return 'popup-embed.html';
    return '../' + path;
  };
  window.chrome.storage = {
    local: {
      get(keysOrDefaults, callback) {
        const all = readAll();
        let result = {};
        if (Array.isArray(keysOrDefaults)) {
          keysOrDefaults.forEach((k) => {
            result[k] = all[k];
          });
        } else if (keysOrDefaults && typeof keysOrDefaults === 'object') {
          Object.keys(keysOrDefaults).forEach((k) => {
            result[k] = k in all ? all[k] : keysOrDefaults[k];
          });
        } else if (typeof keysOrDefaults === 'string') {
          result[keysOrDefaults] = all[keysOrDefaults];
        } else {
          result = all;
        }
        setTimeout(() => callback(result), 0);
      },
      set(patch, callback) {
        const all = readAll();
        const changes = {};
        Object.keys(patch).forEach((k) => {
          changes[k] = { oldValue: all[k], newValue: patch[k] };
          localStorage.setItem(NS + k, JSON.stringify(patch[k]));
        });
        setTimeout(() => {
          listeners.forEach((fn) => fn(changes, 'local'));
          if (callback) callback();
        }, 0);
      }
    },
    onChanged: {
      addListener(fn) {
        listeners.push(fn);
      }
    }
  };

  // 다른 창/iframe(같은 origin)에서 localStorage가 바뀌면 여기서도 감지해서 알려줌
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key.indexOf(NS) !== 0) return;
    const key = e.key.slice(NS.length);
    let newValue;
    try {
      newValue = JSON.parse(e.newValue);
    } catch (err) {
      newValue = e.newValue;
    }
    const changes = {};
    changes[key] = { newValue };
    listeners.forEach((fn) => fn(changes, 'local'));
  });

  window.__filtermeDevReset = function () {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.indexOf(NS) === 0) localStorage.removeItem(key);
    }
  };

  console.log(
    '%c[FILTERME dev mock] chrome.storage 준비됨 (localStorage 기반)',
    'color:#5B4DFF;font-weight:bold;'
  );
})();
