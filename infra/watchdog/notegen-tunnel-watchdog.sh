# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
# See LICENSE and FORK.md.
#
# Watchdog tunnel NoteGen (Fase 1, gelombang 5, spesifikasi-watchdog.md seksi 1).
# Jalan dari VM operator (bukan dari muse-2). Membuktikan jalur publik hidup
# ujung-ke-ujung lewat GET /api/health/ready dengan service token Access.
# Diagnosis mengikuti seksi 1.4: probe internal pembeda SEBELUM restart tunnel.
# Skrip ini TIDAK PERNAH me-restart service compose dan TIDAK PERNAH menyentuh
# layanan lain. Satu-satunya tindakan jarak jauhnya adalah menjalankan launcher
# tunnel idempoten milik NoteGen, maksimal 1 kali per run.
#
# Konfigurasi lewat environment (lihat README di direktori ini). Nilai default
# mengarah ke deployment produksi. Token dibaca dari berkas 0600 khusus dan
# TIDAK PERNAH ditulis ke log, stdout, atau stderr.
#
# Exit code: 0 sehat (atau pulih sesudah tindakan); 1 tetap gagal sesudah
# tindakan / tanpa tindakan yang diizinkan; 2 masalah kredensial tepi atau
# kredensial eksekusi; 3 VM tidak terjangkau. Lihat README untuk rinciannya.

set -u

TAG="tunnel"

# ---------------- Konfigurasi ----------------

PUBLIC_URL="${NOTEGEN_PUBLIC_URL:-https://notegen.synapxs.my.id/api/health/ready}"
TOKEN_FILE="${NOTEGEN_TOKEN_FILE:-$HOME/.config/notegen/service-token}"
PROBE_TIMEOUT="${NOTEGEN_PROBE_TIMEOUT:-25}"
INTERNAL_TIMEOUT="${NOTEGEN_INTERNAL_PROBE_TIMEOUT:-10}"
IB_PY="${NOTEGEN_IB_PY:-$HOME/workspace/custom-connectors/custom.instabox-muse2/bin/ib.py}"
MUSE2_ID="${NOTEGEN_MUSE2_ID:-m_agqydoqzdmqmstatkg6mkqcymi}"
CADDY_PORT="${NOTEGEN_CADDY_PORT:-3200}"
API_PORT="${NOTEGEN_API_PORT:-3001}"
PROJECT_DIR="${NOTEGEN_PROJECT_DIR:-/data/home/note-gen-web}"
COMPOSE_FILE="${NOTEGEN_COMPOSE_FILE:-docker-compose.yml}"
TUNNEL_LAUNCHER="${NOTEGEN_TUNNEL_LAUNCHER:-/data/home/notegen-tunnel/notegen-tunnel.sh}"
LOG_DIR="${NOTEGEN_LOG_DIR:-$HOME/workspace/notegen-watchdog-logs}"
MAINTENANCE_FILE="${NOTEGEN_MAINTENANCE_FILE:-$LOG_DIR/MAINTENANCE}"
DRY_RUN="${NOTEGEN_DRY_RUN:-0}"
REPROBE_WAIT="${NOTEGEN_TUNNEL_REPROBE_WAIT:-15}"
PROBEONLY_AFTER="${NOTEGEN_TUNNEL_PROBEONLY_AFTER:-3}"
MIGRATIONS_REQUIRED="${NOTEGEN_MIGRATIONS_REQUIRED:-1}"
WORKER_DEPLOYED="${NOTEGEN_WORKER_DEPLOYED:-0}"

STATE_DIR="$LOG_DIR/state"
LOCK_FILE="$LOG_DIR/notegen-tunnel-watchdog.lock"
LOG_PREFIX="notegen-tunnel-watchdog"
COUNT_FILE="$STATE_DIR/tunnel-count"
PROBEONLY_FILE="$STATE_DIR/tunnel-probe-only"
PREV_FILE="$STATE_DIR/tunnel-prev"

if [ "$DRY_RUN" = "1" ]; then DRY_RUN=1; else DRY_RUN=0; fi
if [ "$MIGRATIONS_REQUIRED" = "1" ]; then MIGRATIONS_REQUIRED=1; else MIGRATIONS_REQUIRED=0; fi
if [ "$WORKER_DEPLOYED" = "1" ]; then WORKER_DEPLOYED=1; else WORKER_DEPLOYED=0; fi

RUN_START_EPOCH="$(date +%s)"
RUN_START_WIB="$(TZ=Asia/Jakarta date '+%Y-%m-%dT%H:%M:%S%z')"
RUN_START_UTC="$(TZ=UTC date '+%Y-%m-%dT%H:%M:%SZ')"
LOG_FILE="$LOG_DIR/$LOG_PREFIX-$(TZ=Asia/Jakarta date '+%F').log"

# ---------------- Penolong umum ----------------

now_wib() { TZ=Asia/Jakarta date '+%Y-%m-%dT%H:%M:%S%z'; }

log() {
  printf '%s %s %s\n' "$(now_wib)" "$TAG" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

# Redaksi: hapus nilai secret dari teks bebas sebelum dicatat. Pola header
# Access, otorisasi, dan kredensial basis data disamarkan. Fungsi ini hanya
# dipakai untuk teks bebas (output launcher, baris error); ringkasan probe
# tidak pernah memuat body mentah sehingga tidak perlu redaksi.
redact() {
  sed -E -e 's/(CF-Access-Client-(Id|Secret):)[^[:space:]]*/\1 <redacted>/gI' \
    -e 's/(CF-Access-Client-(Id|Secret)=)[^[:space:]&]*/\1<redacted>/gI' \
    -e 's/(Authorization:[[:space:]]*[^[:space:]]+[[:space:]]*)[^[:space:]]*/\1<redacted>/gI' \
    -e 's/(DATABASE_URL=)[^[:space:]]*/\1<redacted>/gI' \
    -e 's/(POSTGRES_PASSWORD=)[^[:space:]]*/\1<redacted>/gI' \
    -e 's/([?&]password=)[^[:space:]&]*/\1<redacted>/gI' 2>/dev/null || true
}

# Samarkan kemunculan nilai token persis (pertahanan lapis kedua). Pola dikutip
# sehingga diperlakukan literal, bukan glob.
scrub_token_values() {
  local s="$1"
  if [ -n "${CID:-}" ]; then s="${s//"$CID"/<redacted>}"; fi
  if [ -n "${SEC:-}" ]; then s="${s//"$SEC"/<redacted>}"; fi
  printf '%s' "$s"
}

# Satu baris teks bebas yang aman dicatat: redaksi + karakter tercetak saja.
safe_line() {
  printf '%s' "$1" | redact | tr -cd '[:print:]\t' | head -c 300
}

is_number() {
  case "$1" in ''|*[!0-9]*) return 1;; *) return 0;; esac
}

