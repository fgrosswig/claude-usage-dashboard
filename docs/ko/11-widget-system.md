# 위젯 시스템 및 템플릿 빌더

[← 목차](README.md)

## 아키텍처

위젯 시스템은 세 개의 레이어로 구성됩니다:

1. **위젯 레지스트리** (`public/js/widget-registry.js`) — 모든 섹션과 차트의 중앙 매니페스트
2. **위젯 디스패처** (`public/js/widget-dispatcher.js`) — 오케스트레이션: 렌더 디스패치, 가시성, 순서, 그리드 레이아웃
3. **레이아웃 파일** (`~/.claude/usage-dashboard-layout.json`) — 영구 저장된 사용자 설정

## 위젯 레지스트리

각 섹션과 차트에는 다음 항목이 있습니다:

- `id` — 고유 식별자 (예: `proxy`, `ts-c1`)
- `titleKey` — 표시 이름의 i18n 키
- `domId` — DOM의 `<details>` 요소 ID
- `sectionRenderFn` — 전역 렌더 함수 이름 (`window[fnName]`)
- `reorderable` — 드래그로 순서 변경 가능 여부
- `charts[]` — 섹션 내 차트 목록 (`canvasId`, `engine`, `renderFn` 포함)

레지스트리 버전: **v3** — Layer 1 (visible, order, tags), Layer 2 (domId, sectionRenderFn, companionIds).

### 차트 유형

- `kind: "chip"` — KPI 카드 (HTML, ECharts 아님)
- `engine: "echarts"` — ECharts 다이어그램 (v1.8.0 이후 모든 차트)
- `type` — 표시 유형: `bar`, `line`, `mixed`, `sankey`, `scatter` 등

## 12열 그리드 레이아웃

대시보드는 12열 CSS 그리드(`#layout-grid`)를 사용합니다. 각 섹션은 너비를 제어하는 `data-span` 속성(1-12)을 받습니다.

### 레이아웃 파일

```json
{
  "v": 1,
  "order": ["health", "token-stats", "forensic", ...],
  "hiddenSections": [],
  "hiddenCharts": [],
  "widgets": [
    { "id": "health", "span": 12 },
    { "id": "token-stats", "span": 12 },
    ...
  ]
}
```

- **`widgets[]`** — 순서와 열 너비 제어
- **`hiddenSections[]`** / **`hiddenCharts[]`** — 가시성 제어
- **파일 = 단일 진실 소스** — 로드 시 우선, localStorage는 폴백
- **저장**: `/api/layout`에 동기 PUT

### 사이드바 제어

- **레이아웃 영역**: 가시성 체크박스, 편집 모드에서 드래그 순서 변경
- **초기화**: 기본 위젯 생성 (모든 섹션, span 12) 후 새로고침
- `cud_sidebar_open`이 localStorage에 설정되어 있으면 사이드바 자동 열림

## 템플릿 빌더 (계획 중, DEV_MODE)

> **상태:** 실험적, DEV_MODE에서만 표시됩니다. 사용자 정의 레이아웃을 위한 시각적 그리드 빌더 — 향후 버전에서 모든 사용자에게 공개될 예정입니다.

- 섹션과 차트를 위한 드래그 앤 드롭 12열 캔버스
- 모든 사용 가능한 섹션과 차트가 포함된 위젯 풀
- 열 너비(1-12) 조절을 위한 리사이즈 핸들
- 실제 ECharts 다이어그램을 사용한 라이브 미리보기
- 템플릿은 `cud_templates` 키로 `localStorage`에 저장

## 독립형 차트 함수

v1.8.0부터 각 섹션에 독립형 `window.*` 렌더 함수가 있습니다:

- `renderTokenStats_c1_daily()`, `renderTokenStats_c2_daily()` 등
- `renderForensic_main()`, `renderForensic_signals()`, `renderForensic_service()`
- `renderProxy_tokens()`, `renderProxy_latency()` 등
- `renderBudget_sankey()`, `renderBudget_trend()`, `renderBudget_quota()`

각 함수는 `_computeXxxCtx()`로 계산된 캐시된 섹션 컨텍스트(`window.__sectionCtx_xxx`)를 사용합니다. 이를 통해 차트를 임의의 컨테이너에 독립적으로 렌더링할 수 있습니다.
