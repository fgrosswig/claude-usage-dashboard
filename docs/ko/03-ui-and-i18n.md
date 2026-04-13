# UI, 필터 및 국제화

[← 목차](README.md)

## UI 텍스트 (DE/EN)

- 텍스트는 **JSON** 으로 **`tpl/de/ui.tpl`** 및 **`tpl/en/ui.tpl`** 에 저장 (확장자 `.tpl`, 내용은 유효한 JSON).
- **`/`** 는 **인메모리 캐시** 사용 (`.tpl` 파일의 **mtime** 변경 시 무효화). 저장 → 페이지 새로고침.
- **`GET /api/i18n-bundles`** 는 `{ "de": …, "en": … }` 를 반환.
- 키: 플랫 ID (예: `chartDailyToken`); 플레이스홀더 `{n}`, `{files}` 는 클라이언트에서 치환.

## Meta 라인 및 범례

- 제목 아래: 모델 안내 (**`claude-*`** 만, `<synthetic>` 제외), 파싱/상태 라인, Limit/데이터 소스, 스캔 소스가 포함된 접기 가능 블록.
- 접힌 상태: 간략 요약 (예: 로그 파일, 새로고침 간격).
- 상태: **`sessionStorage.usageMetaDetailsOpen`**.

## 일자 선택 (카드 및 테이블)

- 드롭다운: 데이터가 있는 모든 날짜 (최신순).
- **카드** 및 **일별 상세 테이블**: 선택한 일자. **차트** 및 **포렌식 영역**: 일반적으로 **전체** 기간 (또는 선택한 기간 필터에 따름).
- 선택: **`sessionStorage.usageDashboardDay`**.
- 달력상 '오늘'에 0 토큰인 경우: 간단한 안내 표시.

## 필터 및 내비게이션 (Top-Bar)

- **기간** 시작/종료 (드롭다운).
- **카드 & 테이블**: 일자 선택기.
- **차트**: **전체 기간** vs. **24시간 (선택한 일자)**.
- **소스**: 전체 또는 개별 호스트 — [Multi-Host](04-multi-host-und-datensync.md) 참조.
- 뱃지: **Live**, **Anthropic**, 압축된 **Meta** 라인 (로그 파일, 새로고침).

## Extension 업데이트 (Service-Impact, 보고서)

- **마커:** 주로 **VS Code Marketplace** ([Version History](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code&ssr=false#version-history)) — `lastUpdated`, 최신 Semver; **UTC 달력일** 기준. 캐시: **`~/.claude/claude-code-marketplace-versions.json`**.
- **Changelog:** **GitHub Releases** (최대 100개 항목), 캐시 **`~/.claude/claude-code-releases.json`**. 데이터: Marketplace ∪ GitHub 병합 (Marketplace 날짜 우선), 그 외 JSONL 폴백.
- JSONL의 버전: **`major.minor.patch`** 로 정규화. 원시 키가 있는 오래된 Day-Cache의 경우: 한 번 전체 스캔 (`CLAUDE_USAGE_NO_CACHE=1` 또는 캐시 파일 삭제).

## 차트 엔진 (v1.8.0 이후)

- 모든 차트는 **ECharts** 를 사용합니다 (Chart.js 완전 제거).
- 각 섹션에는 임의의 컨테이너에 독립 렌더링할 수 있는 **독립형 렌더 함수** (`window.renderXxx()`)가 있습니다.
- 차트는 **위젯 레지스트리** (`public/js/widget-registry.js`)에 `engine: "echarts"`, `canvasId`, `renderFn`으로 등록되어 있습니다.

## 섹션

| 섹션 | 설명 |
|------|------|
| Health Score | 전체 점수 (0-10), KPI 칩, 주요 발견 사항 |
| Token Stats | 일별/시간별 차트, 오버헤드, 캐시 비율 |
| Forensic Analysis | 히트 리밋, 신호, 서비스 임팩트 |
| User Profile | 버전, 진입점, 릴리스 안정성 |
| Budget Efficiency | Sankey, 트렌드, 쿼터 이력 |
| Proxy Analytics | 토큰, 지연시간, 모델, 오류 트렌드, 캐시 트렌드 |
| Intelligence / Predictive | 포화도, 건강 점수, 서술, 계절성 (잠정) |
| Economic Usage | 누적 곡선, 캐시 폭발, 버짓 드레인 |
| Anthropic Status | 가동 시간, 사건, 장애 타임라인 |

## 사이드바 설정

- **레이아웃**: 섹션 표시/숨기기, 드래그로 순서 변경, 열 너비(span) 조정
- **템플릿**: 저장된 레이아웃 불러오기/생성
- **설정**: 언어, 플랜 (MAX5/MAX20/Pro/Free/API), 사용자 설정
- **도구**: 파일 탐색기
- **내보내기**: JSONL 내보내기, 템플릿 가져오기/내보내기

위젯 시스템 상세: [11장](11-widget-system.md).