# True bila nilai mengandung .. / spasi / titik koma / kutip tunggal.
path_has_bad_chars() {
  case "$1" in *".."*|*" "*|*";"*) return 0;; esac
  case "$1" in *$'\x27'*) return 0;; esac
  return 1
}

# Tulis berkas state secara atomik (tmp + pindah) di dalam direktori state.
write_state_file() {
  local target="$1" content="$2" tmp=""
  tmp="$STATE_DIR/.tmp.$$"
  printf '%s' "$content" > "$tmp" 2>/dev/null || return 1
  mv -f "$tmp" "$target" 2>/dev/null || return 1
  return 0
}

# ---------------- Validator JSON (python3 stdlib) ----------------
# Aturan sehat (spesifikasi seksi 1.2/3.4, brief slot): HTTP 200 + JSON valid
# + ok true + status ready + db ok + workspace ok + migrations ok (bila
# NOTEGEN_MIGRATIONS_REQUIRED=1) + worker ok bila sudah di-deploy
# (NOTEGEN_WORKER_DEPLOYED=1). pgvector non-blokir di Fase 1: gagalnya hanya
# peringatan (seksi 3.5). Field hilang berarti tidak sehat.
# Output: baris VALID/OK/STATUS/FAILED/WARNINGS/PARSE, nilai sudah disanitasi.
PY_VALIDATE="$(cat <<'PYEOF'
import json, sys
code = sys.argv[1]
mig_required = sys.argv[2] == "1"
worker_deployed = sys.argv[3] == "1"
raw = sys.stdin.read()
def safe(v):
    s = str(v)
    out = "".join(ch if (ch.isalnum() or ch in "_.-") else "_" for ch in s)
    return out[:64]
def emit(valid, parse, ok, status, failed, warnings):
    print("VALID=" + ("1" if valid else "0"))
    print("PARSE=" + parse)
    print("OK=" + ("true" if ok is True else "false"))
    print("STATUS=" + safe(status))
    print("FAILED=" + ",".join(failed))
    print("WARNINGS=" + ",".join(warnings))
try:
    data = json.loads(raw)
except Exception:
    emit(False, "not_json", None, "", [], [])
    sys.exit(0)
if not isinstance(data, dict):
    emit(False, "not_object", None, "", [], [])
    sys.exit(0)
ok = data.get("ok")
status = data.get("status")
checks = data.get("checks")
failed = []
warnings = []
valid = True
if code != "200":
    valid = False
if ok is not True:
    valid = False
if status != "ready":
    valid = False
if not isinstance(checks, dict):
    valid = False
    failed.append("checks:missing:-")
else:
    for name in ("db", "workspace", "migrations", "pgvector", "worker"):
        c = checks.get(name)
        if not isinstance(c, dict):
            if name in ("db", "workspace", "migrations"):
                valid = False
                failed.append(name + ":missing:-")
            elif name == "worker" and worker_deployed:
                valid = False
                failed.append(name + ":missing:-")
            continue
        st = c.get("status")
        err = c.get("error")
        code_s = safe(err) if isinstance(err, str) and err else "-"
        if name in ("db", "workspace"):
            if st != "ok":
                valid = False
                failed.append(name + ":" + safe(st) + ":" + code_s)
        elif name == "migrations":
            if st == "ok":
                pass
            elif st == "skipped" and not mig_required:
                warnings.append("migrations_skipped_expected")
            else:
                valid = False
                failed.append(name + ":" + safe(st) + ":" + code_s)
        elif name == "pgvector":
            if st == "fail":
                warnings.append("pgvector_fail_nonblocking")
            elif st not in ("ok", "skipped"):
                warnings.append("pgvector_" + safe(st))
        elif name == "worker":
            if st == "ok":
                pass
            elif st == "skipped":
                if worker_deployed:
                    valid = False
                    failed.append(name + ":skipped:-")
            elif st == "fail":
                if worker_deployed:
                    valid = False
                    failed.append(name + ":fail:" + code_s)
                else:
                    warnings.append("worker_fail_nonblocking")
            else:
                if worker_deployed:
                    valid = False
                    failed.append(name + ":" + safe(st) + ":" + code_s)
                else:
                    warnings.append("worker_" + safe(st))
emit(valid, "json", ok, status, failed, warnings)
PYEOF
)"

# Validator live (seksi 3.1): HTTP 200 + JSON valid + ok true + status live.
PY_VALIDATE_LIVE="$(cat <<'PYEOF'
import json, sys
code = sys.argv[1]
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    print("LIVE_OK=0")
    sys.exit(0)
ok = isinstance(data, dict) and data.get("ok") is True and data.get("status") == "live"
print("LIVE_OK=" + ("1" if (code == "200" and ok) else "0"))
PYEOF
)"

# Ekstraktor payload jarak jauh: ib.py mencetak JSON respons API yang bentuk
# pastinya tidak dikunci di sini. Kumpulkan semua nilai string secara
# rekursif, lalu ambil blok di antara penanda NOTEGEN_WD_BEGIN/END.
# Keluar 1 bila tidak ada blok lengkap.
PY_EXTRACT="$(cat <<'PYEOF'
import json, sys
text = sys.stdin.read()
def find_block(s):
    lines = s.split("\n")
    out = []
    inside = False
    for ln in lines:
        if ln.strip() == "NOTEGEN_WD_BEGIN":
            inside = True
            out = []
            continue
        if ln.strip() == "NOTEGEN_WD_END":
            if inside:
                return out
            continue
        if inside:
            out.append(ln)
    return None
candidates = [text]
try:
    data = json.loads(text)
    strs = []
    def walk(x):
        if isinstance(x, str):
            strs.append(x)
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(data)
    candidates.extend(strs)
    candidates.append("\n".join(strs))
except Exception:
    pass
for c in candidates:
    b = find_block(c)
    if b is not None:
        for ln in b:
            print(ln)
        sys.exit(0)
sys.exit(1)
PYEOF
)"

# Klasifikasi keadaan mesin dari output ib.py get: cari kunci state/status
# secara toleran. Nilai tidak dikenal berarti unknown (fail closed ke
# pelaporan "VM tidak terjangkau" oleh pemanggil).
PY_MACHINE_STATE="$(cat <<'PYEOF'
import json, sys
text = sys.stdin.read()
running = {"running", "online", "active"}
stopped = {"suspended", "paused", "stopped", "stopping", "starting",
           "creating", "terminated", "deleted", "offline", "error", "failed"}
found = []
try:
    data = json.loads(text)
    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if str(k).lower() in ("state", "status", "phase") and isinstance(v, str):
                    found.append(v.strip().lower())
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(data)
except Exception:
    pass
