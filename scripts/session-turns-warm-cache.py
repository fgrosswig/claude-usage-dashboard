#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Offline warmup for session-turns JSON (read by dashboard-server when
CLAUDE_USAGE_SESSION_TURNS_CACHE_DIR is set).

  - Uses the same JSONL file list as Node: node scripts/print-jsonl-paths.js
  - Fingerprint: identical string from print-jsonl-paths.js (Node mtimeMs + size)
  - Output per day: {out_dir}/{YYYY-MM-DD}.json with { fingerprint, generated, result }

Cron example (repo root, Linux):
  17 * * * * cd /path/to/Claude-Usage-Dashboard && \\
    CLAUDE_USAGE_SESSION_TURNS_CACHE_DIR=~/.cache/cud-session-turns \\
    python3 scripts/session-turns-warm-cache.py --days-back 8

Benchmark (no writes):
  python3 scripts/session-turns-warm-cache.py --benchmark --days-back 8
  python3 scripts/session-turns-warm-cache.py --benchmark --iterations 3 --days-back 3

See getSessionTurnsCached / pass1CollectSessionsForDayWindowFromFiles in dashboard-server.js.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Mapping, MutableMapping, Optional, Set, Tuple

MODEL_SUFFIX = re.compile(r"-\d{8}$")


def _repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_paths_and_fingerprint(repo_root: str) -> Tuple[List[str], str]:
    script = os.path.join(repo_root, "scripts", "print-jsonl-paths.js")
    p = subprocess.run(
        ["node", script],
        cwd=repo_root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if p.returncode != 0:
        sys.stderr.write("print-jsonl-paths.js failed: %s\n" % (p.stderr or p.stdout or ""))
        sys.exit(1)
    raw = (p.stdout or "").strip()
    o = json.loads(raw)
    if not isinstance(o, dict):
        sys.stderr.write("unexpected JSON from print-jsonl-paths.js\n")
        sys.exit(1)
    paths = o.get("paths")
    fp = o.get("fingerprint")
    if not isinstance(paths, list) or not isinstance(fp, str):
        sys.stderr.write("print-jsonl-paths.js: need { paths, fingerprint }\n")
        sys.exit(1)
    return [str(x) for x in paths], fp


def _day_prev_next(day: str) -> Tuple[str, str, str]:
    d = _dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=_dt.timezone.utc)
    prev = (d - _dt.timedelta(days=1)).date().isoformat()
    nxt = (d + _dt.timedelta(days=1)).date().isoformat()
    return prev, day, nxt


def _allowed_turn_days(date_keys: List[str]) -> Set[str]:
    out: Set[str] = set()
    for dk in date_keys:
        a, b, c = _day_prev_next(dk)
        out.add(a)
        out.add(b)
        out.add(c)
    return out


def _pass1(paths: List[str], allowed: Set[str]) -> MutableMapping[str, List[Dict[str, Any]]]:
    all_sessions: Dict[str, List[Dict[str, Any]]] = {}
    for fp in paths:
        try:
            f = open(fp, "rb")
        except OSError:
            continue
        try:
            for raw in f:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("type") != "assistant":
                    continue
                if rec.get("isSidechain"):
                    continue
                ts = rec.get("timestamp")
                if not isinstance(ts, str) or len(ts) < 19:
                    continue
                turn_day = ts[0:10]
                if turn_day not in allowed:
                    continue
                msg = rec.get("message") or {}
                usage = msg.get("usage")
                if not isinstance(usage, Mapping):
                    continue
                inp = int(usage.get("input_tokens") or 0)
                out_t = int(usage.get("output_tokens") or 0)
                cr = int(usage.get("cache_read_input_tokens") or 0)
                cc = int(usage.get("cache_creation_input_tokens") or 0)
                if inp + out_t + cr + cc == 0:
                    continue
                sid = rec.get("sessionId")
                if not sid:
                    continue
                model = str(msg.get("model") or "unknown")
                model = MODEL_SUFFIX.sub("", model)
                row = {
                    "ts": ts,
                    "day": turn_day,
                    "input": inp,
                    "output": out_t,
                    "cache_read": cr,
                    "cache_creation": cc,
                    "model": model,
                }
                all_sessions.setdefault(str(sid), []).append(row)
        finally:
            f.close()
    return all_sessions


