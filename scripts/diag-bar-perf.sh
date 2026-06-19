#!/usr/bin/env bash
# =============================================================================
# diag-bar-perf.sh — profile the shoji-bar-2 gjs process when it pegs a core.
#
# Produces a compact summary to locate a busy loop / hot path:
#   1. process + per-thread CPU snapshot (which thread is hot)
#   2. perf record (user-space, dwarf call graph) -> top symbols + call graph
#   2b. gdb capture of the live log message (works even if stderr -> /dev/null)
#   3. perf stat (instructions, context switches, etc.)
#   4. eu-stack wall-clock sampling (poor-man's profiler) aggregated by frame —
#      this is the most reliable signal for JIT'd JS where perf can't symbolize.
#
# -----------------------------------------------------------------------------
# USAGE
#   scripts/diag-bar-perf.sh [duration_seconds] [pid]
#     duration_seconds : how long to sample (default 8). 6–10s is plenty.
#     pid              : target PID. Omit to auto-detect the bar's gjs process.
#
#   # typical: bar is frozen, auto-detect the PID, sample 8s
#   scripts/diag-bar-perf.sh
#
#   # explicit PID + longer sample
#   scripts/diag-bar-perf.sh 10 1340
#
#   # find the PID yourself if auto-detect misses it
#   pgrep -af 'gjs -m'        # or:  ps -eo pid,pcpu,args | grep gjs
#
# -----------------------------------------------------------------------------
# REQUIREMENTS / PERMISSIONS
#   - perf (sections 2/3): needs kernel.perf_event_paranoid <= 2. No root for
#     user-space profiling of your own process. Check: sysctl kernel.perf_event_paranoid
#   - gdb + eu-stack (sections 2b/4): use ptrace. yama blocks attaching to a
#     non-child PID when kernel.yama.ptrace_scope=1 (the common default), so
#     those sections come up EMPTY unless you first allow it:
#         sudo sysctl -w kernel.yama.ptrace_scope=0     # run the script
#         sudo sysctl -w kernel.yama.ptrace_scope=1     # revert afterwards
#     (Or run the whole script as root.) The script prints a NOTE when blocked.
#   - A frozen bar ignores `ags quit` (its main loop is saturated and can't
#     service the IPC). To restart it after diagnosing:  kill -9 <pid>
#
# -----------------------------------------------------------------------------
# HOW TO READ THE OUTPUT
#   - "busiest threads": which thread spins (usually the GTK main-loop thread).
#   - "perf: top symbols" + "hottest call graphs": the native hot path. Look at
#     the deepest *named* frames — e.g. g_log_* under gsk_renderer_render means a
#     per-frame warning storm; gtk_accessible_* / g_object_notify means a GTK
#     accessibility/notify loop.
#   - "captured log message": the FORMAT line is the exact warning being logged
#     every frame (only meaningful for a g_log-type freeze).
#   - "most frequent native frames": busy-loop signature; ignore the futex /
#     pthread_cond_wait frames (idle worker threads) and focus on g_signal_emit
#     / g_closure_invoke / gtk_* chains.
#
# Artifacts (perf.data, raw stacks) are kept under a /tmp/diag-bar.XXXX dir
# printed at the top, in case you want to dig further with `perf report`.
# =============================================================================
set -uo pipefail

DUR="${1:-8}"
PID="${2:-}"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# --- locate the bar's gjs process ------------------------------------------
if [[ -z "$PID" ]]; then
  PID="$(pgrep -f 'gjs -m .*ags(\.js)?' | head -n1)"
  [[ -z "$PID" ]] && PID="$(pgrep -xn gjs)"
fi
if [[ -z "${PID:-}" ]] || ! kill -0 "$PID" 2>/dev/null; then
  echo "ERROR: could not find a running gjs/ags bar process." >&2
  echo "Pass the PID explicitly:  $0 $DUR <pid>" >&2
  exit 1
fi

OUT="$(mktemp -d /tmp/diag-bar.XXXXXX)"
echo "shoji-bar-2 diagnostic  |  PID=$PID  duration=${DUR}s  workdir=$OUT"
echo "cmdline: $(tr '\0' ' ' </proc/"$PID"/cmdline 2>/dev/null)"

# perf uses perf_event_open (works at paranoid<=2); gdb/eu-stack need ptrace,
# which yama blocks for non-child PIDs when ptrace_scope=1. Warn early so the
# stack/log-capture sections aren't a mystery if they come up empty.
PTRACE_SCOPE="$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)"
if [[ "$PTRACE_SCOPE" != "0" && "$(id -u)" != "0" ]]; then
  echo "NOTE: ptrace_scope=$PTRACE_SCOPE — gdb/eu-stack attach will fail."
  echo "      For the log-message capture + stack sampling, run as root, or:"
  echo "        sudo sysctl -w kernel.yama.ptrace_scope=0    # (revert to $PTRACE_SCOPE after)"
fi

# --- 1. process + per-thread CPU snapshot ----------------------------------
say "process status"
grep -E '^(State|Threads|VmRSS|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):' \
  /proc/"$PID"/status 2>/dev/null

# Instantaneous whole-process %CPU (sample utime+stime over 1s).
read_cpu() { awk '{print $14+$15}' /proc/"$PID"/stat 2>/dev/null; }
c1="$(read_cpu)"; sleep 1; c2="$(read_cpu)"
hz="$(getconf CLK_TCK 2>/dev/null || echo 100)"
if [[ -n "$c1" && -n "$c2" ]]; then
  printf 'process CPU now: %.1f%%\n' "$(awk -v a="$c1" -v b="$c2" -v h="$hz" 'BEGIN{print (b-a)/h*100}')"
