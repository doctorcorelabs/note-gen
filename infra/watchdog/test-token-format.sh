#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
# See LICENSE and FORK.md.
#
# Uji format berkas token watchdog tunnel (AD-145, format kanonis 2 baris).
# Perluasan terfokus dari pola harness mock W5-WATCHDOG r14
# (fase1/evidence/w5-watchdog-r14/harness/run-tests.sh): helper asersi yang
# sama, nilai token tiruan yang jelas-jelas dummy, keluar nonzero bila ada
# asersi yang gagal. TIDAK menyentuh muse-2: probe sehat dilayani server
# mock lokal (127.0.0.1, port efemeral) yang merekam header Access, probe
# gagal memakai port tertutup lokal, dan semua panggilan jarak jauh memakai
# stub ib.py lokal yang selalu gagal cepat tanpa jaringan.
#
# Memakai: bash infra/watchdog/test-token-format.sh
# Keluar 0 bila semua asersi lulus, 1 bila ada yang gagal.
set -u
export TZ=Asia/Jakarta

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TUNNEL_SCRIPT="$SCRIPT_DIR/notegen-tunnel-watchdog.sh"

DUMMY_ID="dummyid000"
DUMMY_SEC="dummysecret000"

PASS_COUNT=0
FAIL_COUNT=0
FAILURES=""