def _finalize(date_key: str, all_sessions: Mapping[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    sessions_map: Dict[str, List[Dict[str, Any]]] = {}
    total_parsed = 0
    for sid, turns in all_sessions.items():
        has_d = any(t["day"] == date_key for t in turns)
        if not has_d:
            continue
        sessions_map[sid] = turns
        total_parsed += len(turns)

    result: List[Dict[str, Any]] = []
    for sid, turns in sessions_map.items():
        turns = sorted(turns, key=lambda t: t["ts"])
        first_day = turns[0]["day"]
        last_day = turns[-1]["day"]
        edge_start = first_day < date_key
        edge_end = last_day > date_key
        mapped = []
        for i, t in enumerate(turns):
            mapped.append(
                {
                    "index": i,
                    "ts": t["ts"],
                    "input": t["input"],
                    "output": t["output"],
                    "cache_read": t["cache_read"],
                    "cache_creation": t["cache_creation"],
                    "model": t["model"],
                }
            )
        h = hashlib.sha256(str(sid).encode("utf-8")).hexdigest()[0:12]
        entry: Dict[str, Any] = {
            "session_id_hash": h,
            "turn_count": len(mapped),
            "first_ts": turns[0]["ts"],
            "last_ts": turns[-1]["ts"],
            "total_output": sum(t["output"] for t in turns),
            "total_cache_read": sum(t["cache_read"] for t in turns),
            "total_all": sum(
                t["input"] + t["output"] + t["cache_read"] + t["cache_creation"] for t in turns
            ),
            "turns": mapped,
        }
        if edge_start:
            entry["edge_start"] = True
        if edge_end:
            entry["edge_end"] = True
        result.append(entry)

    result.sort(key=lambda e: e["total_all"], reverse=True)
    return {
        "date": date_key,
        "session_count": len(result),
        "total_turns": total_parsed,
        "sessions": result,
    }


def _atomic_write_json(path: str, obj: Any) -> None:
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".st-", suffix=".json", dir=d or ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as wf:
            json.dump(obj, wf, separators=(",", ":"))
            wf.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _resolve_date_keys(days_back: int, dates_csv: str) -> List[str]:
    if dates_csv.strip():
        return [x.strip() for x in dates_csv.split(",") if x.strip()]
    n = max(1, int(days_back))
    today = _dt.datetime.now(_dt.timezone.utc).date()
    return [(today - _dt.timedelta(days=i)).isoformat() for i in range(n)]


def _run_timed_pipeline(repo: str, date_keys: List[str]) -> Dict[str, Any]:
    """One full scan; returns timings (seconds) and counts."""
    t0 = time.perf_counter()
    paths, fp = _load_paths_and_fingerprint(repo)
    t1 = time.perf_counter()
    allowed = _allowed_turn_days(date_keys)
    all_sessions = _pass1(paths, allowed)
    t2 = time.perf_counter()
    results: Dict[str, Dict[str, Any]] = {}
    for dk in date_keys:
        results[dk] = _finalize(dk, all_sessions)
    t3 = time.perf_counter()
    return {
        "paths_s": t1 - t0,
        "pass1_s": t2 - t1,
        "finalize_s": t3 - t2,
        "total_s": t3 - t0,
        "jsonl_files": len(paths),
        "fingerprint_chars": len(fp),
        "raw_session_ids": len(all_sessions),
        "date_keys": date_keys,
        "results": results,
        "fingerprint": fp,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Warm CLAUDE_USAGE_SESSION_TURNS_CACHE_DIR JSON files.")
    ap.add_argument("--repo-root", default=_repo_root(), help="Repository root (default: parent of scripts/)")
    ap.add_argument(
        "--out-dir",
        default=os.environ.get("CLAUDE_USAGE_SESSION_TURNS_CACHE_DIR", "").strip(),
        help="Output directory (default: env CLAUDE_USAGE_SESSION_TURNS_CACHE_DIR)",
    )
    ap.add_argument("--days-back", type=int, default=8, help="Calendar days ending today (UTC)")
    ap.add_argument(
        "--dates",
        default="",
        help="Comma-separated YYYY-MM-DD instead of --days-back",
    )
    ap.add_argument(
        "--benchmark",
        action="store_true",
        help="Measure phases (node paths+fingerprint, pass1, finalize); no disk writes",
    )
    ap.add_argument(
        "--iterations",
        type=int,
        default=1,
        help="With --benchmark: repeat full pipeline and report min/avg/max total (default 1)",
    )
    args = ap.parse_args()
    repo = os.path.abspath(args.repo_root)
    date_keys = _resolve_date_keys(args.days_back, args.dates)

    if args.benchmark:
        iters = max(1, int(args.iterations))
        totals: List[float] = []
        last_stats: Optional[Dict[str, Any]] = None
        for _ in range(iters):
            last_stats = _run_timed_pipeline(repo, date_keys)
            totals.append(float(last_stats["total_s"]))
        assert last_stats is not None
        sys.stdout.write(
            "session-turns-warm-cache benchmark\n"
            "  repo:          %s\n"
            "  dates:         %d (%s .. %s)\n"
            "  jsonl files:   %d\n"
            "  last run:\n"
            "    node paths+fp:  %8.3f s\n"
            "    pass1 (read):   %8.3f s\n"
            "    finalize:       %8.3f s\n"
            "    total:          %8.3f s\n"
            "  raw sid keys:  %d\n"
            % (
                repo,
                len(date_keys),
                date_keys[0],
                date_keys[-1],
                last_stats["jsonl_files"],
                last_stats["paths_s"],
                last_stats["pass1_s"],
                last_stats["finalize_s"],
                last_stats["total_s"],
                last_stats["raw_session_ids"],
            )
        )
        if iters > 1:
            avg = sum(totals) / len(totals)
            sys.stdout.write(
                "  iterations=%d total_s: min=%.3f avg=%.3f max=%.3f\n"
                % (iters, min(totals), avg, max(totals))
            )
        for dk in date_keys:
            r = last_stats["results"][dk]
            sys.stdout.write("  %s  sessions=%d total_turns=%d\n" % (dk, r["session_count"], r["total_turns"]))
        return

    out_dir = (args.out_dir or "").strip()
    if not out_dir:
        ap.error("set --out-dir or CLAUDE_USAGE_SESSION_TURNS_CACHE_DIR (or use --benchmark)")

    stats = _run_timed_pipeline(repo, date_keys)
    fp = str(stats["fingerprint"])
    gen = _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    # Re-use finalized results from stats (avoid double pass1)
    for dk in date_keys:
        result = stats["results"][dk]
        payload = {"fingerprint": fp, "generated": gen, "result": result}
        target = os.path.join(out_dir, dk + ".json")
        _atomic_write_json(target, payload)
        sys.stdout.write("wrote %s (%d sessions)\n" % (target, result["session_count"]))
    sys.stdout.write(
        "(timing: paths+fp %.3fs pass1 %.3fs finalize %.3fs total %.3fs)\n"
        % (stats["paths_s"], stats["pass1_s"], stats["finalize_s"], stats["total_s"])
    )


if __name__ == "__main__":
    main()
