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
