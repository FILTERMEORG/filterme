# 확장(Extension) 구조

## 파일이 여러 개인 이유

`content.js` 하나에 필터·번역·UI·서버통신이 다 섞여 839줄이었던 걸,
역할별로 나눴다. 빌드 도구(webpack 등)를 안 쓰기 때문에, 나누는 방식은
**네임스페이스 객체가 아니라 "전역 스코프 공유"** 다:

- `manifest.json`의 `content_scripts.js` 배열에 나열된 파일들은 **같은 실행
  컨텍스트(isolated world)에 순서대로 주입**된다 — 마치 HTML에 `<script>` 태그를
  여러 개 순서대로 넣은 것과 같다.
- 그래서 파일 A에서 선언한 최상위 `const`/`let`/`function`이 파일 B에서
  이름 그대로 보인다. `FM.classify()`처럼 매번 감쌀 필요 없이, 원래 한 파일
  안에서 쓰던 코드를 거의 그대로 옮길 수 있었다.
- 대가: 이름이 전역이라 서로 겹치면 안 된다(지금은 49개 최상위 식별자가 전부
  고유). 새 함수/상수를 추가할 때 다른 fm-*.js 에 같은 이름이 있는지 확인할 것.

## 로드 순서 = 의존성 순서

```
fm-core.js       (공유 상수, settings 저장/로드)
   ↓
fm-filter.js     (classify, DOM 필터 적용) — core 의 settings/norm 사용
   ↓
fm-translate.js  (수신/송신 번역) — core 의 settings 사용
   ↓
fm-socket.js     (서버 WebSocket) — core 의 norm, filter 의 serverCat/reclassifyAllVisible,
                                     ui 의 els 사용 (아래에서 정의되지만 런타임엔 문제없음 — ※)
   ↓
fm-ui.js         (Shadow DOM UI) — 위 전부를 조합해서 이벤트로 연결
   ↓
content.js       (진입점) — init() 정의 + 부트스트랩. 반드시 마지막.
```

※ `fm-socket.js`의 `setConnState()`가 `fm-ui.js`에서 정의되는 `els`를 참조하지만,
`els`는 `let`으로 선언만 되어 있고 실제 채워지는(`buildUI()` 호출) 시점은
`content.js`의 `init()`이 실행될 때다. 이때는 이미 모든 fm-*.js 파일이 로드
완료된 뒤이므로 문제없다. **"함수가 정의된 파일 순서"와 "함수가 실제로
호출되는 시점"을 구분해서 생각할 것** — 후자가 훨씬 늦기 때문에 로드 순서가
살짝 어긋나 있어도 대부분 안전하지만, 새로 추가할 때는 이 원칙을 지키는 게
안전하다(쓰는 쪽이 먼저 로드되지 않아도 되지만, 습관적으로 의존 대상을
먼저 두는 게 헷갈리지 않는다).

## 파일별 책임

| 파일 | 책임 |
|---|---|
| `fm-core.js` | 설정 스키마(`DEFAULTS`)와 저장/로드, 카테고리 라벨, 공용 유틸(`norm`) |
| `fm-filter.js` | 서버 판정(`serverCat`)을 채팅 DOM에 매칭해서 블러/차단 적용 |
| `fm-translate.js` | 수신 번역(외국어→내 언어), 송신 번역(한국어→상대 언어), Chrome 내장 Translator/LanguageDetector 래핑 |
| `fm-socket.js` | 서버 WebSocket 연결, 재연결, 연결 상태 표시(콜드스타트 대응) |
| `fm-ui.js` | Shadow DOM UI 전체(검은 바, 플로팅 버튼, 설정 모달, 온보딩) |
| `content.js` | 위를 조합하는 진입점. `init()` 하나가 전부를 켠다 |
| `popup.html/js/css` | 실제 설정 화면 마크업(툴바 팝업 + `fm-ui.js` 모달 안 iframe 양쪽에서 재사용) — 이번 리팩토링 대상 아님, 그대로 |

## 왜 popup.*은 안 나눴나

`popup.html/js/css`는 이미 content.js와 독립적으로 동작하는 별도 문서(팝업/iframe)라
같은 전역 스코프 공유 문제가 없다. 148줄로 크지 않기도 하고.

## 검증 방법 (파일을 더 나누거나 옮길 때)

```bash
cd frontend
for f in fm-core.js fm-filter.js fm-translate.js fm-socket.js fm-ui.js content.js; do
  node --check "$f" || echo "$f 문법 에러"
done
# manifest.json 의 로드 순서대로 이어붙여서 전체 문법 확인 (중복 선언 있으면 여기서 SyntaxError)
cat fm-core.js fm-filter.js fm-translate.js fm-socket.js fm-ui.js content.js | node --check /dev/stdin
```

이건 문법·중복 선언만 잡아준다. **실제 동작 확인은 크롬에서 확장을 리로드하고
직접 눌러봐야 한다** — Node로는 `chrome.*` API나 유튜브 DOM을 흉내낼 수 없다.
