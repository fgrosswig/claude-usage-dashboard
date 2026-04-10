# 스크린샷

[← 목차](README.md)

저장소 루트 기준 상대 경로: 폴더 **`images/`** — **모든** 스크린샷이 이 폴더에 있으며, 별도의 이미지 폴더는 없습니다.

테이블은 **인덱스**이며, 그 아래에 **미리보기**와 각 이미지의 **제목** 및 **간략 설명**이 있습니다.

## Root README의 두 스크린샷

이 **두** 파일은 저장소 시작 페이지의 **[README.md](../../README.md)** 및 **[README.en.md](../../README.en.md)** 에 포함되어 있습니다: **토큰 개요** 및 **Proxy Analytics**.

| 이미지 | 주제 |
| ---- | ----- |
| `main_overview_statistics.png` | 토큰 카드 및 주요 차트 |
| `proxy_statistics.png` | Proxy Analytics |

### 미리보기 (README에 표시된 것과 동일)

#### 토큰 카드 & 주요 차트

**통계 카드** (Output, Cache, Calls, …) 선택한 일자 기준 및 **주요 차트** (토큰 추이, Cache:Output, 시간별 사용량).

![토큰 카드 및 주요 차트](../../images/main_overview_statistics.png)

#### Proxy Analytics

모니터 **Proxy** 뷰: **Requests**, **지연시간**, **Cache 비율**, **모델**, 필요 시 **Quota 카드** 및 시간별 부하 **차트**.

![Proxy Analytics](../../images/proxy_statistics.png)

## 추가 UI 캡처 (문서에만 포함)

**Root README**는 의도적으로 최소화되어 있으며, 다음 **다섯 개**의 PNG 파일은 **`images/`** 에서 여기에 문서화되지만 시작 페이지에는 **표시되지 않습니다**.

| 이미지 | 주제 |
| ---- | ----- |
| `top_nav_prod.png` | 내비게이션, 필터, Live/Meta |
| `healthstatus.png` | Health Score, 핵심 소견 |
| `forensic_hitlimitdaily.png` | 포렌식 & 일별 Hit Limit |
| `forensic_session_service_interrupts.png` | Session 신호, Service Impact |
| `table_details.png` | 일별 상세 테이블 (Multi-Host) |

### 미리보기

#### 내비게이션, 필터, Live/Meta

상단 바: **언어 전환**, **날짜 범위** (시작/종료), **호스트 필터**, **범위** (전체 기간 vs. 24시간), **실시간 상태** (SSE), **Anthropic** / **Meta** 뱃지; 뷰 간 내비게이션.

![내비게이션, 필터, Live/Meta](../../images/top_nav_prod.png)

#### Health Score & 핵심 소견

**Health 신호등** 전체 점수 및 **핵심 소견**; 개별 **지표** (Quota, 지연시간, Limits, …) **녹색/황색/적색** 색상 표시; 트렌드 참조 및 컴팩트한 소견 목록.

![Health Score, 핵심 소견](../../images/healthstatus.png)

#### 포렌식 & Hit Limit (일별)

**Hit-Limit** 마커 및 **일별** 지표가 포함된 포렌식 영역; JSONL의 Limit 휴리스틱과 차트 근접 하이라이트의 조합.

![포렌식 & 일별 Hit Limit](../../images/forensic_hitlimitdaily.png)

#### Session 신호 & Service Impact

**Session 신호** 개요 (예: Continue/Resume/Retry/Interrupt) 상황 파악용; 옆이나 아래에 선택한 기간에 대한 **Service Impact** / 가용성.

![Session 신호, Service Impact](../../images/forensic_session_service_interrupts.png)

#### 일별 상세 테이블 (Multi-Host)

**테이블 형식 일별 상세정보** (호스트, 토큰, 호출 수, …); 다중 소스 시 **호스트별 행** 또는 호스트 참조가 포함된 집계 뷰.

![일별 상세 테이블 (Multi-Host)](../../images/table_details.png)

## 보충 스크린샷 (**images/**)

**동일한** 폴더 **`images/`** 에 **추가** PNG 파일이 있습니다 (Meta, 스캔 목록, 컴팩트 스트립 …). README 갤러리에는 **포함되지 않으며**, 여기에 간략한 설명과 함께 기록합니다.

| 이미지 | 간략 설명 |
| ---- | ---------------- |
| `healthstatus_overview.png` | 컴팩트 신호등 라인 (Health) |
| `forensic_overview.png` | 포렌식 헤더 + Report 버튼 |
| `main_overview.png` | 간략 요약 라인 (일자) |
| `github_integration.png` | Meta 패널: 경로, PAT, 스캔 소스 |
| `scores_service_charts.png` | Health 트렌드, Incidents, 24시간 가용성 |
| `dataparse_logfiles_details.png` | 스캔된 JSONL 경로 목록 |

### 미리보기 (이 스크린샷들)

#### 컴팩트 Health 신호등

**접힌** 또는 **컴팩트** Health 블록: 전체 핵심 소견 뷰 없이 가장 중요한 상태 뱃지가 포함된 **신호등 라인**.

![컴팩트 신호등 라인 (Health)](../../images/healthstatus_overview.png)

#### 포렌식 헤더 & Report

**포렌식 제목 라인** 제어/상태 포함; 포렌식 평가를 위한 **Report 버튼** 또는 내보내기 안내.

![포렌식 헤더 + Report](../../images/forensic_overview.png)

#### 일자별 간략 요약

선택한 달력일의 **핵심 수치**가 포함된 **한 줄** (또는 매우 컴팩트한 블록) — 큰 카드 앞의 개요.

![간략 요약 라인 (일자)](../../images/main_overview.png)

#### 로그파일, Health 트렌드, Meta (나란히)

<table>
  <tbody>
    <tr valign="top">
      <td align="left"><strong>JSONL / Scan</strong><br />인식된 <code>.jsonl</code> 파일 및 경로 발췌 목록 — 현재 스캔에 포함된 로그.</td>
      <td align="left"><strong>Health & 가용성</strong><br />Health Score 추이, Incident 마커 (Anthropic) 및 24시간 사용량 / 가용성.</td>
      <td align="left"><strong>Meta 패널</strong><br />Day-Cache, Releases, Marketplace 경로; 선택적 릴리스용 PAT; 스캔 루트.</td>
    </tr>
    <tr valign="top">
      <td align="left"><img src="../../images/dataparse_logfiles_details.png" alt="스캔된 JSONL 경로 목록" /></td>
      <td align="left"><img src="../../images/scores_service_charts.png" alt="Health 트렌드, Incidents, 24시간 가용성" /></td>
      <td align="left"><img src="../../images/github_integration.png" alt="Meta 패널: 경로, PAT, 스캔 소스" /></td>
    </tr>
  </tbody>
</table>
