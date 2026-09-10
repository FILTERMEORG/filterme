const DEFAULTS = {
  onboarded: false,
  filterEnabled: true,
  categories: { c02: true, c03: true, c04: true, c05: true },
  displayMode: 'blur'
};

let settings = { ...DEFAULTS };

function $(id) { return document.getElementById(id); }

// 팝업이 "안 뜨는 것처럼" 보이는 가장 흔한 원인은 어딘가에서 조용히 던져진 JS 에러입니다.
// 에러가 나도 화면에 원인이 보이도록 배너를 띄웁니다.
function showFatalError(message) {
  let banner = $('fmErrorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fmErrorBanner';
    banner.style.cssText =
      'margin:10px 14px;padding:10px 12px;background:rgba(233,20,41,.16);color:#FF6B81;' +
      'font-size:11.5px;line-height:1.5;border-radius:8px;border:1px solid rgba(233,20,41,.4);';
    document.body.insertBefore(banner, document.body.firstChild.nextSibling);
  }
  banner.textContent = '⚠️ 팝업 로드 중 오류: ' + message + ' (우클릭 → 검사로 콘솔 확인)';
}

window.addEventListener('error', (e) => showFatalError(e.message));

// content.js의 인페이지 모달 안에 <iframe>으로 열렸을 때만 동작한다.
// 툴바 아이콘으로 열린 "진짜" 팝업일 때는 window.parent === window라 아무 일도 안 한다.
function reportHeightToParent() {
  if (window.parent === window) return;
  try {
    window.parent.postMessage({ source: 'filterme-popup', height: document.body.scrollHeight }, '*');
  } catch (e) {
    /* 무시 */
  }
}
if (window.parent !== window && 'ResizeObserver' in window) {
  new ResizeObserver(reportHeightToParent).observe(document.body);
}

function render() {
  try {
    // My Chat 탭
    const chip = $('chipFilterState');
    if (chip) {
      chip.classList.toggle('off', !settings.filterEnabled);
      chip.innerHTML = `<span class="d"></span>AI 필터 ${settings.filterEnabled ? 'ON' : 'OFF'}`;
    }

    document.querySelectorAll('.mode-opt').forEach((o) => {
      o.classList.toggle('active', o.dataset.mode === settings.displayMode);
    });

    // Filter 탭
    document.querySelectorAll('.mini-switch[data-cat]').forEach((sw) => {
      const cat = sw.dataset.cat;
      const on = !!(settings.categories && settings.categories[cat]);
      sw.classList.toggle('on', on);
      sw.classList.toggle('off', !on);
    });

    // Settings 탭
    const fe = $('filterEnabledSwitch');
    if (fe) {
      fe.classList.toggle('on', settings.filterEnabled);
      fe.classList.toggle('off', !settings.filterEnabled);
    }
  } catch (err) {
    showFatalError(err.message);
  }

}

function save(patch) {
  Object.assign(settings, patch);
  try {
    chrome.storage.local.set(patch);
  } catch (err) {
    showFatalError(err.message);
  }
  render();
}

try {
  if (!chrome || !chrome.storage) {
    showFatalError('chrome.storage API를 사용할 수 없습니다 (manifest permissions 확인 필요)');
  } else {
    chrome.storage.local.get(DEFAULTS, (data) => {
      if (chrome.runtime.lastError) {
        showFatalError(chrome.runtime.lastError.message);
        return;
      }
      settings = data;
      render();
      reportHeightToParent();
    });
  }
} catch (err) {
  showFatalError(err.message);
}

// 탭 전환
document.querySelectorAll('.tp-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tp-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tp-panel').forEach((p) => p.classList.toggle('active', p.id === 'tp-' + tab.dataset.tp));
    reportHeightToParent();
  });
});

// 블러/차단
document.querySelectorAll('.mode-opt').forEach((opt) => {
  opt.addEventListener('click', () => save({ displayMode: opt.dataset.mode }));
});

// 카테고리 On/Off
document.querySelectorAll('.mini-switch[data-cat]').forEach((sw) => {
  sw.addEventListener('click', () => {
    const cat = sw.dataset.cat;
    const next = { ...settings.categories, [cat]: !settings.categories[cat] };
    save({ categories: next });
  });
});

// 필터 전체 On/Off (Settings 탭 스위치)
const filterEnabledSwitchEl = $('filterEnabledSwitch');
if (filterEnabledSwitchEl) {
  filterEnabledSwitchEl.addEventListener('click', () => {
    save({ filterEnabled: !settings.filterEnabled });
  });
}

// 온보딩 다시 보기 (테스트 편의용)
const resetOnboardEl = $('resetOnboard');
if (resetOnboardEl) {
  resetOnboardEl.addEventListener('click', () => {
    save({ onboarded: false });
    if (window.parent !== window) {
      // content.js의 인페이지 모달 안에 있을 때는 window.close()가 아무 효과가 없으므로
      // 부모(content.js)에게 모달을 닫아달라고 요청한다.
      window.parent.postMessage({ source: 'filterme-popup', action: 'close' }, '*');
    } else {
      window.close();
    }
  });
}