fi

say "busiest threads (per-thread %CPU)"
top -b -H -p "$PID" -n 2 -d 1 2>/dev/null \
  | awk 'NR>1 && /[0-9]/' | tail -n +1 \
  | awk '$9+0>0 {print}' \
  | sort -k9 -nr 2>/dev/null | head -n 12 \
  || ps -L -o tid,pcpu,comm -p "$PID"

# --- 2. perf record: top symbols + call graph ------------------------------
PERF="$(command -v perf || true)"
if [[ -n "$PERF" ]]; then
  say "perf record (user-space, dwarf call graph, ${DUR}s)"
  if "$PERF" record -F 999 --call-graph dwarf -p "$PID" -o "$OUT/perf.data" \
       -- sleep "$DUR" 2>"$OUT/perf-record.err"; then
    say "perf: top symbols by self time"
    "$PERF" report -i "$OUT/perf.data" --stdio -g none \
      --sort overhead,dso,symbol --percent-limit 0.5 2>/dev/null \
      | grep -vE '^#' | sed '/^$/d' | head -n 30

    say "perf: hottest call graphs (callees)"
    "$PERF" report -i "$OUT/perf.data" --stdio -g graph,caller,0.5 \
      --percent-limit 2 2>/dev/null | grep -vE '^#' | sed '/^$/d' | head -n 60
  else
    echo "perf record failed; see below (continuing with stack sampler):"
    tail -n 5 "$OUT/perf-record.err"
  fi

  say "perf stat (counts over ${DUR}s)"
  "$PERF" stat -p "$PID" -- sleep "$DUR" 2>&1 | sed '/^$/d'
else
  echo "perf not found; relying on the eu-stack sampler below."
fi

# --- 2b. capture the actual log message (works even if stderr -> /dev/null) -
# The perf call graph for this bug ends in g_log_* inside gsk_renderer_render,
# i.e. GTK logs a warning every frame. When launched by ShojiWM the bar's
# stderr is /dev/null, so the text is invisible. Intercept the log call with
# gdb and print the message template + where it comes from.
GDB="$(command -v gdb || true)"
if [[ -n "$GDB" ]]; then
  say "captured log message (gdb @ g_log_structured_standard / g_logv)"
  echo "(if the process is not currently logging this will time out — that's fine)"
  # AMD64 SysV arg regs: g_log_structured_standard(domain=rdi, level=rsi,
  # file=rdx, line=rcx, func=r8, message_format=r9, ...). g_logv(domain=rdi,
  # level=rsi, format=rdx, ...).
  timeout 25 "$GDB" -q -batch -p "$PID" \
    -ex "set pagination off" -ex "set width 0" \
    -ex "break g_log_structured_standard" \
    -ex "break g_logv" \
    -ex "continue" \
    -ex "printf \"DOMAIN  = %s\\n\", (char*)\$rdi" \
    -ex "printf \"FORMAT  = %s\\n\", \$pc==g_logv ? (char*)\$rdx : (char*)\$r9" \
    -ex "printf \"FILE    = %s\\n\", \$pc==g_logv ? \"?\" : (char*)\$rdx" \
    -ex "printf \"FUNC    = %s\\n\", \$pc==g_logv ? \"?\" : (char*)\$r8" \
    -ex "bt 10" \
    -ex "detach" 2>&1 \
    | grep -vE '^\[Thread|^\[New |Reading symbols|no debugging symbols|^Download|^0x.* in \?\?' \
    | head -n 30
  echo "(FORMAT above = the warning being logged every frame = the root cause)"
fi

# --- 3. eu-stack wall-clock sampler (poor-man's profiler) ------------------
# Repeatedly snapshot every thread's native backtrace and tally the top frame
# of the busiest (running) thread. The most frequent frames = the hot path.
SAMPLER="$(command -v eu-stack || command -v gstack || true)"
if [[ -n "$SAMPLER" ]]; then
  say "stack sampling ($SAMPLER, ~40 samples)"
  : >"$OUT/frames.txt"
  : >"$OUT/raw-stacks.txt"
  for _ in $(seq 1 40); do
    if [[ "$SAMPLER" == *eu-stack ]]; then
      eu-stack -p "$PID" 2>/dev/null
    else
      gstack "$PID" 2>/dev/null
    fi
  done >"$OUT/raw-stacks.txt"

  # Tally function names across all sampled frames (drop addresses/TIDs).
  grep -oE '\b[0-9]+ +0x[0-9a-f]+ +[A-Za-z_][A-Za-z0-9_:.<> ]*' "$OUT/raw-stacks.txt" 2>/dev/null \
    | sed -E 's/^[0-9]+ +0x[0-9a-f]+ +//' \
    >"$OUT/frames.txt"
  # Fallback parse if the above matched nothing (format varies by version).
  if [[ ! -s "$OUT/frames.txt" ]]; then
    grep -oE '0x[0-9a-f]+ +[A-Za-z_].*' "$OUT/raw-stacks.txt" \
      | sed -E 's/^0x[0-9a-f]+ +//' >"$OUT/frames.txt"
  fi

  say "most frequent native frames (hot path)"
  sort "$OUT/frames.txt" | uniq -c | sort -rn | head -n 25

  echo
  echo "one representative full stack saved to: $OUT/raw-stacks.txt"
else
  echo "no eu-stack/gstack available for stack sampling."
fi

say "SUMMARY"
echo "PID $PID — full artifacts in: $OUT"
echo "Look at: 'most frequent native frames' (busy loop signature),"
echo "'perf: top symbols' (GC / regex / JS interp / syscall?), and the"
echo "thread list (which thread spins). Re-run with a PID arg if needed."