for v in found:
    if v in running:
        print("STATE=running")
        sys.exit(0)
for v in found:
    if v in stopped:
        print("STATE=not_running")
        sys.exit(0)
print("STATE=unknown")
PYEOF
)"

# ---------------- Penyiapan direktori, lock, retensi ----------------

if ! mkdir -p "$LOG_DIR" "$STATE_DIR" 2>/dev/null; then
  echo "notegen-tunnel-watchdog: GAGAL membuat direktori log ($LOG_DIR)" >&2
  exit 1
fi
if ! touch "$LOG_FILE" 2>/dev/null; then
  echo "notegen-tunnel-watchdog: GAGAL menulis berkas log ($LOG_FILE)" >&2
  exit 1
fi

exec 9>"$LOCK_FILE" 2>/dev/null || {
  echo "notegen-tunnel-watchdog: GAGAL membuka lock ($LOCK_FILE)" >&2
  exit 1
}
if ! flock -n 9; then
  log "INFO run dilewati: run sebelumnya masih berjalan, keluar tanpa bertindak"
  echo "notegen-tunnel-watchdog: run sebelumnya masih berjalan, diam (exit 0)"
  exit 0
fi

# Retensi minimum 30 hari (D-W6): hapus log watchdog ini yang lebih tua
# dari 30 hari. Berkas watchdog lain dan berkas state tidak disentuh.
find "$LOG_DIR" -maxdepth 1 -name "$LOG_PREFIX-*.log" -mtime +30 -delete 2>/dev/null || true

MAINTENANCE=0
if [ -e "$MAINTENANCE_FILE" ]; then MAINTENANCE=1; fi

log "INFO run_start utc=$RUN_START_UTC wib=$RUN_START_WIB dry_run=$DRY_RUN maintenance=$MAINTENANCE"

# ---------------- Validasi konfigurasi pra-mulai ----------------
# Kegagalan konfigurasi lokal dipetakan ke exit 1 (run gagal, tanpa tindakan).
# Bukan kredensial (2) dan bukan VM tidak terjangkau (3).

