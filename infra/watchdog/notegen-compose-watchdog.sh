#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
# See LICENSE and FORK.md.
#
# Watchdog compose NoteGen (Fase 1, gelombang 5, spesifikasi-watchdog.md seksi 2).
# Jalan dari VM operator (bukan dari muse-2). Membuktikan origin hidup tanpa
# bergantung pada tunnel, dan memperbaiki origin dengan restart terbatas.
# Probe berjalan di muse-2 lewat helper ib.py: ready lewat Caddy internal
# (127.0.0.1:PORT) dan ready langsung loopback di dalam container api
# (AD-133 A1 opsi (a); jalur langsung loopback tidak butuh token).
# Skrip ini satu-satunya watchdog yang boleh me-restart service compose, dan
# hanya service proyek NoteGen, maksimal satu tindakan per run.
#
# Konfigurasi lewat environment (lihat README di direktori ini). Skrip ini
# tidak memakai service token Access dan tidak membaca berkas token apa pun.
# Nilai secret tidak pernah ditulis ke log, stdout, atau stderr.
#
# Exit code: 0 sehat (atau pulih sesudah tindakan); 1 tetap gagal sesudah
# tindakan / tanpa tindakan yang diizinkan; 2 masalah kredensial eksekusi;
# 3 VM tidak terjangkau. Lihat README untuk rinciannya.

set -u

TAG="compose"

# ---------------- Konfigurasi ----------------

IB_PY="${NOTEGEN_IB_PY:-$HOME/workspace/custom-connectors/custom.instabox-muse2/bin/ib.py}"
MUSE2_ID="${NOTEGEN_MUSE2_ID:-m_agqydoqzdmqmstatkg6mkqcymi}"
CADDY_PORT="${NOTEGEN_CADDY_PORT:-3200}"
API_PORT="${NOTEGEN_API_PORT:-3001}"
PROJECT_DIR="${NOTEGEN_PROJECT_DIR:-/data/home/note-gen-web}"
COMPOSE_FILE="${NOTEGEN_COMPOSE_FILE:-docker-compose.yml}"
COMPOSE_OVERRIDE_FILE="${NOTEGEN_COMPOSE_OVERRIDE_FILE:-docker-compose.override.yml}"
ALLOW_SINGLE_FILE="${NOTEGEN_COMPOSE_ALLOW_SINGLE_FILE:-0}"
INTERNAL_TIMEOUT="${NOTEGEN_INTERNAL_PROBE_TIMEOUT:-10}"
LOG_DIR="${NOTEGEN_LOG_DIR:-$HOME/workspace/notegen-watchdog-logs}"
MAINTENANCE_FILE="${NOTEGEN_MAINTENANCE_FILE:-$LOG_DIR/MAINTENANCE}"
DRY_RUN="${NOTEGEN_DRY_RUN:-0}"
POLL_INTERVAL="${NOTEGEN_COMPOSE_POLL_INTERVAL:-15}"
WAIT_SECONDS="${NOTEGEN_COMPOSE_WAIT_SECONDS:-180}"
QUOTA_MAX="${NOTEGEN_MAX_RESTARTS_PER_HOUR:-2}"
QUOTA_WINDOW="${NOTEGEN_QUOTA_WINDOW_SECONDS:-3600}"
RESUME_GRACE_WORKER="${NOTEGEN_RESUME_GRACE_WORKER_SECONDS:-360}"
RESUME_GRACE_GENERAL="${NOTEGEN_RESUME_GRACE_GENERAL_SECONDS:-180}"
MIGRATIONS_REQUIRED="${NOTEGEN_MIGRATIONS_REQUIRED:-1}"
WORKER_DEPLOYED="${NOTEGEN_WORKER_DEPLOYED:-0}"

STATE_DIR="$LOG_DIR/state"
LOCK_FILE="$LOG_DIR/notegen-compose-watchdog.lock"
LOG_PREFIX="notegen-compose-watchdog"
QUOTA_FILE="$STATE_DIR/compose-quotas"
PREV_FILE="$STATE_DIR/compose-prev"
RESUME_FILE="$STATE_DIR/compose-resume"
UNREACHABLE_FILE="$STATE_DIR/compose-unreachable"

if [ "$DRY_RUN" = "1" ]; then DRY_RUN=1; else DRY_RUN=0; fi
if [ "$ALLOW_SINGLE_FILE" = "1" ]; then ALLOW_SINGLE_FILE=1; else ALLOW_SINGLE_FILE=0; fi
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

# Redaksi: hapus nilai secret dari teks bebas sebelum dicatat. Ringkasan
# probe tidak pernah memuat body mentah sehingga tidak perlu redaksi; fungsi
# ini hanya dipakai untuk teks bebas (output perintah jarak jauh, baris error).
redact() {
  sed -E -e 's/(CF-Access-Client-(Id|Secret):)[^[:space:]]*/\1 <redacted>/gI' \
    -e 's/(CF-Access-Client-(Id|Secret)=)[^[:space:]&]*/\1<redacted>/gI' \
    -e 's/(Authorization:[[:space:]]*[^[:space:]]+[[:space:]]*)[^[:space:]]*/\1<redacted>/gI' \
    -e 's/(DATABASE_URL=)[^[:space:]]*/\1<redacted>/gI' \
    -e 's/(POSTGRES_PASSWORD=)[^[:space:]]*/\1<redacted>/gI' \
    -e 's/([?&]password=)[^[:space:]&]*/\1<redacted>/gI' 2>/dev/null || true
}

# Satu baris teks bebas yang aman dicatat: redaksi + karakter tercetak saja.
safe_line() {
  printf '%s' "$1" | redact | tr -cd '[:print:]\t' | head -c 300
}