# ---------------- Helper asersi (pola run-tests.sh r14) ----------------
pass() { PASS_COUNT=$((PASS_COUNT+1)); echo "  PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); FAILURES="$FAILURES
  - $1"; echo "  FAIL: $1"; }
expect_rc() {
  if [ "$2" -eq "$1" ]; then pass "$3 (rc=$2)";
  else fail "$3 (rc=$2, harap $1)"; fi
}
expect_contains() {
  if [ -f "$1" ] && grep -F -q -- "$2" "$1"; then pass "$3";
  else fail "$3 (tidak ada [$2] di $1)"; fi
}
expect_absent() {
  if [ -f "$1" ] && grep -F -q -- "$2" "$1"; then fail "$3 (ditemukan [$2] di $1)";
  else pass "$3"; fi
}
expect_empty() {
  if [ ! -s "$1" ]; then pass "$2";
  else fail "$2 (berkas $1 tidak kosong)"; fi
}

# ---------------- Persiapan ----------------
if [ ! -x "$TUNNEL_SCRIPT" ]; then
  echo "GAGAL: skrip watchdog tidak ditemukan di $TUNNEL_SCRIPT"; exit 1
fi

TESTROOT="$(mktemp -d)"
STUB_IB="$TESTROOT/stub-ib.py"
IB_MARKER_FILE="$TESTROOT/ib-marker.txt"
HEADERS_FILE="$TESTROOT/headers.txt"
PORT_FILE="$TESTROOT/port.txt"
SERVER_PID_FILE="$TESTROOT/server.pid"

# Stub ib.py: dicatat pemanggilannya, lalu gagal cepat. Tidak ada jaringan,
# tidak ada nilai token di output. Dipanggil lewat `python3 "$IB_PY" ...`
# oleh skrip watchdog, jadi stub ini harus berupa skrip Python.
cat > "$STUB_IB" <<'PYEOF'
import os, sys
marker = os.environ.get("STUB_IB_MARKER", "")
if marker:
    with open(marker, "a") as f:
        f.write("called: " + " ".join(sys.argv[1:3]) + "\n")
sys.exit(1)
PYEOF
chmod +x "$STUB_IB"
export STUB_IB_MARKER="$IB_MARKER_FILE"

# Server mock lokal: merekam header Access tiap GET /api/health/ready lalu
# menjawab amplop ready sehat (bentuk yang sama dengan preset healthy
# scenarios.py r14). Path lain dijawab 404 tanpa merekam header.
cat > "$TESTROOT/mock-server.py" <<'PYEOF'
import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

headers_file = os.environ["MOCK_HEADERS_FILE"]
port_file = os.environ["MOCK_PORT_FILE"]
BODY = json.dumps({
    "ok": True, "status": "ready",
    "checks": {
        "db": {"status": "ok"},
        "workspace": {"status": "ok"},
        "migrations": {"status": "ok"},
        "pgvector": {"status": "ok"},
        "worker": {"status": "skipped"},
    },
}).encode()

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/health/ready":
            with open(headers_file, "a") as f:
                f.write("ID=" + str(self.headers.get("CF-Access-Client-Id")) + "\n")
                f.write("SEC=" + str(self.headers.get("CF-Access-Client-Secret")) + "\n")
                f.write("---\n")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(BODY)))
            self.end_headers()
            self.wfile.write(BODY)
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(port_file, "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF

cleanup() {
  if [ -f "$SERVER_PID_FILE" ]; then
    kill "$(cat "$SERVER_PID_FILE")" 2>/dev/null || true
    rm -f "$SERVER_PID_FILE"
  fi
  rm -rf "$TESTROOT"
}
trap cleanup EXIT

: > "$HEADERS_FILE"
MOCK_HEADERS_FILE="$HEADERS_FILE" MOCK_PORT_FILE="$PORT_FILE" \
  python3 "$TESTROOT/mock-server.py" > "$TESTROOT/server.log" 2>&1 &
echo $! > "$SERVER_PID_FILE"
i=0
while [ ! -s "$PORT_FILE" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
if [ ! -s "$PORT_FILE" ]; then
  echo "GAGAL: server mock tidak naik"; cat "$TESTROOT/server.log"; exit 1
fi
MOCK_PORT="$(cat "$PORT_FILE")"
SERVER_URL="http://127.0.0.1:$MOCK_PORT/api/health/ready"
CLOSED_URL="http://127.0.0.1:9/api/health/ready"

# ---------------- Helper run ----------------
CUR_LOGDIR=""
LAST_RC=0
fresh_case() {
  CUR_LOGDIR="$TESTROOT/logs-$1"
  rm -rf "$CUR_LOGDIR"
  mkdir -p "$CUR_LOGDIR"
  : > "$IB_MARKER_FILE"
}
logfile() { printf '%s\n' "$CUR_LOGDIR/notegen-tunnel-watchdog-$(date +%F).log"; }
run_watchdog() {
  local tmp_out="$CUR_LOGDIR/.last-stdout" tmp_err="$CUR_LOGDIR/.last-stderr"
  env "$@" NOTEGEN_LOG_DIR="$CUR_LOGDIR" NOTEGEN_IB_PY="$STUB_IB" \
    NOTEGEN_PROBE_TIMEOUT=5 NOTEGEN_TUNNEL_REPROBE_WAIT=0 \
    bash "$TUNNEL_SCRIPT" >"$tmp_out" 2>"$tmp_err"
  LAST_RC=$?
  return 0
}
mk_token() {
  # $1 nama berkas, $2.. format printf + argumen. Izin 0600.
  local f="$TESTROOT/$1"; shift
  # shellcheck disable=SC2059
  printf "$@" > "$f"
  chmod 600 "$f"
  printf '%s\n' "$f"
}

# Kasus terima via server mock: exit 0 + SEHAT + header persis nilai dummy
# (membuktikan CR ter-strip dan nilai diteruskan verbatim) + tanpa ib.py.
# $1 nama kasus, $2.. penugasan env tambahan (token/Home).
accept_case() {
  local name="$1"; shift
  : > "$HEADERS_FILE"
  fresh_case "$name"
  run_watchdog NOTEGEN_PUBLIC_URL="$SERVER_URL" "$@"
  expect_rc 0 "$LAST_RC" "$name exit"
  expect_contains "$CUR_LOGDIR/.last-stdout" "SEHAT" "$name stdout SEHAT"
  expect_contains "$HEADERS_FILE" "ID=$DUMMY_ID" "$name header id persis"
  expect_contains "$HEADERS_FILE" "SEC=$DUMMY_SEC" "$name header secret persis"
  expect_empty "$IB_MARKER_FILE" "$name tanpa panggilan ib.py"
}

# Kasus tolak via port tertutup: exit 2 + tanpa probe + tanpa ib.py.
# $1 nama kasus, $2 frasa log yang diharapkan, $3.. penugasan env tambahan.
reject_case() {
  local name="$1" phrase="$2"; shift 2
  fresh_case "$name"
  run_watchdog NOTEGEN_PUBLIC_URL="$CLOSED_URL" "$@"
  expect_rc 2 "$LAST_RC" "$name exit"
  expect_contains "$CUR_LOGDIR/.last-stdout" "KREDENSIAL: berkas token" "$name stdout kredensial"
  expect_contains "$(logfile)" "$phrase" "$name log $phrase"
  expect_absent "$(logfile)" "probe_luar" "$name tanpa probe"
  expect_empty "$IB_MARKER_FILE" "$name tanpa panggilan ib.py"
}

# ---------------- Kasus terima ----------------
echo "== Kasus terima (format 2 baris) =="

echo "-- S1 dua baris + newline final --"
T1="$(mk_token t1.txt '%s\n%s\n' "$DUMMY_ID" "$DUMMY_SEC")"
accept_case s1 NOTEGEN_TOKEN_FILE="$T1"

echo "-- S2 dua baris CRLF (CR di-strip) --"
T2="$(mk_token t2.txt '%s\r\n%s\r\n' "$DUMMY_ID" "$DUMMY_SEC")"
accept_case s2 NOTEGEN_TOKEN_FILE="$T2"

echo "-- S3 dua baris tanpa newline final --"
T3="$(mk_token t3.txt '%s\n%s' "$DUMMY_ID" "$DUMMY_SEC")"
accept_case s3 NOTEGEN_TOKEN_FILE="$T3"

echo "-- S4 dua baris + baris kosong akhir --"
T4="$(mk_token t4.txt '%s\n%s\n\n' "$DUMMY_ID" "$DUMMY_SEC")"
accept_case s4 NOTEGEN_TOKEN_FILE="$T4"

echo "-- S5 jalur default kanonis via HOME (tanpa override env) --"
FAKEHOME="$TESTROOT/fakehome"
mkdir -p "$FAKEHOME/.config/notegen-tunnel"
printf '%s\n%s\n' "$DUMMY_ID" "$DUMMY_SEC" > "$FAKEHOME/.config/notegen-tunnel/service-token"
chmod 600 "$FAKEHOME/.config/notegen-tunnel/service-token"
accept_case s5 HOME="$FAKEHOME"

echo "-- S6 override NOTEGEN_TOKEN_FILE menang atas jalur default --"
printf 'format-lama-satu-baris\n' > "$FAKEHOME/.config/notegen-tunnel/service-token"
accept_case s6 HOME="$FAKEHOME" NOTEGEN_TOKEN_FILE="$T1"

echo "-- S7 diterima lalu probe gagal (port tertutup): probe jalan, tanpa vonis kredensial --"
fresh_case s7
run_watchdog NOTEGEN_PUBLIC_URL="$CLOSED_URL" NOTEGEN_TOKEN_FILE="$T1"
if [ "$LAST_RC" -eq 1 ] || [ "$LAST_RC" -eq 3 ]; then
  pass "s7 exit diagnosis (rc=$LAST_RC)"
else
  fail "s7 exit diagnosis (rc=$LAST_RC, harap 1 atau 3)"
fi
expect_contains "$(logfile)" "probe_luar" "s7 probe dijalankan"
expect_absent "$(logfile)" "format berkas token salah" "s7 tanpa error format"
expect_absent "$CUR_LOGDIR/.last-stdout" "KREDENSIAL: berkas token" "s7 tanpa vonis kredensial token"
if [ -s "$IB_MARKER_FILE" ]; then pass "s7 diagnosis via stub ib.py berjalan";
else fail "s7 diagnosis via stub ib.py berjalan (marker kosong)"; fi

# ---------------- Kasus tolak ----------------
echo "== Kasus tolak (exit 2, tanpa probe) =="

echo "-- R1 berkas tidak ada --"
reject_case r1 "berkas token tidak ada" NOTEGEN_TOKEN_FILE="$TESTROOT/tidak-ada.txt"

echo "-- R2 format lama satu baris id:secret --"
TB="$(mk_token tb.txt '%s:%s\n' "$DUMMY_ID" "$DUMMY_SEC")"
reject_case r2 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R3 satu baris tanpa titik dua --"
TB="$(mk_token tb.txt '%s\n' "$DUMMY_ID")"
reject_case r3 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R4 berkas kosong --"
TB="$(mk_token tb.txt '')"
reject_case r4 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R5 baris 1 kosong --"
TB="$(mk_token tb.txt '\n%s\n' "$DUMMY_SEC")"
reject_case r5 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R6 baris 2 kosong --"
TB="$(mk_token tb.txt '%s\n\n' "$DUMMY_ID")"
reject_case r6 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R7 tiga baris bernilai --"
TB="$(mk_token tb.txt '%s\n%s\n%s\n' "$DUMMY_ID" "$DUMMY_SEC" "dummyextra000")"
reject_case r7 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R8 baris bernilai sesudah baris kosong ketiga --"
TB="$(mk_token tb.txt '%s\n%s\n\n%s\n' "$DUMMY_ID" "$DUMMY_SEC" "dummyextra000")"
reject_case r8 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R9 spasi di baris 1 --"
TB="$(mk_token tb.txt '%s\n%s\n' "dummy id000" "$DUMMY_SEC")"
reject_case r9 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R10 spasi di baris 2 --"
TB="$(mk_token tb.txt '%s\n%s\n' "$DUMMY_ID" "dummy secret000")"
reject_case r10 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R11 tab di baris 1 --"
TB="$(mk_token tb.txt '%s\n%s\n' "dummy	id000" "$DUMMY_SEC")"
reject_case r11 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R12 tab di baris 2 --"
TB="$(mk_token tb.txt '%s\n%s\n' "$DUMMY_ID" "dummy	secret000")"
reject_case r12 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R13 kutip ganda di baris 2 --"
TB="$(mk_token tb.txt '%s\n%s\n' "$DUMMY_ID" 'dummy"secret000')"
reject_case r13 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R14 kutip tunggal di baris 1 --"
TB="$(mk_token tb.txt '%s\n%s\n' "dummy'id000" "$DUMMY_SEC")"
reject_case r14 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R15 backslash di baris 1 --"
TB="$(mk_token tb.txt '%s\n%s\n' 'dummy\id000' "$DUMMY_SEC")"
reject_case r15 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R16 backslash di baris 2 --"
TB="$(mk_token tb.txt '%s\n%s\n' "$DUMMY_ID" 'dummy\secret000')"
reject_case r16 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R17 prefix Bearer di baris 1 --"
TB="$(mk_token tb.txt '%s\n%s\n' "Bearer$DUMMY_ID" "$DUMMY_SEC")"
reject_case r17 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R18 prefix Bearer di baris 2 --"
TB="$(mk_token tb.txt '%s\n%s\n' "$DUMMY_ID" "Bearer$DUMMY_SEC")"
reject_case r18 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R19 spasi akhir di baris 2 --"
TB="$(mk_token tb.txt '%s\n%s\n' "$DUMMY_ID" "$DUMMY_SEC ")"
reject_case r19 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R20 spasi awal di baris 1 --"
TB="$(mk_token tb.txt '%s\n%s\n' " $DUMMY_ID" "$DUMMY_SEC")"
reject_case r20 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R21 hanya jalur lama (bukan default lagi) --"
FAKEHOME2="$TESTROOT/fakehome2"
mkdir -p "$FAKEHOME2/.config/notegen"
printf '%s\n%s\n' "$DUMMY_ID" "$DUMMY_SEC" > "$FAKEHOME2/.config/notegen/service-token"
chmod 600 "$FAKEHOME2/.config/notegen/service-token"
reject_case r21 "berkas token tidak ada" HOME="$FAKEHOME2"

echo "-- R22 berkas hanya newline --"
TB="$(mk_token tb.txt '\n')"
reject_case r22 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

echo "-- R23 baris 2 hanya spasi --"
TB="$(mk_token tb.txt '%s\n%s\n' "$DUMMY_ID" "   ")"
reject_case r23 "format berkas token salah" NOTEGEN_TOKEN_FILE="$TB"

# ---------------- Audit global ----------------
echo "== Audit global =="
echo "-- G1 nilai token tiruan tidak ada di log/stdout manapun --"
if grep -r -F -q -- "$DUMMY_ID" "$TESTROOT/logs-" 2>/dev/null; then
  fail "G1 nilai id ditemukan di log uji"
else
  pass "G1 nilai id tidak ada di log uji"
fi
if grep -r -F -q -- "$DUMMY_SEC" "$TESTROOT/logs-" 2>/dev/null; then
  fail "G1b nilai secret ditemukan di log uji"
else
  pass "G1b nilai secret tidak ada di log uji"
fi
echo "-- G2 em dash: 0 di skrip + README + uji ini --"
if grep -P -q "\xE2\x80\x94" "$TUNNEL_SCRIPT" "$SCRIPT_DIR/README.md" "$0" 2>/dev/null; then
  fail "G2 em dash ditemukan"
else
  pass "G2 0 em dash"
fi

# ---------------- Ringkasan ----------------
echo ""
echo "== Ringkasan: $PASS_COUNT lulus, $FAIL_COUNT gagal =="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Kegagalan:$FAILURES"
  exit 1
fi
echo "SEMUA UJI LULUS"
exit 0