CONFIG_BAD=""
if ! is_number "$PROBE_TIMEOUT" || [ "$PROBE_TIMEOUT" -lt 1 ] || [ "$PROBE_TIMEOUT" -gt 300 ]; then CONFIG_BAD="NOTEGEN_PROBE_TIMEOUT"; fi
if ! is_number "$INTERNAL_TIMEOUT" || [ "$INTERNAL_TIMEOUT" -lt 1 ] || [ "$INTERNAL_TIMEOUT" -gt 120 ]; then CONFIG_BAD="NOTEGEN_INTERNAL_PROBE_TIMEOUT"; fi
if ! is_number "$CADDY_PORT" || [ "$CADDY_PORT" -lt 1 ] || [ "$CADDY_PORT" -gt 65535 ]; then CONFIG_BAD="NOTEGEN_CADDY_PORT"; fi
if ! is_number "$API_PORT" || [ "$API_PORT" -lt 1 ] || [ "$API_PORT" -gt 65535 ]; then CONFIG_BAD="NOTEGEN_API_PORT"; fi
if ! is_number "$REPROBE_WAIT" || [ "$REPROBE_WAIT" -lt 0 ] || [ "$REPROBE_WAIT" -gt 300 ]; then CONFIG_BAD="NOTEGEN_TUNNEL_REPROBE_WAIT"; fi
if ! is_number "$PROBEONLY_AFTER" || [ "$PROBEONLY_AFTER" -lt 1 ]; then CONFIG_BAD="NOTEGEN_TUNNEL_PROBEONLY_AFTER"; fi
case "$PROJECT_DIR" in /*) ;; *) CONFIG_BAD="NOTEGEN_PROJECT_DIR";; esac
if path_has_bad_chars "$PROJECT_DIR"; then CONFIG_BAD="NOTEGEN_PROJECT_DIR"; fi
if path_has_bad_chars "$COMPOSE_FILE"; then CONFIG_BAD="NOTEGEN_COMPOSE_FILE"; fi
case "$COMPOSE_FILE" in /*) CONFIG_BAD="NOTEGEN_COMPOSE_FILE";; esac
case "$TUNNEL_LAUNCHER" in /*) ;; *) CONFIG_BAD="NOTEGEN_TUNNEL_LAUNCHER";; esac
if path_has_bad_chars "$TUNNEL_LAUNCHER"; then CONFIG_BAD="NOTEGEN_TUNNEL_LAUNCHER"; fi
case "$MUSE2_ID" in ''|*[!A-Za-z0-9_-]*) CONFIG_BAD="NOTEGEN_MUSE2_ID";; esac
if [ -n "$CONFIG_BAD" ]; then
  log "ERROR konfigurasi tidak valid: $CONFIG_BAD; tanpa tindakan"
  echo "notegen-tunnel-watchdog: konfigurasi tidak valid ($CONFIG_BAD) (exit 1)"
  exit 1
fi

DIR_Q="$(printf '%q' "$PROJECT_DIR")"
FILE_Q="$(printf '%q' "$COMPOSE_FILE")"
LAUNCHER_Q="$(printf '%q' "$TUNNEL_LAUNCHER")"

# ---------------- State: hitung kegagalan, mode probe-saja, keadaan lalu ----------------

read_count_file() {
  COUNT_N=0
  COUNT_FIRST=""
  if [ -f "$COUNT_FILE" ]; then
    while IFS='=' read -r k v; do
      case "$k" in
        COUNT) if is_number "$v"; then COUNT_N="$v"; fi;;
        FIRST_FAIL) COUNT_FIRST="$v";;
      esac
    done < "$COUNT_FILE"
  fi
}

write_count_file() {
  write_state_file "$COUNT_FILE" "COUNT=$1
FIRST_FAIL=$2
" || log "WARN gagal menulis berkas hitung ($COUNT_FILE)"
}

reset_count_file() {
  write_count_file 0 ""
}

read_prev_file() {
  PREV_VERDICT=""
  PREV_FIRST_FAIL=""
  PREV_ACTION=""
  if [ -f "$PREV_FILE" ]; then
    while IFS='=' read -r k v; do
      case "$k" in
        VERDICT) PREV_VERDICT="$v";;
        FIRST_FAIL) PREV_FIRST_FAIL="$v";;
        ACTION) PREV_ACTION="$v";;
      esac
    done < "$PREV_FILE"
  fi
}

write_prev_file() {
  # $1 verdict, $2 first_fail_epoch (boleh kosong), $3 tindakan terakhir
  local safe_action=""
  safe_action="$(printf '%s' "$3" | tr -cd 'A-Za-z0-9_ .,:/-' | head -c 120)"
  write_state_file "$PREV_FILE" "VERDICT=$1
FIRST_FAIL=$2
ACTION=$safe_action
" || log "WARN gagal menulis berkas keadaan lalu ($PREV_FILE)"
}

# ---------------- Eksekusi jarak jauh lewat ib.py ----------------
# Semua perintah jarak jauh memakai subcommand exec/get saja, dengan --id.
# Perintah jarak jauh selalu diakhiri exit 0 di sisi remote dan membawa
# status aslinya di dalam payload, sehingga exit code ib.py yang bukan nol
# hanya berarti masalah transpor/API/kredensial/VM, bukan hasil probe.

REMOTE_STDOUT=""
REMOTE_STDERR=""
REMOTE_RC=0
REMOTE_PAYLOAD=""
REMOTE_PAYLOAD_OK=0
EXEC_CLASS=""
EXEC_EXIT=1

classify_exec_failure() {
  # Masukan: REMOTE_STDERR. Keluaran: EXEC_CLASS + EXEC_EXIT.
  local lower="" get_out="" get_rc=0 state=""
  lower="$(printf '%s' "$REMOTE_STDERR" | tr 'A-Z' 'a-z')"
  case "$lower" in
    *"http error 401"*|*"http error 403"*|*unauthorized*|*forbidden*|*"invalid api key"*|*authentication*)
      EXEC_CLASS="credential"
      EXEC_EXIT=2
      return 0
      ;;
  esac
  case "$lower" in
    *quota_exceeded*|*"http error 429"*|*"too many requests"*|*operation_conflict*|*"http error 409"*)
      EXEC_CLASS="transient"
      EXEC_EXIT=1
      return 0
      ;;
  esac
  # Bukan kredensial dan bukan batas API: tanyakan keadaan mesin sekali
  # (seksi 5.2) untuk membedakan VM tidak terjangkau dari kegagalan eksekusi.
  local get_err_tmp="" get_err_lower=""
  get_err_tmp="$STATE_DIR/.last-get-stderr.$$"
  get_out="$(python3 "$IB_PY" get --id "$MUSE2_ID" 2>"$get_err_tmp")"
  get_rc=$?
  if [ -f "$get_err_tmp" ]; then
    get_err_lower="$(cat "$get_err_tmp" 2>/dev/null | head -c 500 | tr 'A-Z' 'a-z')"
    rm -f "$get_err_tmp" 2>/dev/null || true
  fi
  case "$get_err_lower" in
    *"http error 401"*|*"http error 403"*|*unauthorized*|*forbidden*|*"invalid api key"*|*authentication*)
      EXEC_CLASS="credential"
      EXEC_EXIT=2
      return 0
      ;;
  esac
  if [ "$get_rc" -eq 0 ]; then
    state="$(printf '%s' "$get_out" | python3 -c "$PY_MACHINE_STATE" 2>/dev/null | sed 's/^STATE=//')"
    if [ "$state" = "running" ]; then
      EXEC_CLASS="transient"
      EXEC_EXIT=1
      return 0
    fi
    if [ "$state" = "not_running" ]; then
      EXEC_CLASS="unreachable"
      EXEC_EXIT=3
      return 0
    fi
  fi
  # Keadaan mesin tidak dapat dipastikan: laporkan sebagai VM tidak
  # terjangkau tanpa mengklaim keadaan mesin (seksi 5.2).
  EXEC_CLASS="unreachable"
  EXEC_EXIT=3
  return 0
}

remote_exec() {
  # $1 timeout detik, $2 perintah remote. Mengisi REMOTE_* + EXEC_*.
  local timeout_s="$1" cmd="$2" err_tmp=""
  REMOTE_STDOUT=""
  REMOTE_STDERR=""
  REMOTE_RC=0
  REMOTE_PAYLOAD=""
  REMOTE_PAYLOAD_OK=0
  EXEC_CLASS=""
  EXEC_EXIT=1
  if [ ! -x "$IB_PY" ]; then
    log "ERROR helper ib.py tidak ditemukan atau tidak executable: $IB_PY; tanpa tindakan"
    EXEC_CLASS="local_tooling"
    EXEC_EXIT=1
    REMOTE_RC=127
    return 1
  fi
  err_tmp="$STATE_DIR/.last-stderr.$$"
  REMOTE_STDOUT="$(python3 "$IB_PY" exec --id "$MUSE2_ID" --cmd "$cmd" --timeout "$timeout_s" 2>"$err_tmp")"
  REMOTE_RC=$?
  if [ -f "$err_tmp" ]; then
    REMOTE_STDERR="$(cat "$err_tmp" 2>/dev/null | head -c 1000)"
    rm -f "$err_tmp" 2>/dev/null || true
  fi
  if [ "$REMOTE_RC" -ne 0 ]; then
    classify_exec_failure
    return 1
  fi
  REMOTE_PAYLOAD="$(printf '%s' "$REMOTE_STDOUT" | python3 -c "$PY_EXTRACT" 2>/dev/null)"
  if [ $? -eq 0 ] && [ -n "$REMOTE_PAYLOAD" ]; then
    REMOTE_PAYLOAD_OK=1
  else
    REMOTE_PAYLOAD=""
    REMOTE_PAYLOAD_OK=0
  fi
  return 0
}

log_exec_failure() {
  # $1 konteks. Mencatat klasifikasi + baris error pertama yang sudah diredaksi.
  local first=""
  first="$(printf '%s' "$REMOTE_STDERR" | head -n 1)"
  first="$(scrub_token_values "$(safe_line "$first")")"
  log "ERROR eksekusi jarak jauh gagal ($1): klasifikasi=$EXEC_CLASS exit=$EXEC_EXIT detail=$first"
}

# ---------------- Probe publik ----------------

CID=""
SEC=""

load_token() {
  local perm="" line=""
  if [ ! -f "$TOKEN_FILE" ]; then
    log "ERROR berkas token tidak ada: $TOKEN_FILE; gagal bersih exit 2 tanpa probe"
    return 2
  fi
  perm="$(stat -c %a "$TOKEN_FILE" 2>/dev/null || echo "?")"
  if [ "$perm" != "600" ]; then
    log "WARN berkas token bukan 0600 (mode=$perm): $TOKEN_FILE"
  fi
  line="$(head -n 1 "$TOKEN_FILE" 2>/dev/null)"
  line="${line%$'\r'}"
  CID="${line%%:*}"
  SEC="${line#*:}"
  case "$line" in *' '*|*$'\t'*) CID=""; SEC="";;
  esac
  if [ -z "$CID" ] || [ -z "$SEC" ] || [ "$CID" = "$line" ]; then
    CID=""
    SEC=""
    log "ERROR format berkas token salah (harus satu baris id:secret); gagal bersih exit 2"
    return 2
  fi
  return 0
}

PUB_CODE=""
PUB_BODY=""
PUB_CURL_RC=0

probe_public() {
  local raw=""
  raw="$(curl -s -m "$PROBE_TIMEOUT" -w "\nNOTEGEN_CODE:%{http_code}" \
    -H "CF-Access-Client-Id: $CID" -H "CF-Access-Client-Secret: $SEC" \
    -H "Cache-Control: no-cache" \
    "$PUBLIC_URL" 2>/dev/null)"
  PUB_CURL_RC=$?
  PUB_CODE="$(printf '%s' "$raw" | tail -n 1 | sed 's/^NOTEGEN_CODE://')"
  case "$PUB_CODE" in
    ''|*[!0-9]*) PUB_CODE="000";;
  esac
  PUB_BODY="$(printf '%s' "$raw" | sed '$d')"
}

# Validasi satu jawaban ready. Masukan: $1 kode HTTP, $2 body. Keluaran:
# V_VALID, V_OK, V_STATUS, V_FAILED, V_WARNINGS, V_PARSE.
validate_ready() {
  local out=""
  V_VALID=0; V_OK=""; V_STATUS=""; V_FAILED=""; V_WARNINGS=""; V_PARSE=""
  out="$(printf '%s' "$2" | python3 -c "$PY_VALIDATE" "$1" "$MIGRATIONS_REQUIRED" "$WORKER_DEPLOYED" 2>/dev/null)"
  while IFS='=' read -r k v; do
    case "$k" in
      VALID) V_VALID="$v";;
      OK) V_OK="$v";;
      STATUS) V_STATUS="$v";;
      FAILED) V_FAILED="$v";;
      WARNINGS) V_WARNINGS="$v";;
      PARSE) V_PARSE="$v";;
    esac
  done <<<"$out"
}

# Validasi satu jawaban live. Masukan: $1 kode HTTP, $2 body. Keluaran: L_OK.
validate_live() {
  local out=""
  L_OK=0
  out="$(printf '%s' "$2" | python3 -c "$PY_VALIDATE_LIVE" "$1" 2>/dev/null)"
  case "$out" in "LIVE_OK=1") L_OK=1;; *) L_OK=0;; esac
}

# ---------------- Akhir run ----------------
# $1 exit code, $2 verdict untuk state, $3 first_fail epoch, $4 tindakan,
# $5 ringkasan satu baris untuk stdout.

finish_run() {
  local code="$1" verdict="$2" first_fail="$3" action="$4" summary="$5"
  local dur=0
  dur=$(( $(date +%s) - RUN_START_EPOCH ))
  write_prev_file "$verdict" "$first_fail" "$action"
  log "INFO run_end exit=$code durasi_detik=$dur verdict=$verdict tindakan=$action"
  echo "notegen-tunnel-watchdog: $summary (exit $code, log: $LOG_FILE)"
  exit "$code"
}

# ---------------- Parse payload jarak jauh ----------------
# Kunci yang dikenal diabaikan bila tidak ada; kunci tak dikenal diabaikan.

parse_payload() {
  CR_CODE=""; CR_BODY=""; CL_CODE=""; CL_BODY=""
  DR_CODE=""; DR_BODY=""; DR_EXEC_RC=""; DL_CODE=""; DL_BODY=""; DL_EXEC_RC=""
  LAUNCHER_EXISTS=""; LAUNCHER_RC=""; LAUNCHER_OUT=""
  while IFS= read -r line; do
    case "$line" in
      CADDY_READY_CODE=*) CR_CODE="${line#CADDY_READY_CODE=}" ;;
      CADDY_READY_BODY=*) CR_BODY="${line#CADDY_READY_BODY=}" ;;
      CADDY_LIVE_CODE=*) CL_CODE="${line#CADDY_LIVE_CODE=}" ;;
      CADDY_LIVE_BODY=*) CL_BODY="${line#CADDY_LIVE_BODY=}" ;;
      DIRECT_READY_CODE=*) DR_CODE="${line#DIRECT_READY_CODE=}" ;;
      DIRECT_READY_BODY=*) DR_BODY="${line#DIRECT_READY_BODY=}" ;;
      DIRECT_READY_EXEC_RC=*) DR_EXEC_RC="${line#DIRECT_READY_EXEC_RC=}" ;;
      DIRECT_LIVE_CODE=*) DL_CODE="${line#DIRECT_LIVE_CODE=}" ;;
      DIRECT_LIVE_BODY=*) DL_BODY="${line#DIRECT_LIVE_BODY=}" ;;
      DIRECT_LIVE_EXEC_RC=*) DL_EXEC_RC="${line#DIRECT_LIVE_EXEC_RC=}" ;;
      LAUNCHER_EXISTS=*) LAUNCHER_EXISTS="${line#LAUNCHER_EXISTS=}" ;;
      LAUNCHER_RC=*) LAUNCHER_RC="${line#LAUNCHER_RC=}" ;;
      LAUNCHER_OUT=*) LAUNCHER_OUT="${line#LAUNCHER_OUT=}" ;;
      *) ;;
    esac
  done <<<"$1"
}

# ---------------- Perintah jarak jauh ----------------
# Perintah dibangun dari templat heredoc (tanpa ekspansi lokal), lalu token
# @@...@@ diganti nilai yang sudah divalidasi/diescape. Perintah jarak jauh
# selalu berakhir exit 0 dan membawa status di dalam payload.

GATHER_TEMPLATE="$(cat <<'REMOTE_EOF'
echo "NOTEGEN_WD_BEGIN"
CR_OUT=$(curl -s -m @@INTERNAL_TIMEOUT@@ -w "\nNOTEGEN_CODE:%{http_code}" "http://127.0.0.1:@@CADDY_PORT@@/api/health/ready" 2>/dev/null || true)
CR_CODE=$(printf '%s' "$CR_OUT" | tail -n 1 | sed 's/^NOTEGEN_CODE://')
case "$CR_CODE" in ''|*[!0-9]*) CR_CODE=000;; esac
CR_BODY=$(printf '%s' "$CR_OUT" | sed '$d' | tr -d '\n\r')
echo "CADDY_READY_CODE=$CR_CODE"
echo "CADDY_READY_BODY=$CR_BODY"
CL_OUT=$(curl -s -m @@INTERNAL_TIMEOUT@@ -w "\nNOTEGEN_CODE:%{http_code}" "http://127.0.0.1:@@CADDY_PORT@@/api/health/live" 2>/dev/null || true)
CL_CODE=$(printf '%s' "$CL_OUT" | tail -n 1 | sed 's/^NOTEGEN_CODE://')
case "$CL_CODE" in ''|*[!0-9]*) CL_CODE=000;; esac
CL_BODY=$(printf '%s' "$CL_OUT" | sed '$d' | tr -d '\n\r')
echo "CADDY_LIVE_CODE=$CL_CODE"
echo "CADDY_LIVE_BODY=$CL_BODY"
if cd @@DIR_Q@@ 2>/dev/null; then
  DR_OUT=$(docker compose -f @@FILE_Q@@ exec -T api node -e "fetch('http://127.0.0.1:@@API_PORT@@/api/health/ready',{signal:AbortSignal.timeout(10000)}).then(async function(r){var t=await r.text();console.log('NOTEGEN_CODE:'+r.status);console.log('NOTEGEN_BODY:'+t.replace(/\n/g,'').replace(/\r/g,''));}).catch(function(){console.log('NOTEGEN_CODE:000');console.log('NOTEGEN_BODY:');});" 2>/dev/null)
  DR_RC=$?
  DL_OUT=$(docker compose -f @@FILE_Q@@ exec -T api node -e "fetch('http://127.0.0.1:@@API_PORT@@/api/health/live',{signal:AbortSignal.timeout(10000)}).then(async function(r){var t=await r.text();console.log('NOTEGEN_CODE:'+r.status);console.log('NOTEGEN_BODY:'+t.replace(/\n/g,'').replace(/\r/g,''));}).catch(function(){console.log('NOTEGEN_CODE:000');console.log('NOTEGEN_BODY:');});" 2>/dev/null)
  DL_RC=$?
else
  DR_OUT=""; DR_RC=127; DL_OUT=""; DL_RC=127
fi
DR_CODE=$(printf '%s' "$DR_OUT" | sed -n 's/^NOTEGEN_CODE://p' | head -n 1)
case "$DR_CODE" in ''|*[!0-9]*) DR_CODE=000;; esac
DR_BODY=$(printf '%s' "$DR_OUT" | sed -n 's/^NOTEGEN_BODY://p' | head -n 1)
echo "DIRECT_READY_CODE=$DR_CODE"
echo "DIRECT_READY_BODY=$DR_BODY"
echo "DIRECT_READY_EXEC_RC=$DR_RC"
DL_CODE=$(printf '%s' "$DL_OUT" | sed -n 's/^NOTEGEN_CODE://p' | head -n 1)
case "$DL_CODE" in ''|*[!0-9]*) DL_CODE=000;; esac
DL_BODY=$(printf '%s' "$DL_OUT" | sed -n 's/^NOTEGEN_BODY://p' | head -n 1)
echo "DIRECT_LIVE_CODE=$DL_CODE"
echo "DIRECT_LIVE_BODY=$DL_BODY"
echo "DIRECT_LIVE_EXEC_RC=$DL_RC"
echo "NOTEGEN_WD_END"
exit 0
REMOTE_EOF
)"

LAUNCH_TEMPLATE="$(cat <<'REMOTE_EOF'
echo "NOTEGEN_WD_BEGIN"
if [ -x @@LAUNCHER_Q@@ ]; then
  echo "LAUNCHER_EXISTS=1"
  L_OUT=$(@@LAUNCHER_Q@@ 2>&1)
  L_RC=$?
  echo "LAUNCHER_RC=$L_RC"
  echo "LAUNCHER_OUT=$(printf '%s' "$L_OUT" | tr '\n' ' ' | head -c 500)"
elif [ -f @@LAUNCHER_Q@@ ]; then
  echo "LAUNCHER_EXISTS=0"
  echo "LAUNCHER_RC=126"
  echo "LAUNCHER_OUT=launcher ada tetapi tidak executable"
else
  echo "LAUNCHER_EXISTS=0"
  echo "LAUNCHER_RC=127"
  echo "LAUNCHER_OUT=launcher tidak ada"
fi
echo "NOTEGEN_WD_END"
exit 0
REMOTE_EOF
)"

build_gather_cmd() {
  local c="$GATHER_TEMPLATE"
  c="${c//@@INTERNAL_TIMEOUT@@/$INTERNAL_TIMEOUT}"
  c="${c//@@CADDY_PORT@@/$CADDY_PORT}"
  c="${c//@@API_PORT@@/$API_PORT}"
  c="${c//@@DIR_Q@@/$DIR_Q}"
  c="${c//@@FILE_Q@@/$FILE_Q}"
  printf '%s' "$c"
}

build_launch_cmd() {
  local c="$LAUNCH_TEMPLATE"
  c="${c//@@LAUNCHER_Q@@/$LAUNCHER_Q}"
  printf '%s' "$c"
}

# ---------------- Transisi keadaan ----------------

note_transition() {
  # $1 verdict baru. Mencatat perubahan keadaan dan laporan pemulihan.
  local dur=0
  if [ "$PREV_VERDICT" = "healthy" ] && [ "$1" != "healthy" ]; then
    log "INFO KEADAAN BERUBAH: sehat -> $1"
  fi
  if [ -n "$PREV_VERDICT" ] && [ "$PREV_VERDICT" != "healthy" ] && [ "$1" = "healthy" ]; then
    if is_number "$PREV_FIRST_FAIL" && [ -n "$PREV_FIRST_FAIL" ]; then
      dur=$(( RUN_START_EPOCH - PREV_FIRST_FAIL ))
      log "INFO PULIH: gagal pertama epoch=$PREV_FIRST_FAIL durasi_detik=$dur tindakan_terakhir=${PREV_ACTION:-tidak ada}"
    else
      log "INFO PULIH: tindakan_terakhir=${PREV_ACTION:-tidak ada} (waktu gagal pertama tidak tercatat)"
    fi
  fi
}

# ---------------- Alur utama ----------------

read_count_file
read_prev_file
EPISODE_FIRST="${PREV_FIRST_FAIL:-$RUN_START_EPOCH}"

# 1. Token: gagal bersih exit 2 bila berkas tidak ada atau salah format.
#    Tanpa token, probe publik tidak dijalankan (probe tanpa token hanya
#    menghasilkan 302/401 yang mengaburkan klasifikasi).
if ! load_token; then
  note_transition "credential"
  finish_run 2 "credential" "$PREV_FIRST_FAIL" "tidak ada" \
    "KREDENSIAL: berkas token tidak ada atau salah format, tanpa probe"
fi

# 2. Probe publik + validasi penuh (seksi 1.2).
probe_public
validate_ready "$PUB_CODE" "$PUB_BODY"
PUB_VALID="$V_VALID"; PUB_OK="$V_OK"; PUB_STATUS="$V_STATUS"
PUB_FAILED="$V_FAILED"; PUB_WARNINGS="$V_WARNINGS"; PUB_PARSE="$V_PARSE"
log "INFO probe_luar http=$PUB_CODE curl_rc=$PUB_CURL_RC ok=$PUB_OK status=$PUB_STATUS parse=$PUB_PARSE gagal=[$PUB_FAILED] peringatan=[$PUB_WARNINGS]"

# 3a. Sehat: diam (kecuali peringatan), reset hitung + mode probe-saja.
if [ "$PUB_VALID" = "1" ]; then
  if [ -n "$PUB_WARNINGS" ]; then
    log "WARN peringatan non-blokir: $PUB_WARNINGS"
  fi
  if [ -f "$PROBEONLY_FILE" ]; then
    rm -f "$PROBEONLY_FILE" 2>/dev/null || true
    log "INFO mode probe-saja berakhir: satu probe sehat tercatat"
  fi
  reset_count_file
  note_transition "healthy"
  if [ -n "$PREV_VERDICT" ] && [ "$PREV_VERDICT" != "healthy" ]; then
    finish_run 0 "healthy" "" "${PREV_ACTION:-pulih sendiri}" "SEHAT kembali (pulih)"
  fi
  finish_run 0 "healthy" "" "tidak ada" "SEHAT"
fi

# 3b. Kredensial tepi (seksi 1.3): 401/403/302. Tanpa restart, tanpa
#     menghubungi muse-2. Hitung kegagalan tidak berubah.
case "$PUB_CODE" in
  401|403|302)
    log "WARN probe_luar http=$PUB_CODE: masalah kredensial tepi (service token); bukan masalah tunnel; tanpa restart, tanpa hubungi muse-2"
    note_transition "credential"
    finish_run 2 "credential" "$PREV_FIRST_FAIL" "tidak ada" \
      "KREDENSIAL TEPI: HTTP $PUB_CODE, tunnel TIDAK direstart"
    ;;
esac

# 4. Gejala kegagalan tunnel ATAU origin: urutan diagnosis seksi 1.4.
#    Langkah pembeda: probe internal SEBELUM keputusan restart apa pun.
GATHER_CMD="$(build_gather_cmd)"
if ! remote_exec 60 "$GATHER_CMD"; then
  log_exec_failure "probe internal pembeda"
  if [ "$EXEC_EXIT" -eq 3 ]; then
    note_transition "unreachable"
    finish_run 3 "unreachable" "$PREV_FIRST_FAIL" "tidak ada" \
      "VM TIDAK TERJANGKAU: probe internal tidak dapat dilakukan, tanpa tindakan"
  elif [ "$EXEC_EXIT" -eq 2 ]; then
    note_transition "credential"
    finish_run 2 "credential" "$PREV_FIRST_FAIL" "tidak ada" \
      "KREDENSIAL EKSEKUSI: eksekusi jarak jauh ditolak, tanpa tindakan"
  else
    note_transition "unhealthy"
    finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada" \
      "EKSEKUSI JARAK JAUH GAGAL: probe internal tidak dapat dilakukan, tanpa tindakan"
  fi
fi
if [ "$REMOTE_PAYLOAD_OK" -ne 1 ]; then
  log "ERROR format respons eksekusi jarak jauh tidak dikenal (blok payload tidak ditemukan); tanpa restart"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada" \
    "PROBE INTERNAL TIDAK DAPAT DITENTUKAN: format respons tidak dikenal, tanpa tindakan"
fi
parse_payload "$REMOTE_PAYLOAD"
validate_ready "$CR_CODE" "$CR_BODY"
CR_VALID="$V_VALID"; CR_FAILED="$V_FAILED"; CR_PARSE="$V_PARSE"; CR_WARNINGS="$V_WARNINGS"
validate_ready "$DR_CODE" "$DR_BODY"
DR_VALID="$V_VALID"; DR_FAILED="$V_FAILED"; DR_PARSE="$V_PARSE"; DR_WARNINGS="$V_WARNINGS"
validate_live "$CL_CODE" "$CL_BODY"; CL_OK="$L_OK"
validate_live "$DL_CODE" "$DL_BODY"; DL_OK="$L_OK"
log "INFO probe_internal caddy_ready http=$CR_CODE valid=$CR_VALID parse=$CR_PARSE gagal=[$CR_FAILED] caddy_live ok=$CL_OK direct_ready http=$DR_CODE exec_rc=$DR_EXEC_RC valid=$DR_VALID parse=$DR_PARSE gagal=[$DR_FAILED] direct_live ok=$DL_OK"

# Putusan internal (seksi 1.4 + AD-133 A1):
# - ready lewat Caddy valid berarti origin sehat lewat jalur Caddy.
# - ready langsung loopback valid + Caddy menjawab 401/403 berarti origin
#   sehat dan jalur Caddy dijaga Access sebagaimana dirancang (probe tanpa
#   token memang ditolak di origin); keduanya berarti origin hidup.
# - ready langsung valid tetapi Caddy gagal non-autentikasi berarti Caddy
#   dicurigai: temuan untuk watchdog compose, tunnel tidak direstart.
# - ready menjawab JSON tidak sehat dari jalur mana pun berarti origin
#   bermasalah: tunnel tidak direstart.
# - Caddy 401/403 tanpa jawaban langsung yang dapat dinilai berarti ambigu:
#   tanpa restart (fail closed).
INTERNAL="failed"
if [ "$CR_VALID" = "1" ]; then
  INTERNAL="healthy"
elif [ "$DR_VALID" = "1" ] && { [ "$CR_CODE" = "401" ] || [ "$CR_CODE" = "403" ]; }; then
  INTERNAL="healthy"
elif [ "$DR_VALID" = "1" ]; then
  INTERNAL="caddy_suspect"
elif [ "$DR_PARSE" = "json" ]; then
  INTERNAL="failed"
elif [ "$CR_PARSE" = "json" ] && [ "$CR_CODE" != "401" ] && [ "$CR_CODE" != "403" ]; then
  INTERNAL="failed"
elif [ "$CR_CODE" = "401" ] || [ "$CR_CODE" = "403" ]; then
  INTERNAL="ambiguous"
else
  INTERNAL="failed"
fi
log "INFO diagnosis_internal=$INTERNAL"

if [ "$INTERNAL" = "caddy_suspect" ]; then
  log "WARN temuan untuk watchdog compose: probe langsung ke API sehat tetapi probe lewat Caddy gagal; Caddy dicurigai; tunnel TIDAK direstart"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada (temuan Caddy)" \
    "ORIGIN HIDUP, CADDY DICURIGAI: tunnel TIDAK direstart"
fi
if [ "$INTERNAL" = "failed" ]; then
  log "INFO probe internal gagal juga: origin bermasalah; tunnel TIDAK direstart; perbaikan diserahkan ke watchdog compose"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada (origin bermasalah)" \
    "ORIGIN BERMASALAH: tunnel TIDAK direstart"
fi
if [ "$INTERNAL" = "ambiguous" ]; then
  log "WARN probe internal ambigu (Caddy menjawab 401/403 tanpa jawaban langsung yang dapat dinilai); tanpa restart"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada (internal ambigu)" \
    "INTERNAL AMBIGU: tanpa restart"
fi

# 5. Internal sehat + luar gagal: diagnosis tunnel mati, origin hidup.
#    Gerbang sebelum restart: MAINTENANCE, mode probe-saja, DRY_RUN.
if [ "$MAINTENANCE" -eq 1 ]; then
  log "INFO MAINTENANCE aktif ($MAINTENANCE_FILE): mode probe-saja, restart tunnel ditunda"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "ditunda (MAINTENANCE)" \
    "TIDAK SEHAT, tindakan ditunda: MAINTENANCE aktif"
fi
if [ -f "$PROBEONLY_FILE" ]; then
  log "INFO mode probe-saja aktif (3 upaya restart gagal berturut-turut): restart tunnel ditunda sampai satu probe sehat atau reset manual"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "ditunda (mode probe-saja)" \
    "TIDAK SEHAT, tindakan ditunda: mode probe-saja aktif"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  log "INFO DRY_RUN: akan menjalankan launcher tunnel ($TUNNEL_LAUNCHER) satu kali; tidak dieksekusi"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "DRY_RUN: akan restart tunnel" \
    "DRY_RUN: tunnel akan direstart (tidak dieksekusi)"
fi

# 6. Satu upaya restart tunnel (seksi 1.5), lalu tunggu 15 detik dan
#    probe luar ulang satu kali. Tanpa loop restart di dalam run ini.
LAUNCH_CMD="$(build_launch_cmd)"
if ! remote_exec 120 "$LAUNCH_CMD"; then
  log_exec_failure "launcher tunnel"
  if [ "$EXEC_EXIT" -eq 3 ]; then
    note_transition "unreachable"
    finish_run 3 "unreachable" "$PREV_FIRST_FAIL" "launcher gagal (VM tidak terjangkau)" \
      "VM TIDAK TERJANGKAU saat menjalankan launcher, hasil restart tidak diketahui"
  elif [ "$EXEC_EXIT" -eq 2 ]; then
    note_transition "credential"
    finish_run 2 "credential" "$PREV_FIRST_FAIL" "launcher gagal (kredensial eksekusi)" \
      "KREDENSIAL EKSEKUSI saat menjalankan launcher, tanpa kepastian restart"
  else
    note_transition "unhealthy"
    finish_run 1 "unhealthy" "$EPISODE_FIRST" "launcher gagal (eksekusi)" \
      "LAUNCHER GAGAL DIEKSEKUSI: hasil restart tidak diketahui, tanpa hitung kegagalan"
  fi
fi
if [ "$REMOTE_PAYLOAD_OK" -ne 1 ]; then
  log "ERROR format respons launcher tidak dikenal (blok payload tidak ditemukan); hasil restart tidak diketahui; tanpa hitung kegagalan"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "launcher: respons tidak dikenal" \
    "LAUNCHER: respons tidak dikenal, hasil restart tidak diketahui"
fi
parse_payload "$REMOTE_PAYLOAD"
if [ "$LAUNCHER_EXISTS" != "1" ]; then
  log "ERROR launcher tunnel belum tersedia di muse-2 ($TUNNEL_LAUNCHER, rc=$LAUNCHER_RC): artefak Q1A belum ada; tanpa restart, tanpa hitung kegagalan"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada (launcher belum tersedia)" \
    "LAUNCHER BELUM TERSEDIA: tunnel tidak dapat direstart"
fi
LAUNCHER_OUT_SAFE="$(scrub_token_values "$(safe_line "$LAUNCHER_OUT")")"
LAUNCH_OUTCOME="tidak diketahui"
case "$LAUNCHER_OUT_SAFE" in
  *"sudah berjalan"*) LAUNCH_OUTCOME="sudah berjalan" ;;
  *"dimulai"*) LAUNCH_OUTCOME="dimulai" ;;
esac
log "INFO launcher rc=$LAUNCHER_RC hasil=$LAUNCH_OUTCOME out=[$LAUNCHER_OUT_SAFE]"

if [ "$REPROBE_WAIT" -gt 0 ]; then
  sleep "$REPROBE_WAIT"
fi
probe_public
validate_ready "$PUB_CODE" "$PUB_BODY"
log "INFO probe_ulang_luar http=$PUB_CODE ok=$V_OK status=$V_STATUS gagal=[$V_FAILED] sesudah tunggu ${REPROBE_WAIT} detik"
if [ "$V_VALID" = "1" ]; then
  if [ -f "$PROBEONLY_FILE" ]; then
    rm -f "$PROBEONLY_FILE" 2>/dev/null || true
  fi
  reset_count_file
  note_transition "healthy"
  finish_run 0 "healthy" "" "restart tunnel ($LAUNCH_OUTCOME)" \
    "PULIH sesudah restart tunnel ($LAUNCH_OUTCOME)"
fi

# Probe ulang tetap gagal: hitung upaya, masuk mode probe-saja sesudah 3
# upaya gagal berturut-turut (D-W1, bacaan seksi 1.5: upaya restart, bukan
# sembarang run gagal; run tanpa upaya tidak menambah hitung).
NEW_COUNT=$(( COUNT_N + 1 ))
if [ "$COUNT_N" -le 0 ] || [ -z "$COUNT_FIRST" ]; then
  COUNT_FIRST="$RUN_START_EPOCH"
fi
write_count_file "$NEW_COUNT" "$COUNT_FIRST"
if [ "$NEW_COUNT" -ge "$PROBEONLY_AFTER" ]; then
  write_state_file "$PROBEONLY_FILE" "SINCE=$RUN_START_EPOCH
COUNT=$NEW_COUNT
" || log "WARN gagal menulis penanda mode probe-saja"
  log "WARN mode probe-saja AKTIF: $NEW_COUNT upaya restart gagal berturut-turut sejak epoch=$COUNT_FIRST; restart ditunda sampai satu probe sehat atau reset manual"
fi
note_transition "unhealthy"
finish_run 1 "unhealthy" "$EPISODE_FIRST" "restart tunnel ($LAUNCH_OUTCOME), probe ulang gagal" \
  "TETAP GAGAL sesudah restart tunnel ($LAUNCH_OUTCOME), upaya gagal berturut-turut=$NEW_COUNT"