# Token pengenal yang aman dicatat (nama service, keadaan, kode error).
sanitize_token() {
  printf '%s' "$1" | tr -cd 'A-Za-z0-9_.-' | head -c 64
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
# Aturan sehat (spesifikasi seksi 1.2/2.2/3.4; bacaan seksi 3.1
# laporan pekerja W5-WATCHDOG): CHECKS yang memutuskan. Sehat
# ditentukan oleh checks atas jawaban HTTP 200/503 + JSON valid;
# ok/status tingkat atas TIDAK memveto. Ketidaksesuaian ok/status
# dengan checks dicatat sebagai peringatan envelope_inconsistent,
# bukan vonis tidak sehat. Checks memutuskan dua arah: check blokir
# gagal atau hilang berarti tidak sehat walau ok true. pgvector
# non-blokir di Fase 1 (seksi 3.5); migrations/worker wajib ok bila
# flag-nya menuntut (NOTEGEN_MIGRATIONS_REQUIRED=1 /
# NOTEGEN_WORKER_DEPLOYED=1).
# Kedua skrip wajib menjaga validator ini tetap sama; lihat README.
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
# Keputusan sehat ditentukan oleh CHECKS, bukan oleh veto mentah ok/status/
# kode: API melipat check non-blokir (pgvector seksi 3.5, worker saat
# belum di-deploy) ke dalam ok/status/kode, sehingga veto mentah membuat
# aturan non-blokir mustahil. Kode 200/503 berarti endpoint menjawab
# dengan amplop; kode lain berarti tidak ada jawaban yang dapat dinilai.
# ok/status yang bertentangan dengan checks dicatat sebagai peringatan
# konsistensi amplop, bukan vonis tidak sehat.
valid = True
if code not in ("200", "503"):
    valid = False
    failed.append("http:code:" + safe(code))
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
if valid and (ok is not True or status != "ready"):
    warnings.append("envelope_inconsistent")
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
  echo "notegen-compose-watchdog: GAGAL membuat direktori log ($LOG_DIR)" >&2
  exit 1
fi
if ! touch "$LOG_FILE" 2>/dev/null; then
  echo "notegen-compose-watchdog: GAGAL menulis berkas log ($LOG_FILE)" >&2
  exit 1
fi

exec 9>"$LOCK_FILE" || {
  echo "notegen-compose-watchdog: GAGAL membuka lock ($LOCK_FILE)" >&2
  exit 1
}
if ! flock -n 9; then
  log "INFO run dilewati: run sebelumnya masih berjalan, keluar tanpa bertindak"
  echo "notegen-compose-watchdog: run sebelumnya masih berjalan, diam (exit 0)"
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

CONFIG_BAD=""
if ! is_number "$INTERNAL_TIMEOUT" || [ "$INTERNAL_TIMEOUT" -lt 1 ] || [ "$INTERNAL_TIMEOUT" -gt 120 ]; then CONFIG_BAD="NOTEGEN_INTERNAL_PROBE_TIMEOUT"; fi
if ! is_number "$CADDY_PORT" || [ "$CADDY_PORT" -lt 1 ] || [ "$CADDY_PORT" -gt 65535 ]; then CONFIG_BAD="NOTEGEN_CADDY_PORT"; fi
if ! is_number "$API_PORT" || [ "$API_PORT" -lt 1 ] || [ "$API_PORT" -gt 65535 ]; then CONFIG_BAD="NOTEGEN_API_PORT"; fi
if ! is_number "$POLL_INTERVAL" || [ "$POLL_INTERVAL" -lt 1 ] || [ "$POLL_INTERVAL" -gt 120 ]; then CONFIG_BAD="NOTEGEN_COMPOSE_POLL_INTERVAL"; fi
if ! is_number "$WAIT_SECONDS" || [ "$WAIT_SECONDS" -lt 0 ] || [ "$WAIT_SECONDS" -gt 600 ]; then CONFIG_BAD="NOTEGEN_COMPOSE_WAIT_SECONDS"; fi
if ! is_number "$QUOTA_MAX" || [ "$QUOTA_MAX" -lt 1 ]; then CONFIG_BAD="NOTEGEN_MAX_RESTARTS_PER_HOUR"; fi
if ! is_number "$QUOTA_WINDOW" || [ "$QUOTA_WINDOW" -lt 60 ]; then CONFIG_BAD="NOTEGEN_QUOTA_WINDOW_SECONDS"; fi
if ! is_number "$RESUME_GRACE_WORKER" || [ "$RESUME_GRACE_WORKER" -lt 0 ]; then CONFIG_BAD="NOTEGEN_RESUME_GRACE_WORKER_SECONDS"; fi
if ! is_number "$RESUME_GRACE_GENERAL" || [ "$RESUME_GRACE_GENERAL" -lt 0 ]; then CONFIG_BAD="NOTEGEN_RESUME_GRACE_GENERAL_SECONDS"; fi
case "$PROJECT_DIR" in /*) ;; *) CONFIG_BAD="NOTEGEN_PROJECT_DIR";; esac
if path_has_bad_chars "$PROJECT_DIR"; then CONFIG_BAD="NOTEGEN_PROJECT_DIR"; fi
if path_has_bad_chars "$COMPOSE_FILE"; then CONFIG_BAD="NOTEGEN_COMPOSE_FILE"; fi
case "$COMPOSE_FILE" in /*) CONFIG_BAD="NOTEGEN_COMPOSE_FILE";; esac
if path_has_bad_chars "$COMPOSE_OVERRIDE_FILE"; then CONFIG_BAD="NOTEGEN_COMPOSE_OVERRIDE_FILE"; fi
case "$COMPOSE_OVERRIDE_FILE" in /*) CONFIG_BAD="NOTEGEN_COMPOSE_OVERRIDE_FILE";; esac
if [ "$COMPOSE_OVERRIDE_FILE" = "$COMPOSE_FILE" ]; then CONFIG_BAD="NOTEGEN_COMPOSE_OVERRIDE_FILE"; fi
case "$MUSE2_ID" in ''|*[!A-Za-z0-9_-]*) CONFIG_BAD="NOTEGEN_MUSE2_ID";; esac
if [ -n "$CONFIG_BAD" ]; then
  log "ERROR konfigurasi tidak valid: $CONFIG_BAD; tanpa tindakan"
  echo "notegen-compose-watchdog: konfigurasi tidak valid ($CONFIG_BAD) (exit 1)"
  exit 1
fi

DIR_Q="$(printf '%q' "$PROJECT_DIR")"
BASE_Q="$(printf '%q' "$COMPOSE_FILE")"
OVERRIDE_Q="$(printf '%q' "$COMPOSE_OVERRIDE_FILE")"
if [ "$ALLOW_SINGLE_FILE" -eq 1 ]; then
  FILES_Q="-f $BASE_Q"
  FILES_DESC="-f $COMPOSE_FILE"
else
  FILES_Q="-f $BASE_Q -f $OVERRIDE_Q"
  FILES_DESC="-f $COMPOSE_FILE -f $COMPOSE_OVERRIDE_FILE"
fi
log "INFO compose_files base=$COMPOSE_FILE override=$COMPOSE_OVERRIDE_FILE single_file_allowed=$ALLOW_SINGLE_FILE dir=$PROJECT_DIR"

# ---------------- State: keadaan lalu, resume, kuota ----------------

read_prev_file() {
  PREV_VERDICT=""; PREV_FIRST_FAIL=""; PREV_ACTION=""
  PREV_FINGERPRINT=""; PREV_EXITED_COUNT=""; PREV_FAIL_COUNT=""; PREV_EPOCH=""
  PREV_SIG=""
  if [ -f "$PREV_FILE" ]; then
    while IFS='=' read -r k v; do
      case "$k" in
        VERDICT) PREV_VERDICT="$v";;
        FIRST_FAIL) PREV_FIRST_FAIL="$v";;
        ACTION) PREV_ACTION="$v";;
        FINGERPRINT) PREV_FINGERPRINT="$v";;
        EXITED_COUNT) PREV_EXITED_COUNT="$v";;
        FAIL_COUNT) PREV_FAIL_COUNT="$v";;
        EPOCH) PREV_EPOCH="$v";;
        SIG) PREV_SIG="$v";;
      esac
    done < "$PREV_FILE"
  fi
}

write_prev_file() {
  # $1 verdict, $2 first_fail, $3 tindakan, $4 sidik jari, $5 exited,
  # $6 fail, $7 epoch, $8 signature masalah primer tindakan terakhir.
  local safe_action="" safe_fp="" safe_sig=""
  safe_action="$(printf '%s' "$3" | tr -cd 'A-Za-z0-9_ .,:/-' | head -c 120)"
  safe_fp="$(printf '%s' "$4" | tr -cd 'A-Za-z0-9_,:.-' | head -c 200)"
  safe_sig="$(printf '%s' "$8" | tr -cd 'A-Za-z0-9_:.-' | head -c 80)"
  write_state_file "$PREV_FILE" "VERDICT=$1
FIRST_FAIL=$2
ACTION=$safe_action
FINGERPRINT=$safe_fp
EXITED_COUNT=$5
FAIL_COUNT=$6
EPOCH=$7
SIG=$safe_sig
" || log "WARN gagal menulis berkas keadaan lalu ($PREV_FILE)"
}

read_resume_file() {
  RESUME_AT=""; UP_DONE=0
  if [ -f "$RESUME_FILE" ]; then
    while IFS='=' read -r k v; do
      case "$k" in
        RESUME_AT) RESUME_AT="$v";;
        UP_DONE) if [ "$v" = "1" ]; then UP_DONE=1; fi;;
      esac
    done < "$RESUME_FILE"
  fi
}

write_resume_file() {
  write_state_file "$RESUME_FILE" "RESUME_AT=$RESUME_AT
UP_DONE=$UP_DONE
" || log "WARN gagal menulis berkas resume ($RESUME_FILE)"
}

clear_resume_file() {
  RESUME_AT=""; UP_DONE=0
  rm -f "$RESUME_FILE" 2>/dev/null || true
}

# Jatah restart (seksi 2.5): berkas berisi baris
# service|signature|count|window_start|fingerprint
quota_lookup() {
  # $1 epoch kini, $2 service, $3 signature. Mengisi Q_COUNT, Q_WINDOW_START, Q_FINGERPRINT.
  local now_s="$1" svc="$2" sig="$3"
  Q_COUNT=0; Q_WINDOW_START=""; Q_FINGERPRINT=""
  if [ ! -f "$QUOTA_FILE" ]; then return 0; fi
  while IFS='|' read -r f_svc f_sig f_count f_start f_fp; do
    if [ "$f_svc" = "$svc" ] && [ "$f_sig" = "$sig" ]; then
      if is_number "$f_start" && is_number "$f_count" && [ $(( now_s - f_start )) -lt "$QUOTA_WINDOW" ]; then
        Q_COUNT="$f_count"; Q_WINDOW_START="$f_start"; Q_FINGERPRINT="$f_fp"
      fi
      return 0
    fi
  done < "$QUOTA_FILE"
}

quota_record() {
  # $1 service, $2 signature, $3 fingerprint, $4 epoch kini. Menambah hitung
  # (atau membuka jendela baru bila jendela lama kedaluwarsa).
  local svc="$1" sig="$2" fp="$3" now_s="$4" new_count=1
  local new_start="$now_s"
  local tmp="$STATE_DIR/.quotas.$$" kept=""
  quota_lookup "$now_s" "$svc" "$sig"
  if [ "$Q_COUNT" -gt 0 ]; then
    new_count=$(( Q_COUNT + 1 ))
    new_start="$Q_WINDOW_START"
  fi
  fp="$(printf '%s' "$fp" | tr -cd 'A-Za-z0-9_,:.-' | head -c 200)"
  : > "$tmp" 2>/dev/null || return 1
  if [ -f "$QUOTA_FILE" ]; then
    while IFS='|' read -r f_svc f_sig f_count f_start f_fp; do
      if [ -n "$f_svc" ] && { [ "$f_svc" != "$svc" ] || [ "$f_sig" != "$sig" ]; }; then
        if is_number "$f_start" && [ $(( now_s - f_start )) -lt "$QUOTA_WINDOW" ]; then
          printf '%s|%s|%s|%s|%s\n' "$f_svc" "$f_sig" "$f_count" "$f_start" "$f_fp" >> "$tmp"
        fi
      fi
    done < "$QUOTA_FILE"
  fi
  printf '%s|%s|%s|%s|%s\n' "$svc" "$sig" "$new_count" "$new_start" "$fp" >> "$tmp"
  mv -f "$tmp" "$QUOTA_FILE" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 1; }
  kept="$new_count"
  log "INFO jatah restart: service=$svc signature=$sig hitung=$kept/$QUOTA_MAX jendela_detik=$QUOTA_WINDOW"
  return 0
}

quota_clear_all() {
  write_state_file "$QUOTA_FILE" "" || log "WARN gagal membersihkan berkas jatah"
}

# ---------------- Eksekusi jarak jauh lewat ib.py ----------------
# Sama seperti watchdog tunnel: hanya subcommand exec/get dengan --id.
# Perintah jarak jauh selalu berakhir exit 0 di sisi remote dan membawa
# status aslinya di dalam payload.

REMOTE_STDOUT=""
REMOTE_STDERR=""
REMOTE_RC=0
REMOTE_PAYLOAD=""
REMOTE_PAYLOAD_OK=0
EXEC_CLASS=""
EXEC_EXIT=1

classify_exec_failure() {
  local lower="" get_out="" get_rc=0 state=""
  lower="$(printf '%s' "$REMOTE_STDERR" | tr 'A-Z' 'a-z')"
  case "$lower" in
    *"http error 401"*|*"http error 403"*|*unauthorized*|*forbidden*|*"invalid api key"*|*authentication*)
      EXEC_CLASS="credential"
      EXEC_EXIT=2
      return 0
      ;;
  esac
  # Bukan kredensial: tanyakan keadaan mesin sekali (seksi 5.2) untuk
  # membedakan VM tidak terjangkau dari kegagalan eksekusi. Keadaan mesin
  # didahulukan atas kata kunci error, karena kode yang sama (mis. 409)
  # dapat berarti konflik operasi ATAU mesin tidak jalan.
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
  # Get gagal atau keadaannya tidak dikenal: pakai kata kunci error sebagai
  # cadangan. Batas API/konflik operasi berarti transient; sisanya
  # dilaporkan sebagai VM tidak terjangkau (seksi 5.2).
  case "$lower" in
    *quota_exceeded*|*"http error 429"*|*"too many requests"*|*operation_conflict*)
      EXEC_CLASS="transient"
      EXEC_EXIT=1
      return 0
      ;;
  esac
  EXEC_CLASS="unreachable"
  EXEC_EXIT=3
  return 0
}

remote_exec() {
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
  local first=""
  first="$(printf '%s' "$REMOTE_STDERR" | head -n 1)"
  first="$(safe_line "$first")"
  log "ERROR eksekusi jarak jauh gagal ($1): klasifikasi=$EXEC_CLASS exit=$EXEC_EXIT detail=$first"
}

# ---------------- Validator ----------------

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

validate_live() {
  local out=""
  L_OK=0
  out="$(printf '%s' "$2" | python3 -c "$PY_VALIDATE_LIVE" "$1" 2>/dev/null)"
  case "$out" in "LIVE_OK=1") L_OK=1;; *) L_OK=0;; esac
}

# ---------------- Akhir run ----------------
# $1 exit code, $2 verdict, $3 first_fail, $4 tindakan, $5 sidik jari,
# $6 exited, $7 fail, $8 ringkasan stdout. Signature masalah primer (SIG)
# dibaca dari global SAVE_SIG: dipertahankan dari run lalu kecuali run ini
# mengeksekusi tindakan (diisi PRIMARY_SIG) atau sehat penuh (dikosongkan).

SAVE_SIG=""

finish_run() {
  local code="$1" verdict="$2" first_fail="$3" action="$4" fp="$5"
  local exited="$6" failc="$7" summary="$8" dur=0
  dur=$(( $(date +%s) - RUN_START_EPOCH ))
  write_prev_file "$verdict" "$first_fail" "$action" "$fp" "$exited" "$failc" "$RUN_START_EPOCH" "$SAVE_SIG"
  log "INFO run_end exit=$code durasi_detik=$dur verdict=$verdict tindakan=$action"
  echo "notegen-compose-watchdog: $summary (exit $code, log: $LOG_FILE)"
  exit "$code"
}

note_transition() {
  # $1 verdict baru. Mencatat perubahan keadaan dan laporan pemulihan.
  # Verdict "grace" bersifat netral: bukan pulih dan bukan memburuk.
  local dur=0
  if [ "$1" = "grace" ]; then return 0; fi
  if [ "$PREV_VERDICT" = "healthy" ] && [ "$1" != "healthy" ]; then
    log "INFO KEADAAN BERUBAH: sehat -> $1"
  fi
  if [ -n "$PREV_VERDICT" ] && [ "$PREV_VERDICT" != "healthy" ] && [ "$PREV_VERDICT" != "grace" ] && [ "$1" = "healthy" ]; then
    if is_number "$PREV_FIRST_FAIL" && [ -n "$PREV_FIRST_FAIL" ]; then
      dur=$(( RUN_START_EPOCH - PREV_FIRST_FAIL ))
      log "INFO PULIH: gagal pertama epoch=$PREV_FIRST_FAIL durasi_detik=$dur tindakan_terakhir=${PREV_ACTION:-tidak ada}"
    else
      log "INFO PULIH: tindakan_terakhir=${PREV_ACTION:-tidak ada} (waktu gagal pertama tidak tercatat)"
    fi
  fi
}

# ---------------- Perintah jarak jauh ----------------
# Templat heredoc tanpa ekspansi lokal; token @@...@@ diganti nilai yang
# sudah divalidasi/diescape. Semua perintah bercakupan proyek NoteGen
# (cd ke direktori proyek + berkas compose proyek). Perintah jarak jauh
# selalu berakhir exit 0 dan membawa status di dalam payload.
# Bentuk pemanggilan kanonis adalah dua berkas: -f dasar -f override
# (F-ABC-A1/AD-195: satu -f menjatuhkan pemuatan otomatis override dan
# image terurai ke PLACEHOLDER_TAG). Setiap templat memeriksa keberadaan
# kedua berkas di remote sebelum memanggil compose dan melaporkan
# COMPOSE_GUARD/ACTION_GUARD; override yang hilang menolak tindakan
# secara keras, tidak pernah dijatuhkan diam-diam. Tindakan up juga
# ditolak bila konfigurasi terurai masih memuat PLACEHOLDER_TAG.
# Bentuk satu berkas hanya lewat NOTEGEN_COMPOSE_ALLOW_SINGLE_FILE=1
# yang eksplisit dan tercatat di log; penolakan placeholder untuk up
# tetap berlaku pada bentuk itu.

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
COMPOSE_GUARD=ok
if cd @@DIR_Q@@ 2>/dev/null; then
  if [ ! -f @@BASE_Q@@ ]; then COMPOSE_GUARD=missing_base
  elif [ @@ALLOW_SINGLE@@ -ne 1 ] && [ ! -f @@OVERRIDE_Q@@ ]; then COMPOSE_GUARD=missing_override
  fi
  if [ "$COMPOSE_GUARD" = "ok" ]; then
  DR_OUT=$(docker compose @@FILES_Q@@ exec -T api node -e "fetch('http://127.0.0.1:@@API_PORT@@/api/health/ready',{signal:AbortSignal.timeout(@@INTERNAL_TIMEOUT@@*1000)}).then(async function(r){var t=await r.text();console.log('NOTEGEN_CODE:'+r.status);console.log('NOTEGEN_BODY:'+t.replace(/\n/g,'').replace(/\r/g,''));}).catch(function(){console.log('NOTEGEN_CODE:000');console.log('NOTEGEN_BODY:');});" 2>/dev/null)
  DR_RC=$?
  DL_OUT=$(docker compose @@FILES_Q@@ exec -T api node -e "fetch('http://127.0.0.1:@@API_PORT@@/api/health/live',{signal:AbortSignal.timeout(@@INTERNAL_TIMEOUT@@*1000)}).then(async function(r){var t=await r.text();console.log('NOTEGEN_CODE:'+r.status);console.log('NOTEGEN_BODY:'+t.replace(/\n/g,'').replace(/\r/g,''));}).catch(function(){console.log('NOTEGEN_CODE:000');console.log('NOTEGEN_BODY:');});" 2>/dev/null)
  DL_RC=$?
  PS_OUT=$(docker compose @@FILES_Q@@ ps --format '{{.Service}}|{{.State}}|{{.Health}}|{{.Name}}' 2>/dev/null)
  PS_RC=$?
  else
    DR_OUT=""; DR_RC=127; DL_OUT=""; DL_RC=127; PS_OUT=""; PS_RC=127
  fi
else
  COMPOSE_GUARD=no_project_dir
  DR_OUT=""; DR_RC=127; DL_OUT=""; DL_RC=127; PS_OUT=""; PS_RC=127
fi
echo "COMPOSE_GUARD=$COMPOSE_GUARD"
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
echo "PS_RC=$PS_RC"
printf '%s\n' "$PS_OUT" | while IFS= read -r ln; do if [ -n "$ln" ]; then echo "PS_SVC=$ln"; fi; done
echo "NOTEGEN_WD_END"
exit 0
REMOTE_EOF
)"

DIAGNOSE_TEMPLATE="$(cat <<'REMOTE_EOF'
echo "NOTEGEN_WD_BEGIN"
COMPOSE_GUARD=ok
if cd @@DIR_Q@@ 2>/dev/null; then
  if [ ! -f @@BASE_Q@@ ]; then COMPOSE_GUARD=missing_base
  elif [ @@ALLOW_SINGLE@@ -ne 1 ] && [ ! -f @@OVERRIDE_Q@@ ]; then COMPOSE_GUARD=missing_override
  fi
  if [ "$COMPOSE_GUARD" = "ok" ]; then
  PG_OUT=$(docker compose @@FILES_Q@@ exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1)
  PG_RC=$?
  WS_OUT=$(docker compose @@FILES_Q@@ exec -T api sh -c 'd="$WORKSPACE_ROOT"; ls -ld "$d" 2>&1; test -d "$d" && echo IS_DIR=1 || echo IS_DIR=0; test -r "$d" && echo READ=1 || echo READ=0; test -w "$d" && echo WRITE=1 || echo WRITE=0' 2>&1)
  WS_RC=$?
  else
    PG_OUT=""; PG_RC=127; WS_OUT=""; WS_RC=127
  fi
else
  COMPOSE_GUARD=no_project_dir
  PG_OUT=""; PG_RC=127; WS_OUT=""; WS_RC=127
fi
echo "COMPOSE_GUARD=$COMPOSE_GUARD"
echo "PG_RC=$PG_RC"
echo "PG_OUT=$(printf '%s' "$PG_OUT" | tr '\n' ' ' | head -c 300)"
echo "WS_RC=$WS_RC"
echo "WS_OUT=$(printf '%s' "$WS_OUT" | tr '\n' ' ' | head -c 300)"
echo "NOTEGEN_WD_END"
exit 0
REMOTE_EOF
)"

ACTION_TEMPLATE="$(cat <<'REMOTE_EOF'
echo "NOTEGEN_WD_BEGIN"
ACTION_GUARD=ok
if cd @@DIR_Q@@ 2>/dev/null; then
  if [ ! -f @@BASE_Q@@ ]; then ACTION_GUARD=missing_base
  elif [ @@ALLOW_SINGLE@@ -ne 1 ] && [ ! -f @@OVERRIDE_Q@@ ]; then ACTION_GUARD=missing_override
  elif [ @@REQUIRE_PLACEHOLDER_CHECK@@ -eq 1 ]; then
    # Keluaran config hanya diuji polanya; tidak pernah dicatat.
    CFG_OUT=$(docker compose @@FILES_Q@@ config 2>/dev/null); CFG_RC=$?
    if [ "$CFG_RC" -ne 0 ]; then ACTION_GUARD=config_unresolved
    elif printf '%s' "$CFG_OUT" | grep -q 'PLACEHOLDER_TAG'; then ACTION_GUARD=placeholder_image
    fi
    CFG_OUT=""
  fi
  if [ "$ACTION_GUARD" = "ok" ]; then
    A_OUT=$(docker compose @@FILES_Q@@ @@ACTION_LINE@@ 2>&1)
    A_RC=$?
  else
    A_OUT="tindakan ditolak guard compose"
    A_RC=124
  fi
else
  ACTION_GUARD=no_project_dir
  A_OUT="direktori proyek tidak ada"
  A_RC=127
fi
echo "ACTION_GUARD=$ACTION_GUARD"
echo "ACTION_RC=$A_RC"
echo "ACTION_OUT=$(printf '%s' "$A_OUT" | tr '\n' ' ' | head -c 500)"
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
  c="${c//@@BASE_Q@@/$BASE_Q}"
  c="${c//@@OVERRIDE_Q@@/$OVERRIDE_Q}"
  c="${c//@@FILES_Q@@/$FILES_Q}"
  c="${c//@@ALLOW_SINGLE@@/$ALLOW_SINGLE_FILE}"
  printf '%s' "$c"
}

build_diagnose_cmd() {
  local c="$DIAGNOSE_TEMPLATE"
  c="${c//@@DIR_Q@@/$DIR_Q}"
  c="${c//@@BASE_Q@@/$BASE_Q}"
  c="${c//@@OVERRIDE_Q@@/$OVERRIDE_Q}"
  c="${c//@@FILES_Q@@/$FILES_Q}"
  c="${c//@@ALLOW_SINGLE@@/$ALLOW_SINGLE_FILE}"
  printf '%s' "$c"
}

# $1 baris aksi allowlist (mis. "restart api", "up -d", "up -d api").
build_action_cmd() {
  local c="$ACTION_TEMPLATE"
  local require_check=0
  case "$1" in up*) require_check=1;; *) require_check=0;; esac
  c="${c//@@DIR_Q@@/$DIR_Q}"
  c="${c//@@BASE_Q@@/$BASE_Q}"
  c="${c//@@OVERRIDE_Q@@/$OVERRIDE_Q}"
  c="${c//@@FILES_Q@@/$FILES_Q}"
  c="${c//@@ALLOW_SINGLE@@/$ALLOW_SINGLE_FILE}"
  c="${c//@@REQUIRE_PLACEHOLDER_CHECK@@/$require_check}"
  c="${c//@@ACTION_LINE@@/$1}"
  printf '%s' "$c"
}

# ---------------- Parse payload + status container ----------------

parse_payload() {
  CR_CODE=""; CR_BODY=""; CL_CODE=""; CL_BODY=""
  DR_CODE=""; DR_BODY=""; DR_EXEC_RC=""; DL_CODE=""; DL_BODY=""; DL_EXEC_RC=""
  PS_RC=""; PS_LINES=""
  PG_RC=""; PG_OUT=""; WS_RC=""; WS_OUT=""
  ACTION_RC=""; ACTION_OUT=""
  COMPOSE_GUARD=""
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
      PS_RC=*) PS_RC="${line#PS_RC=}" ;;
      PS_SVC=*) PS_LINES="$PS_LINES
${line#PS_SVC=}" ;;
      PG_RC=*) PG_RC="${line#PG_RC=}" ;;
      PG_OUT=*) PG_OUT="${line#PG_OUT=}" ;;
      WS_RC=*) WS_RC="${line#WS_RC=}" ;;
      WS_OUT=*) WS_OUT="${line#WS_OUT=}" ;;
      ACTION_RC=*) ACTION_RC="${line#ACTION_RC=}" ;;
      ACTION_OUT=*) ACTION_OUT="${line#ACTION_OUT=}" ;;
      COMPOSE_GUARD=*) COMPOSE_GUARD="${line#COMPOSE_GUARD=}" ;;
      *) ;;
    esac
  done <<<"$1"
  case "$COMPOSE_GUARD" in
    ok|missing_base|missing_override|no_project_dir) ;;
    *) COMPOSE_GUARD="tidak_dikenal" ;;
  esac
}

# Keadaan service: ST_caddy/ST_web/ST_api/ST_postgres/ST_worker,
# kesehatan: HE_caddy/HE_web/HE_api/HE_postgres/HE_worker.
# PS_OK=1 bila status berhasil dibaca (termasuk proyek kosong: semua
# service inti berstatus "missing"). WORKER_EXISTS=1 bila ada baris worker.
parse_ps() {
  ST_caddy=""; ST_web=""; ST_api=""; ST_postgres=""; ST_worker=""
  HE_caddy=""; HE_web=""; HE_api=""; HE_postgres=""; HE_worker=""
  WORKER_EXISTS=0; PS_OK=0
  EXITED_LIST=""; EXITED_COUNT=0
  local svc="" st="" he="" rest="" field1="" field2="" field3=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    field1="${line%%|*}"; rest="${line#*|}"
    field2="${rest%%|*}"; rest="${rest#*|}"
    field3="${rest%%|*}"
    svc="$(sanitize_token "$field1")"
    st="$(sanitize_token "$field2")"
    he="$(sanitize_token "$field3")"
    case "$svc" in
      caddy) ST_caddy="$st"; HE_caddy="$he";;
      web) ST_web="$st"; HE_web="$he";;
      api) ST_api="$st"; HE_api="$he";;
      postgres) ST_postgres="$st"; HE_postgres="$he";;
      worker) ST_worker="$st"; HE_worker="$he"; WORKER_EXISTS=1;;
      *) ;;
    esac
  done <<<"$PS_LINES"
  if [ "$PS_RC" = "0" ]; then
    PS_OK=1
    [ -z "$ST_caddy" ] && ST_caddy="missing"
    [ -z "$ST_web" ] && ST_web="missing"
    [ -z "$ST_api" ] && ST_api="missing"
    [ -z "$ST_postgres" ] && ST_postgres="missing"
    if [ "$WORKER_EXISTS" -eq 0 ]; then ST_worker="absent"; fi
  else
    PS_OK=0
    [ -z "$ST_caddy" ] && ST_caddy="unknown"
    [ -z "$ST_web" ] && ST_web="unknown"
    [ -z "$ST_api" ] && ST_api="unknown"
    [ -z "$ST_postgres" ] && ST_postgres="unknown"
    if [ "$WORKER_EXISTS" -eq 0 ]; then ST_worker="unknown"; fi
  fi
  if [ "$PS_OK" -eq 1 ]; then
    for svc in caddy web api postgres; do
      case "$svc" in
        caddy) st="$ST_caddy";;
        web) st="$ST_web";;
        api) st="$ST_api";;
        postgres) st="$ST_postgres";;
      esac
      case "$st" in
        exited|dead|created|paused|missing)
          if [ -z "$EXITED_LIST" ]; then EXITED_LIST="$svc"; else EXITED_LIST="$EXITED_LIST,$svc"; fi
          EXITED_COUNT=$(( EXITED_COUNT + 1 ))
          ;;
      esac
    done
    if [ "$WORKER_EXISTS" -eq 1 ]; then
      case "$ST_worker" in
        exited|dead|created|paused|missing)
          if [ -z "$EXITED_LIST" ]; then EXITED_LIST="worker"; else EXITED_LIST="$EXITED_LIST,worker"; fi
          EXITED_COUNT=$(( EXITED_COUNT + 1 ))
          ;;
      esac
    fi
  fi
}

service_state() {
  case "$1" in
    caddy) printf '%s' "$ST_caddy";;
    web) printf '%s' "$ST_web";;
    api) printf '%s' "$ST_api";;
    postgres) printf '%s' "$ST_postgres";;
    worker) printf '%s' "$ST_worker";;
    *) printf '%s' "unknown";;
  esac
}

# ---------------- Putusan (verdict) ----------------
# Masukan: hasil validasi + status container. Keluaran: VERDICT
# (healthy/unhealthy), AUTH_FAILED, AUTH_SOURCE, CADDY_SUSPECT,
# PROCESS_DOWN, DIAG_BLOCKED, LIVE_OK, WEB_BAD, WORKER_DOWN,
# FAIL_COUNT, VERDICT_FINGERPRINT. Putusan ini KETAT (tanpa tenggang);
# tenggang worker diterapkan terpisah oleh apply_worker_grace.

compute_verdict() {
  VERDICT="unhealthy"; AUTH_FAILED=""; AUTH_SOURCE=""
  CADDY_SUSPECT=0; PROCESS_DOWN=0; DIAG_BLOCKED=0; LIVE_OK=0
  WEB_BAD=0; WORKER_DOWN=0; FAIL_COUNT=0; VERDICT_FINGERPRINT=""; PRIMARY_SIG=""
  local caddy_gated=0 _first="" _c="" _s="" _code=""
  if [ "$CL_OK" -eq 1 ] || [ "$DL_OK" -eq 1 ]; then LIVE_OK=1; fi
  case "$CR_CODE" in 401|403) caddy_gated=1;; esac
  if [ "$CR_VALID" = "1" ]; then
    VERDICT="healthy"; AUTH_SOURCE="caddy"
  elif [ "$DR_VALID" = "1" ] && [ "$caddy_gated" -eq 1 ]; then
    VERDICT="healthy"; AUTH_SOURCE="direct"
  elif [ "$DR_VALID" = "1" ]; then
    VERDICT="unhealthy"; AUTH_SOURCE="direct"; CADDY_SUSPECT=1
  elif [ "$DR_PARSE" = "json" ]; then
    VERDICT="unhealthy"; AUTH_SOURCE="direct"; AUTH_FAILED="$DR_FAILED"
  elif [ "$CR_PARSE" = "json" ] && [ "$caddy_gated" -eq 0 ]; then
    VERDICT="unhealthy"; AUTH_SOURCE="caddy"; AUTH_FAILED="$CR_FAILED"
  elif [ "$caddy_gated" -eq 1 ]; then
    VERDICT="unhealthy"; AUTH_SOURCE=""; AUTH_FAILED="ready:unknown:DIRECT_PROBE_UNAVAILABLE"
    DIAG_BLOCKED=1
  else
    VERDICT="unhealthy"; AUTH_SOURCE=""
    AUTH_FAILED="ready:unknown:NO_JSON"
    if [ "$LIVE_OK" -eq 0 ]; then
      PROCESS_DOWN=1
    else
      DIAG_BLOCKED=1
    fi
  fi
  if [ -n "$AUTH_FAILED" ]; then
    FAIL_COUNT="$(printf '%s' "$AUTH_FAILED" | tr -cd ',' | wc -c)"
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  else
    FAIL_COUNT=0
  fi
  if [ "$PS_OK" -eq 1 ]; then
    case "$ST_web" in
      exited|dead|created|paused|missing) WEB_BAD=1;;
      running)
        if [ "$HE_web" = "unhealthy" ]; then WEB_BAD=1; fi
        ;;
    esac
    if [ "$WORKER_EXISTS" -eq 1 ]; then
      case "$ST_worker" in
        exited|dead|created|paused|missing) WORKER_DOWN=1;;
      esac
    fi
  fi
  # Pemisah "_exited_" (bukan "|"): sidik jari disimpan di berkas kuota
  # yang memakai "|" sebagai pemisah field, dan sanitizer state membuang
  # "|"; pemisah ini menjamin sidik jari tersimpan sama dengan sidik jari
  # live sehingga aturan ketat dapat membandingkannya.
  if [ "$CADDY_SUSPECT" -eq 1 ]; then
    VERDICT_FINGERPRINT="caddy_suspect_exited_$EXITED_LIST"
  elif [ "$PROCESS_DOWN" -eq 1 ]; then
    VERDICT_FINGERPRINT="process_down_exited_$EXITED_LIST"
  else
    VERDICT_FINGERPRINT="${AUTH_FAILED}_exited_$EXITED_LIST"
  fi
  # Signature masalah primer: identitas masalah yang STABIL saat kegagalan
  # meluas (dipakai pemicu (b)/(c) seksi 2.4). Berbeda dari sidik jari
  # penuh yang berubah bila daftar gagal/daftar exited berubah.
  if [ "$CADDY_SUSPECT" -eq 1 ]; then
    PRIMARY_SIG="caddy:CADDY_PROBE_FAIL"
  elif [ "$PROCESS_DOWN" -eq 1 ]; then
    PRIMARY_SIG="api:PROCESS_DOWN"
  elif [ "$VERDICT" = "healthy" ]; then
    PRIMARY_SIG="healthy"
  elif [ -n "$AUTH_FAILED" ]; then
    _first="${AUTH_FAILED%%,*}"
    _c="${_first%%:*}"; _s="${_first#*:}"; _code="${_s#*:}"
    PRIMARY_SIG="$_c:$_code"
  else
    PRIMARY_SIG="unknown:NO_FAILED_CHECKS"
  fi
}

# Kode error untuk satu check dari AUTH_FAILED (entri check:status:code).
# Mengisi CHECK_CODE (kosong bila check tidak gagal).
check_code() {
  local want="$1" rest="$AUTH_FAILED" entry="" c="" s="" code=""
  CHECK_CODE=""
  while [ -n "$rest" ]; do
    case "$rest" in
      *,*) entry="${rest%%,*}"; rest="${rest#*,}";;
      *) entry="$rest"; rest="";;
    esac
    c="${entry%%:*}"
    if [ "$c" = "$want" ]; then
      s="${entry#*:}"
      code="${s#*:}"
      CHECK_CODE="$code"
      return 0
    fi
  done
}

all_failed_are_worker() {
  [ -n "$AUTH_FAILED" ] || return 1
  local rest="$AUTH_FAILED" entry=""
  while [ -n "$rest" ]; do
    case "$rest" in
      *,*) entry="${rest%%,*}"; rest="${rest#*,}";;
      *) entry="$rest"; rest="";;
    esac
    case "$entry" in worker:*) ;; *) return 1;; esac
  done
  return 0
}

# ---------------- Masa tenggang pasca-resume (D-W2, seksi 5.3) ----------------

GRACE_WORKER_ACTIVE=0
GRACE_GENERAL_ACTIVE=0

update_grace_flags() {
  local now_s="$(date +%s)"
  GRACE_WORKER_ACTIVE=0; GRACE_GENERAL_ACTIVE=0
  if is_number "$RESUME_AT" && [ -n "$RESUME_AT" ]; then
    if [ "$now_s" -lt $(( RESUME_AT + RESUME_GRACE_WORKER )) ]; then GRACE_WORKER_ACTIVE=1; fi
    if [ "$now_s" -lt $(( RESUME_AT + RESUME_GRACE_GENERAL )) ]; then GRACE_GENERAL_ACTIVE=1; fi
  fi
}

# Bila satu-satunya kegagalan adalah worker dan masa tenggang worker aktif,
# worker TIDAK dinyatakan bermasalah: verdict menjadi "grace" (netral).
apply_worker_grace() {
  if [ "$VERDICT" = "unhealthy" ] && [ "$CADDY_SUSPECT" -eq 0 ] && [ "$PROCESS_DOWN" -eq 0 ] && [ "$DIAG_BLOCKED" -eq 0 ]; then
    if [ "$GRACE_WORKER_ACTIVE" -eq 1 ] && all_failed_are_worker; then
      VERDICT="grace"
    fi
  fi
}

mark_unreachable() {
  write_state_file "$UNREACHABLE_FILE" "SINCE=$RUN_START_EPOCH
" || log "WARN gagal menulis penanda tidak terjangkau"
}

# ---------------- Parse payload diagnosis/tindakan (tanpa merusak probe) ----------------

parse_diagnose_payload() {
  PG_RC=""; PG_OUT=""; WS_RC=""; WS_OUT=""
  COMPOSE_GUARD=""
  while IFS= read -r line; do
    case "$line" in
      PG_RC=*) PG_RC="${line#PG_RC=}" ;;
      PG_OUT=*) PG_OUT="${line#PG_OUT=}" ;;
      WS_RC=*) WS_RC="${line#WS_RC=}" ;;
      WS_OUT=*) WS_OUT="${line#WS_OUT=}" ;;
      COMPOSE_GUARD=*) COMPOSE_GUARD="${line#COMPOSE_GUARD=}" ;;
      *) ;;
    esac
  done <<<"$1"
  case "$COMPOSE_GUARD" in
    ok|missing_base|missing_override|no_project_dir) ;;
    *) COMPOSE_GUARD="tidak_dikenal" ;;
  esac
}

parse_action_payload() {
  ACTION_RC=""; ACTION_OUT=""
  ACTION_GUARD=""
  while IFS= read -r line; do
    case "$line" in
      ACTION_RC=*) ACTION_RC="${line#ACTION_RC=}" ;;
      ACTION_OUT=*) ACTION_OUT="${line#ACTION_OUT=}" ;;
      ACTION_GUARD=*) ACTION_GUARD="${line#ACTION_GUARD=}" ;;
      *) ;;
    esac
  done <<<"$1"
  case "$ACTION_GUARD" in
    ok|missing_base|missing_override|no_project_dir|placeholder_image|config_unresolved) ;;
    *) ACTION_GUARD="tidak_dikenal" ;;
  esac
}

# ---------------- Kumpul probe + diagnosis ----------------

GATHER_OK=0

run_gather() {
  local cmd=""
  GATHER_OK=0
  cmd="$(build_gather_cmd)"
  if ! remote_exec 60 "$cmd"; then return 1; fi
  if [ "$REMOTE_PAYLOAD_OK" -ne 1 ]; then return 0; fi
  parse_payload "$REMOTE_PAYLOAD"
  parse_ps
  validate_ready "$CR_CODE" "$CR_BODY"
  CR_VALID="$V_VALID"; CR_FAILED="$V_FAILED"; CR_PARSE="$V_PARSE"; CR_WARNINGS="$V_WARNINGS"
  validate_ready "$DR_CODE" "$DR_BODY"
  DR_VALID="$V_VALID"; DR_FAILED="$V_FAILED"; DR_PARSE="$V_PARSE"; DR_WARNINGS="$V_WARNINGS"
  validate_live "$CL_CODE" "$CL_BODY"; CL_OK="$L_OK"
  validate_live "$DL_CODE" "$DL_BODY"; DL_OK="$L_OK"
  compute_verdict
  GATHER_OK=1
  return 0
}

log_gather() {
  log "INFO probe_internal[$1] caddy_ready http=$CR_CODE valid=$CR_VALID gagal=[$CR_FAILED] caddy_live ok=$CL_OK direct_ready http=$DR_CODE exec_rc=$DR_EXEC_RC valid=$DR_VALID gagal=[$DR_FAILED] direct_live ok=$DL_OK verdict=$VERDICT sumber=${AUTH_SOURCE:-tidak_ada} ps_ok=$PS_OK exited=[$EXITED_LIST] compose_guard=$COMPOSE_GUARD"
  if [ -n "$CR_WARNINGS" ] || [ -n "$DR_WARNINGS" ]; then
    log "WARN peringatan non-blokir: caddy=[$CR_WARNINGS] direct=[$DR_WARNINGS]"
  fi
  log "INFO status_container caddy=$ST_caddy/$HE_caddy web=$ST_web/$HE_web api=$ST_api/$HE_api postgres=$ST_postgres/$HE_postgres worker_ada=$WORKER_EXISTS worker=$ST_worker/$HE_worker"
}

run_diagnose() {
  local cmd=""
  PG_RC="unknown"; PG_OUT=""; WS_RC="unknown"; WS_OUT=""
  COMPOSE_GUARD=""
  cmd="$(build_diagnose_cmd)"
  if ! remote_exec 60 "$cmd"; then return 1; fi
  if [ "$REMOTE_PAYLOAD_OK" -ne 1 ]; then return 0; fi
  parse_diagnose_payload "$REMOTE_PAYLOAD"
  if [ -z "$PG_RC" ]; then PG_RC="unknown"; fi
  if [ -z "$WS_RC" ]; then WS_RC="unknown"; fi
  return 0
}

# ---------------- Keputusan tindakan (seksi 2.3/2.4) ----------------

set_restart_action() {
  # $1 service, $2 alasan. Container yang hilang memakai "up -d <svc>"
  # (restart butuh container yang sudah ada); sisanya memakai restart.
  local st=""
  st="$(service_state "$1")"
  ACTION_KIND="restart"; ACTION_TARGET="$1"; ACTION_TRIGGER="$2"
  if [ "$st" = "missing" ]; then ACTION_CMD_LINE="up -d $1"; else ACTION_CMD_LINE="restart $1"; fi
}

decide_action() {
  local now_s="" db_code="" ws_code="" mig_code="" wk_code=""
  local prev_exited=0 prev_fail=0
  ACTION_KIND="none"; ACTION_TARGET=""; ACTION_TRIGGER=""; ACTION_CMD_LINE=""
  NO_ACTION_REASON=""
  now_s="$(date +%s)"
  if [ "$DIAG_BLOCKED" -eq 1 ]; then
    NO_ACTION_REASON="diagnosis terblokir: ready tidak dapat dinilai (live ok=$LIVE_OK)"
    return 0
  fi
  if [ "$PS_OK" -ne 1 ] && [ "$CADDY_SUSPECT" -eq 0 ]; then
    NO_ACTION_REASON="status container tidak terbaca; restart butuh bukti status"
    return 0
  fi
  if [ "$VERDICT" = "healthy" ]; then
    if [ "$WEB_BAD" -eq 1 ]; then
      set_restart_action web "per-service (web saja, ready sehat)"
      return 0
    fi
    if [ "$WORKER_DOWN" -eq 1 ]; then
      set_restart_action worker "per-service (worker saja, ready sehat)"
      return 0
    fi
    NO_ACTION_REASON="sehat, tidak ada masalah container"
    return 0
  fi
  if [ "$EXITED_COUNT" -ge 2 ]; then
    ACTION_KIND="up"; ACTION_TARGET="stack"; ACTION_TRIGGER="a (lebih dari satu service mati)"
    ACTION_CMD_LINE="up -d"
    return 0
  fi
  if [ -n "$RESUME_AT" ] && is_number "$RESUME_AT" && [ "$UP_DONE" -eq 0 ] && [ "$now_s" -ge $(( RESUME_AT + RESUME_GRACE_GENERAL )) ]; then
    if [ -n "$PREV_SIG" ] && [ "$PREV_SIG" = "$PRIMARY_SIG" ]; then
      case "$PREV_ACTION" in
        restart\ *)
          if is_number "$PREV_EPOCH" && [ "$PREV_EPOCH" -ge "$RESUME_AT" ]; then
            ACTION_KIND="up"; ACTION_TARGET="stack"; ACTION_TRIGGER="c (pasca-resume, stack tidak naik sendiri)"
            ACTION_CMD_LINE="up -d"
            return 0
          fi
          ;;
      esac
    fi
  fi
  if [ -n "$PREV_SIG" ] && [ "$PREV_SIG" = "$PRIMARY_SIG" ]; then
    case "$PREV_ACTION" in
      restart\ *)
        if is_number "$PREV_EXITED_COUNT"; then prev_exited="$PREV_EXITED_COUNT"; fi
        if is_number "$PREV_FAIL_COUNT"; then prev_fail="$PREV_FAIL_COUNT"; fi
        if is_number "$PREV_EPOCH" && [ $(( now_s - PREV_EPOCH )) -lt "$QUOTA_WINDOW" ]; then
          if [ "$EXITED_COUNT" -gt "$prev_exited" ] || [ "$FAIL_COUNT" -gt "$prev_fail" ]; then
            ACTION_KIND="up"; ACTION_TARGET="stack"; ACTION_TRIGGER="b (kegagalan meluas sesudah restart)"
            ACTION_CMD_LINE="up -d"
            return 0
          fi
        fi
        ;;
    esac
  fi
  if [ "$CADDY_SUSPECT" -eq 1 ]; then
    set_restart_action caddy "per-service (perbandingan probe: langsung sehat, Caddy gagal)"
    return 0
  fi
  if [ "$PROCESS_DOWN" -eq 1 ]; then
    if [ "$ST_api" = "restarting" ]; then
      NO_ACTION_REASON="crash-loop dicurigai (api restarting); tanpa restart watchdog, eskalasi"
      return 0
    fi
    set_restart_action api "per-service (proses mati: live dan ready gagal)"
    return 0
  fi
  check_code db; db_code="$CHECK_CODE"
  if [ -n "$db_code" ]; then
    if [ "$db_code" = "-" ]; then
      NO_ACTION_REASON="check db hilang dari body ready; tanpa restart, eskalasi"
      return 0
    fi
    case "$db_code" in
      DB_AUTH_FAILED|DB_NOT_FOUND|DB_NOT_CONFIGURED)
        NO_ACTION_REASON="konfigurasi DB ($db_code); tanpa restart, eskalasi"
        return 0
        ;;
    esac
    case "$ST_postgres" in
      exited|dead|created|paused|missing)
        set_restart_action postgres "per-service (Postgres mati, db gagal $db_code)"
        return 0
        ;;
    esac
    if [ "$PG_RC" = "0" ]; then
      NO_ACTION_REASON="pg_isready lulus tetapi db gagal ($db_code); kemungkinan konfigurasi/DSN; tanpa restart, eskalasi"
      return 0
    fi
    set_restart_action postgres "per-service (db gagal $db_code, pg_isready rc=${PG_RC:-tidak_diketahui})"
    return 0
  fi
  check_code workspace; ws_code="$CHECK_CODE"
  if [ -n "$ws_code" ]; then
    NO_ACTION_REASON="workspace gagal ($ws_code); restart tidak memperbaiki volume/mount; eskalasi"
    return 0
  fi
  check_code migrations; mig_code="$CHECK_CODE"
  if [ -n "$mig_code" ]; then
    set_restart_action api "per-service (migrasi gagal $mig_code; aturan ketat berlaku)"
    return 0
  fi
  check_code worker; wk_code="$CHECK_CODE"
  if [ -n "$wk_code" ]; then
    if [ "$WORKER_EXISTS" -eq 0 ]; then
      NO_ACTION_REASON="worker gagal ($wk_code) tetapi tidak ada service worker di compose; eskalasi"
      return 0
    fi
    set_restart_action worker "per-service (worker gagal $wk_code; aturan ketat berlaku)"
    return 0
  fi
  NO_ACTION_REASON="pola kegagalan tidak dikenal (gagal=[$AUTH_FAILED]); eskalasi"
  return 0
}

# ---------------- Signature + gerbang jatah/aturan ketat (seksi 2.5) ----------------

compute_signature() {
  local first="" c="" s="" code=""
  Q_SERVICE="$ACTION_TARGET"
  if [ "$CADDY_SUSPECT" -eq 1 ]; then
    Q_SIGNATURE="caddy:CADDY_PROBE_FAIL"
    return 0
  fi
  if [ "$PROCESS_DOWN" -eq 1 ]; then
    Q_SIGNATURE="api:PROCESS_DOWN"
    return 0
  fi
  if [ "$VERDICT" = "healthy" ]; then
    Q_SIGNATURE="$ACTION_TARGET:CONTAINER_DOWN"
    return 0
  fi
  if [ -z "$AUTH_FAILED" ]; then
    Q_SIGNATURE="unknown:NO_FAILED_CHECKS"
    return 0
  fi
  first="${AUTH_FAILED%%,*}"
  c="${first%%:*}"; s="${first#*:}"; code="${s#*:}"
  Q_SIGNATURE="$c:$code"
}

action_allowed() {
  local now_s="$1" strict=0
  ALLOW=1; BLOCK_REASON=""
  quota_lookup "$now_s" "$Q_SERVICE" "$Q_SIGNATURE"
  case "$AUTH_FAILED" in
    *MIGRATION_DRIFT*|*MIGRATION_REGISTRY_MISSING*|*WORKER_STALE*|*WORKER_NO_HEARTBEAT*) strict=1;;
  esac
  if [ "$strict" -eq 1 ] && [ "$Q_COUNT" -ge 1 ] && [ -n "$Q_FINGERPRINT" ] && [ "$Q_FINGERPRINT" = "$VERDICT_FINGERPRINT" ]; then
    ALLOW=0
    BLOCK_REASON="aturan ketat: gejala identik sesudah restart sebelumnya ($Q_SERVICE/$Q_SIGNATURE); tanpa restart kedua, eskalasi"
    return 0
  fi
  if [ "$Q_COUNT" -ge "$QUOTA_MAX" ]; then
    ALLOW=0
    BLOCK_REASON="jatah habis: $Q_COUNT/$QUOTA_MAX restart untuk $Q_SERVICE/$Q_SIGNATURE dalam $QUOTA_WINDOW detik; mode probe-saja untuk service itu, eskalasi"
    return 0
  fi
  return 0
}

# ---------------- Polling ----------------

poll_healthy() {
  local st=""
  if [ "$VERDICT" != "healthy" ]; then return 1; fi
  if [ "$PS_OK" -ne 1 ]; then
    log "WARN polling: status container tidak terbaca, ready sehat diterima sebagai pulih"
    return 0
  fi
  if [ "$ACTION_KIND" = "up" ]; then
    if [ "$EXITED_COUNT" -eq 0 ]; then return 0; else return 1; fi
  fi
  st="$(service_state "$ACTION_TARGET")"
  if [ "$st" = "running" ]; then return 0; else return 1; fi
}

# Polling sesudah tindakan (seksi 2.5): sampai WAIT_SECONDS, tiap
# POLL_INTERVAL, memakai putusan KETAT (tanpa tenggang worker).
poll_until_healthy() {
  local elapsed=0
  POLL_RESULT="timeout"
  while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
    sleep "$POLL_INTERVAL"
    elapsed=$(( elapsed + POLL_INTERVAL ))
    if ! run_gather; then
      if [ "$EXEC_EXIT" -eq 3 ]; then
        POLL_RESULT="unreachable"
        log_exec_failure "polling sesudah tindakan"
        return 1
      fi
      log "WARN polling: eksekusi gagal ($EXEC_CLASS), lanjut polling"
      continue
    fi
    if [ "$GATHER_OK" -ne 1 ]; then
      log "WARN polling: payload tidak ditemukan, lanjut polling"
      continue
    fi
    log_gather "polling"
    if poll_healthy; then
      POLL_RESULT="healthy"
      return 0
    fi
  done
  return 1
}

# Polling masa tenggang umum pasca-resume (seksi 5.3): tanpa tindakan
# sebelum tenggang habis. GRACE_RESULT: healthy/grace/expired/unreachable.
grace_poll() {
  local now_s=0
  GRACE_RESULT="expired"
  while :; do
    now_s="$(date +%s)"
    if [ "$now_s" -ge $(( RESUME_AT + RESUME_GRACE_GENERAL )) ]; then
      GRACE_RESULT="expired"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    if ! run_gather; then
      if [ "$EXEC_EXIT" -eq 3 ]; then
        GRACE_RESULT="unreachable"
        return 0
      fi
      log "WARN polling tenggang: eksekusi gagal ($EXEC_CLASS), lanjut polling"
      continue
    fi
    if [ "$GATHER_OK" -ne 1 ]; then
      log "WARN polling tenggang: payload tidak ditemukan, lanjut polling"
      continue
    fi
    log_gather "tenggang"
    update_grace_flags
    apply_worker_grace
    if [ "$VERDICT" = "healthy" ]; then
      GRACE_RESULT="healthy"
      return 0
    fi
    if [ "$VERDICT" = "grace" ]; then
      GRACE_RESULT="grace"
      return 0
    fi
  done
}

# ---------------- Alur utama ----------------

read_prev_file
SAVE_SIG="$PREV_SIG"
read_resume_file
if [ -n "$RESUME_AT" ] && is_number "$RESUME_AT" && [ $(( RUN_START_EPOCH - RESUME_AT )) -gt 3600 ]; then
  clear_resume_file
  log "INFO episode pasca-resume berakhir (lebih dari 3600 detik)"
fi
EPISODE_FIRST="${PREV_FIRST_FAIL:-$RUN_START_EPOCH}"

# 1. Kumpul probe internal (satu eksekusi jarak jauh).
if ! run_gather; then
  log_exec_failure "probe internal"
  if [ "$EXEC_EXIT" -eq 3 ]; then
    mark_unreachable
    note_transition "unreachable"
    finish_run 3 "unreachable" "$PREV_FIRST_FAIL" "tidak ada" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
      "VM TIDAK TERJANGKAU: tanpa tindakan, jatah tidak dipakai"
  elif [ "$EXEC_EXIT" -eq 2 ]; then
    note_transition "credential"
    finish_run 2 "credential" "$PREV_FIRST_FAIL" "tidak ada" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
      "KREDENSIAL EKSEKUSI: eksekusi jarak jauh ditolak, tanpa tindakan"
  else
    note_transition "unhealthy"
    finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
      "EKSEKUSI JARAK JAUH GAGAL: tanpa tindakan"
  fi
fi
if [ "$GATHER_OK" -ne 1 ]; then
  log "ERROR format respons eksekusi jarak jauh tidak dikenal (blok payload tidak ditemukan); tanpa tindakan"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
    "FORMAT RESPONS TIDAK DIKENAL: tanpa tindakan"
fi

# 2. VM terjangkau: transisi tidak-terjangkau menjadi terjangkau menandai
#    awal episode pasca-resume (masa tenggang dihitung sejak kontak pertama
#    yang berhasil sesudah periode tidak terjangkau).
if [ -f "$UNREACHABLE_FILE" ]; then
  RESUME_AT="$RUN_START_EPOCH"
  UP_DONE=0
  write_resume_file
  rm -f "$UNREACHABLE_FILE" 2>/dev/null || true
  log "INFO VM kembali terjangkau: masa tenggang pasca-resume dimulai (worker ${RESUME_GRACE_WORKER} detik, umum ${RESUME_GRACE_GENERAL} detik)"
fi
update_grace_flags
log_gather "awal"
if [ "${COMPOSE_GUARD:-}" != "ok" ]; then
  log "ERROR guard compose: $COMPOSE_GUARD (berkas dasar=$COMPOSE_FILE, override=$COMPOSE_OVERRIDE_FILE, single_file_allowed=$ALLOW_SINGLE_FILE); tanpa tindakan"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada (guard compose: $COMPOSE_GUARD)" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
    "GUARD COMPOSE: $COMPOSE_GUARD, tanpa tindakan"
fi

# 3. Masa tenggang umum: polling tanpa tindakan sampai tenggang habis.
if [ "$VERDICT" = "unhealthy" ] && [ "$GRACE_GENERAL_ACTIVE" -eq 1 ]; then
  log "INFO masa tenggang umum pasca-resume aktif: polling sampai tenggang habis sebelum tindakan"
  grace_poll
  if [ "$GRACE_RESULT" = "unreachable" ]; then
    mark_unreachable
    note_transition "unreachable"
    finish_run 3 "unreachable" "$PREV_FIRST_FAIL" "tidak ada" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
      "VM TIDAK TERJANGKAU saat polling tenggang: tanpa tindakan"
  fi
  update_grace_flags
fi

# 4. Masa tenggang worker: kegagalan worker saja tidak dinyatakan bermasalah.
apply_worker_grace
if [ "$VERDICT" = "grace" ]; then
  log "INFO masa tenggang worker pasca-resume: worker tidak dinyatakan bermasalah (gagal=[$AUTH_FAILED]); tanpa tindakan, jatah tidak berubah"
  finish_run 0 "grace" "$PREV_FIRST_FAIL" "masa tenggang pasca-resume (worker)" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
    "MASA TENGGANG: worker tidak dinyatakan bermasalah"
fi

# 5. Sehat penuh: reset seluruh jatah (seksi 2.5).
if [ "$VERDICT" = "healthy" ] && [ "$WEB_BAD" -eq 0 ] && [ "$WORKER_DOWN" -eq 0 ]; then
  quota_clear_all
  note_transition "healthy"
  SAVE_SIG=""
  finish_run 0 "healthy" "" "tidak ada" "" "" "" "SEHAT"
fi

# 6. Diagnosis tambahan bila db/workspace gagal: pg_isready + stat workspace.
PG_RC="unknown"; PG_OUT=""; WS_RC="unknown"; WS_OUT=""
NEEDS_DIAGNOSE=0
check_code db
if [ -n "$CHECK_CODE" ]; then NEEDS_DIAGNOSE=1; fi
check_code workspace
if [ -n "$CHECK_CODE" ]; then NEEDS_DIAGNOSE=1; fi
if [ "$NEEDS_DIAGNOSE" -eq 1 ]; then
  if ! run_diagnose; then
    log_exec_failure "diagnosis (pg_isready/workspace)"
    if [ "$EXEC_EXIT" -eq 3 ]; then
      mark_unreachable
      note_transition "unreachable"
      finish_run 3 "unreachable" "$PREV_FIRST_FAIL" "tidak ada" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
        "VM TIDAK TERJANGKAU saat diagnosis: tanpa tindakan"
    elif [ "$EXEC_EXIT" -eq 2 ]; then
      note_transition "credential"
      finish_run 2 "credential" "$PREV_FIRST_FAIL" "tidak ada" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
        "KREDENSIAL EKSEKUSI saat diagnosis: tanpa tindakan"
    else
      log "WARN diagnosis gagal ($EXEC_CLASS); lanjut dengan pg_isready/workspace tidak diketahui"
    fi
  else
    log "INFO diagnosis pg_rc=$PG_RC pg_out=[$(safe_line "$PG_OUT")] ws_rc=$WS_RC ws_out=[$(safe_line "$WS_OUT")] compose_guard=$COMPOSE_GUARD"
    if [ "${COMPOSE_GUARD:-}" != "ok" ]; then
      log "ERROR guard compose pada diagnosis: $COMPOSE_GUARD; hasil diagnosis tidak dapat dipakai"
    fi
  fi
fi

# 7. Keputusan tindakan (satu tindakan per run, seksi 2.5).
decide_action
if [ "$ACTION_KIND" = "none" ]; then
  log "INFO tanpa tindakan: $NO_ACTION_REASON"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "tidak ada ($NO_ACTION_REASON)" "$VERDICT_FINGERPRINT" "$EXITED_COUNT" "$FAIL_COUNT" \
    "TIDAK SEHAT, tanpa tindakan: $NO_ACTION_REASON"
fi
PRE_FP="$VERDICT_FINGERPRINT"
PRE_EXITED="$EXITED_COUNT"
PRE_FAIL="$FAIL_COUNT"

# 8. Gerbang: MAINTENANCE (D-W3), jatah + aturan ketat (seksi 2.5), DRY_RUN.
if [ "$MAINTENANCE" -eq 1 ]; then
  log "INFO MAINTENANCE aktif ($MAINTENANCE_FILE): mode probe-saja, tindakan ditunda: $ACTION_CMD_LINE (pemicu: $ACTION_TRIGGER)"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "ditunda (MAINTENANCE): $ACTION_CMD_LINE" "$PRE_FP" "$PRE_EXITED" "$PRE_FAIL" \
    "TIDAK SEHAT, tindakan ditunda: MAINTENANCE aktif"
fi
compute_signature
action_allowed "$(date +%s)"
if [ "$ALLOW" -ne 1 ]; then
  log "INFO tindakan diblokir: $BLOCK_REASON (rencana: $ACTION_CMD_LINE, pemicu: $ACTION_TRIGGER)"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "diblokir: $BLOCK_REASON" "$PRE_FP" "$PRE_EXITED" "$PRE_FAIL" \
    "TIDAK SEHAT, tindakan diblokir: jatah/aturan ketat"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  log "INFO DRY_RUN: akan menjalankan: docker compose $FILES_DESC $ACTION_CMD_LINE (di $PROJECT_DIR); pemicu: $ACTION_TRIGGER; tidak dieksekusi, jatah tidak dipakai"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "DRY_RUN: akan $ACTION_CMD_LINE" "$PRE_FP" "$PRE_EXITED" "$PRE_FAIL" \
    "DRY_RUN: akan $ACTION_CMD_LINE (tidak dieksekusi)"
fi

# 9. Jalankan satu tindakan, catat jatah, lalu polling sampai pulih/timeout.
ACTION_CMD="$(build_action_cmd "$ACTION_CMD_LINE")"
if ! remote_exec 120 "$ACTION_CMD"; then
  log_exec_failure "tindakan $ACTION_CMD_LINE"
  if [ "$EXEC_EXIT" -eq 3 ]; then
    mark_unreachable
    note_transition "unreachable"
    finish_run 3 "unreachable" "$PREV_FIRST_FAIL" "tindakan gagal (VM tidak terjangkau)" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
      "VM TIDAK TERJANGKAU saat tindakan, hasil tidak diketahui, jatah tidak dipakai"
  elif [ "$EXEC_EXIT" -eq 2 ]; then
    note_transition "credential"
    finish_run 2 "credential" "$PREV_FIRST_FAIL" "tindakan gagal (kredensial eksekusi)" "$PREV_FINGERPRINT" "$PREV_EXITED_COUNT" "$PREV_FAIL_COUNT" \
      "KREDENSIAL EKSEKUSI saat tindakan, hasil tidak diketahui, jatah tidak dipakai"
  else
    note_transition "unhealthy"
    finish_run 1 "unhealthy" "$EPISODE_FIRST" "tindakan gagal (eksekusi)" "$PRE_FP" "$PRE_EXITED" "$PRE_FAIL" \
      "TINDAKAN GAGAL DIEKSEKUSI: hasil tidak diketahui, jatah tidak dipakai"
  fi
fi
if [ "$REMOTE_PAYLOAD_OK" -ne 1 ]; then
  log "ERROR format respons tindakan tidak dikenal; hasil tidak diketahui; jatah tidak dipakai"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "tindakan: respons tidak dikenal" "$PRE_FP" "$PRE_EXITED" "$PRE_FAIL" \
    "TINDAKAN: respons tidak dikenal, hasil tidak diketahui"
fi
parse_action_payload "$REMOTE_PAYLOAD"
ACTION_OUT_SAFE="$(safe_line "$ACTION_OUT")"
log "INFO tindakan: $ACTION_CMD_LINE pemicu=$ACTION_TRIGGER rc=$ACTION_RC out=[$ACTION_OUT_SAFE]"
if [ "${ACTION_GUARD:-}" != "ok" ]; then
  log "ERROR tindakan ditolak guard compose: $ACTION_GUARD (rc=$ACTION_RC); jatah tidak dipakai, tanpa polling"
  note_transition "unhealthy"
  finish_run 1 "unhealthy" "$EPISODE_FIRST" "ditolak guard compose ($ACTION_GUARD): $ACTION_CMD_LINE" "$PRE_FP" "$PRE_EXITED" "$PRE_FAIL" \
    "GUARD COMPOSE: tindakan ditolak ($ACTION_GUARD), tanpa polling"
fi
quota_record "$Q_SERVICE" "$Q_SIGNATURE" "$PRE_FP" "$(date +%s)"
SAVE_SIG="$Q_SIGNATURE"
if [ "$ACTION_KIND" = "up" ] && [ -n "$RESUME_AT" ]; then
  UP_DONE=1
  write_resume_file
fi
if [ "$ACTION_RC" != "0" ]; then
  log "WARN perintah tindakan gagal di remote (rc=$ACTION_RC); tetap polling sesuai seksi 2.5"
fi
if poll_until_healthy; then
  quota_clear_all
  SAVE_SIG=""
  if [ "$ACTION_TARGET" = "postgres" ]; then
    log "INFO PULIH TANPA RESTART API: ready sehat sesudah restart Postgres (bukti T03)"
  fi
  note_transition "healthy"
  finish_run 0 "healthy" "" "$ACTION_CMD_LINE ($ACTION_TRIGGER), pulih" "" "" "" \
    "PULIH sesudah $ACTION_CMD_LINE"
fi
if [ "$POLL_RESULT" = "unreachable" ]; then
  mark_unreachable
  note_transition "unreachable"
  finish_run 3 "unreachable" "$PREV_FIRST_FAIL" "$ACTION_CMD_LINE (hasil polling tidak diketahui)" "$PRE_FP" "$PRE_EXITED" "$PRE_FAIL" \
    "VM TIDAK TERJANGKAU sesudah tindakan"
fi
note_transition "unhealthy"
finish_run 1 "unhealthy" "$EPISODE_FIRST" "$ACTION_CMD_LINE ($ACTION_TRIGGER), polling habis tanpa pulih" "$PRE_FP" "$PRE_EXITED" "$PRE_FAIL" \
  "TETAP GAGAL sesudah $ACTION_CMD_LINE"
