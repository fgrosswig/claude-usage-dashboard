# UDAA 필드 스터디 — 익명화된 세션 내보내기

## UDAA란?

**UDAA** (Usage Drain Anomalies Audit)는 Claude Code 세션에 대한 포렌식 분석 프레임워크입니다. 세션 수명 동안 토큰 소비가 어떻게 증가하는지 분석합니다 — 특히 캐시 재처리, 압축 이벤트, 숨겨진 비용을 중심으로.

## 필드 스터디 내보내기

대시보드에는 UDAA 필드 스터디를 위해 로컬 세션 데이터를 준비하는 **익명화된 내보내기 도구**가 포함되어 있습니다. **숫자 및 시간 필드만** 내보냅니다 — 프롬프트, 도구 내용, 파일 경로, 호스트명은 포함되지 않습니다.

### 내보내는 데이터

세션 내 턴(API 호출)별:

| 필드 | 설명 |
|------|------|
| `t_delta_ms` | 세션 첫 턴부터의 시간 오프셋 (ms) |
| `input` | 입력 토큰 |
| `output` | 출력 토큰 |
| `cache_read` | 캐시 읽기 토큰 (재처리) |
| `cache_creation` | 캐시 생성 토큰 |
| `model_id` | 모델 ID (정규화, 날짜 접미사 제거) |

세션별:

| 필드 | 설명 |
|------|------|
| `session_id_hash` | 세션 ID의 SHA-256 해시 (역추적 불가) |
| `turn_count` | 턴 수 |
| `schema_version` | 포맷 버전 (`1.0`) |
| `client.app_version` | 대시보드 버전 |
| `client.os_family` | 운영체제 (`win32`, `linux`, `darwin`) |

### 내보내지 않는 데이터

- 프롬프트, 응답, 도구 내용
- 파일 경로, 호스트명, CWD, Git 브랜치
- 실제 세션 ID (SHA-256 해시만)
- 실제 타임스탬프 (턴 1부터의 상대적 델타만)

### 사용법

```bash
# 모든 세션 내보내기
node scripts/udaa-fieldstudy-export.js

# 특정 디렉토리로 내보내기
node scripts/udaa-fieldstudy-export.js --out ./my-data

# 파일 작성 없이 미리보기
node scripts/udaa-fieldstudy-export.js --dry-run

# 서브에이전트 사이드체인 세션 포함 (기본: 건너뜀)
node scripts/udaa-fieldstudy-export.js --include-sidechain
```

**출력:** `./out/udaa-fieldstudy/` (또는 `--out`) 아래에 세션별 `submission_<nonce>.json` 파일.

### 요구사항

- **2턴 미만** 세션은 건너뜁니다 (관찰 가능한 시간 패턴 없음).
- 실제 토큰 사용이 있는 `assistant` 턴만 포함 (합성 레코드 제외).

## 데이터 공유

필드 스터디에 세션 데이터를 기여하려면 내보낸 JSON 파일을 다음 서비스를 통해 공유할 수 있습니다:

| 서비스 | 최대 크기 | 보존 기간 | 특징 |
|--------|----------|----------|------|
| [file.io](https://www.file.io) | 2 GB | 일회 다운로드 | 첫 다운로드 후 링크 만료 |
| [catbox.moe](https://catbox.moe) | 200 MB | 만료 없음 | 계정 불필요 |
| [temp.sh](https://temp.sh) | 4 GB | 3일 | `curl -T file.json https://temp.sh` |
| [litterbox.catbox.moe](https://litterbox.catbox.moe) | 1 GB | 1시간 / 12시간 / 24시간 / 72시간 | 보존 기간 선택 가능 |

**권장:** [file.io](https://www.file.io) — 일회 다운로드로 수신자만 데이터를 받을 수 있습니다.

**여러 파일:** 먼저 묶어서:

```bash
# Linux/Mac
tar czf udaa-export.tar.gz out/udaa-fieldstudy/

# Windows PowerShell
Compress-Archive -Path out\udaa-fieldstudy\* -DestinationPath udaa-export.zip
```

단일 아카이브 파일을 업로드합니다.

## 보안 참고사항

- **공유 전:** 내보낸 JSON 파일을 검토하세요. 내보내기 도구가 모든 민감한 내용을 제거하지만 확인은 항상 좋습니다.
- 네트워크 호출 없음: 내보내기 도구는 **순수 로컬**로 작동합니다 — JSONL 읽기, JSON 쓰기.
- `submission_nonce` (UUID)는 무작위 생성되며 추적 불가능합니다.

## 데이터 활용

내보낸 세션으로 다음을 분석할 수 있습니다:

- **캐시 증가 분석:** 세션 수명 동안 턴당 비용이 얼마나 빠르게 증가하는가?
- **압축 감지:** 캐시 무효화가 언제, 얼마나 자주 발생하는가?
- **분할 권장:** 어느 턴에서 `/clear`가 비용 효율적인가?
- **모델 비교:** Claude 모델 간 토큰 동작 차이.
- **벤치마킹:** 여러 참가자 간 사용 패턴 비교.
