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

## 템플릿 빌더

사용자 정의 대시보드 레이아웃을 위한 시각적 그리드 빌더. 사이드바의 **"Template erstellen"** 버튼으로 열기.

### 레이아웃 (3열 구조)

```text
┌──────────────┬────────────────────────────┬──────────────┐
│  차트 풀     │       캔버스 (12-Grid)      │  칩 / HTML   │
│              │                            │     풀       │
│  ECharts     │  섹션 (접기/펼치기)          │  KPI 카드    │
│  다이어그램   │    └─ 레이아웃 블록          │  Health      │
│  캔버스로     │       └─ 차트 (span)        │  배지        │
│  드래그      │                            │  메타 그리드   │
│              │  리사이즈 핸들 (1-12)        │              │
│              │  드래그 순서 변경            │              │
└──────────────┴────────────────────────────┴──────────────┘
```

- **왼쪽 — 차트 풀**: 레지스트리의 모든 ECharts 다이어그램, 드래그 앤 드롭으로 캔버스에 배치
- **가운데 — 캔버스**: 접을 수 있는 섹션이 있는 12열 그리드. 각 섹션에는 차트가 포함된 레이아웃 블록(행)이 있음. 섹션과 차트에 리사이즈 핸들(span 1-12)이 있고 드래그로 순서 변경 가능
- **오른쪽 — 칩/HTML 풀**: KPI 카드, Health 배지 및 기타 HTML 위젯 (ECharts 아님)

### 사용법

1. **템플릿 선택**: 헤더의 드롭다운에서 기본 제공 또는 사용자 정의 템플릿 선택
2. **"Layout uebernehmen"**: 선택한 템플릿을 캔버스에 로드
3. **섹션 추가**: 캔버스 위의 섹션 스트립에서 추가
4. **차트 배치**: 왼쪽 풀에서 레이아웃 블록으로 드래그
5. **레이아웃 블록**: 각 섹션 아래의 span 버튼(1-12)으로 새 행 생성
6. **리사이즈**: span 표시를 클릭하여 열 너비 변경 (섹션 또는 차트)
7. **미리보기**: 실제 ECharts 다이어그램과 KPI 칩으로 미리보기 (반응형)
8. **저장**: 이름을 지정하여 템플릿으로 저장하고 대시보드에 즉시 적용

### 템플릿

- **기본 제공**: Full (모든 섹션), Performance (Forensic + Economic + Token-Stats), Cost (Economic + Budget + Proxy), Compact (6개 섹션, 혼합 span)
- **사용자 정의 템플릿**: 저장 시 이름 지정; 사이드바의 "Vorlagen" 아래와 빌더 드롭다운에 표시 (`*` 표시)
- **영구 저장**: 레이아웃 파일(`~/.claude/usage-dashboard-layout.json`)의 `templates` 키에 서버 측 저장 (localStorage 폴백)

## 독립형 차트 함수

v1.8.0부터 각 섹션에 독립형 `window.*` 렌더 함수가 있습니다:

- `renderTokenStats_c1_daily()`, `renderTokenStats_c2_daily()` 등
- `renderForensic_main()`, `renderForensic_signals()`, `renderForensic_service()`
- `renderProxy_tokens()`, `renderProxy_latency()` 등
- `renderBudget_sankey()`, `renderBudget_trend()`, `renderBudget_quota()`

각 함수는 `_computeXxxCtx()`로 계산된 캐시된 섹션 컨텍스트(`window.__sectionCtx_xxx`)를 사용합니다. 이를 통해 차트를 임의의 컨테이너에 독립적으로 렌더링할 수 있습니다.
