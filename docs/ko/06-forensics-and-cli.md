# 제한, 포렌식 및 CLI

[← 목차](README.md)

## 휴리스틱만 사용

- UI의 **데이터 소스**: 일반적인 **`~/.claude/projects`** (이름이 포함된 사용자 경로 없음).
- **Hit Limit (차트에서 빨간색):** 일반적인 Rate/Limit 패턴이 있는 JSONL 라인 — 직접적인 API 증거는 **아님**.
- **포렌식 코드:** **`?`** (매우 높은 Cache-Read), **`HIT`** (Limit 유사 라인), **`<<P`** (엄격한 Peak 비교). Claude UI의 "90 % / 100 %"와 **동일하지 않음**.
- **Session 신호 차트:** 누적 막대 (continue, resume, retry, interrupt), 상단에 **장애 시간**; **보라색 선** = Cache Read (오른쪽 축) — 일별 휴리스틱이며 인과관계 아님.

## CLI 포렌식

**`scripts/token-forensics.js`** — Dashboard와 동일한 스캔 루트, Day-Cache **버전 5**.

```bash
node start.js forensics
# 또는 node scripts/token-forensics.js / node token_forensics.js
```

**자동화:** Peak 일자 (최고 총 소비량); Limit 일자 (JSONL에서 Rate/Limit 라인 ≥ 50개 **또는** Cache-Read ≥ 500 M); 마지막 유의미한 Limit 일자와 비교 (호출 ≥ 50회, 활동시간 ≥ 2시간).

**7개 출력 섹션:** 일별 개요, 효율성 붕괴, Subagent 분석, 예산 추정 (`total/0.9`), 시간별 분석, 결론 (Peak vs. Limit), ASCII 시각화.

**MAX 플랜:** Peak/Limit은 세션 예산이 변경되었는지 보여줌; **Cache:Output**은 효율성 표시 (Subagent 감소 → 오버헤드 감소).
