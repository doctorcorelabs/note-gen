#!/usr/bin/env bash
# Pemeriksa kesiapan cron watchdog (BACA-SAJA).
#
# Skrip ini TIDAK PERNAH menjalankan skrip watchdog, TIDAK menyentuh
# jaringan/docker/crontab/ib.py, dan TIDAK membaca atau menampilkan
# nilai token (hanya keberadaan berkas, mode, hitungan baris, dan
# ukuran byte). Skrip ini adalah pengganti pemeriksaan konfigurasi
# yang aman: trunk TIDAK mem-parsing argv, sehingga
# `--self-test`/`--check-config` pada skrip watchdog akan menjalankan
# RUN LIVE PENUH, bukan uji (DA18-K06). Jangan pernah memakai flag
# itu pada skrip watchdog.
#
# Pakai: bash check-config.sh --host operator|muse2
#          [--install-dir DIR] [--env-file FILE] [--trunk-dir DIR]
# Keluar 0 bila seluruh pemeriksaan lulus, 1 bila ada kegagalan
# kesiapan, 2 bila pemakaian salah.
#
# --host operator: berkas token WAJIB tidak ada di host ini (AD-187);
#   helper ib.py disyaratkan (jalur ib.py).
# --host muse2: berkas token WAJIB ada (0600, tepat 2 baris, hitungan
#   saja); helper ib.py tidak disyaratkan (mode lokal tidak memakainya).

FAIL_COUNT=0
WARN_COUNT=0
PASS_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo "PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo "FAIL: $1"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); echo "WARN: $1"; }
info() { echo "INFO: $1"; }

usage() {
  echo "Pakai: bash check-config.sh --host operator|muse2 [--install-dir DIR] [--env-file FILE] [--trunk-dir DIR]" >&2
  exit 2
}

HOST=""
INSTALL_DIR="${HOME}/workspace/notegen-watchdog"
ENV_FILE=""
TRUNK_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --trunk-dir) TRUNK_DIR="${2:-}"; shift 2 ;;
    --help|-h) usage ;;
    *) echo "Argumen tidak dikenal: $1" >&2; usage ;;
  esac
done

case "$HOST" in
  operator|muse2) ;;
  *) echo "Opsi --host wajib operator atau muse2" >&2; usage ;;
esac

if [ -z "$TRUNK_DIR" ]; then
  TRUNK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fi
if [ -z "$ENV_FILE" ]; then
  ENV_FILE="$INSTALL_DIR/watchdog.env"
fi

TUNNEL_TRUNK="$TRUNK_DIR/notegen-tunnel-watchdog.sh"
COMPOSE_TRUNK="$TRUNK_DIR/notegen-compose-watchdog.sh"
TUNNEL_INST="$INSTALL_DIR/notegen-tunnel-watchdog.sh"
COMPOSE_INST="$INSTALL_DIR/notegen-compose-watchdog.sh"

info "host=$HOST trunk_dir=$TRUNK_DIR install_dir=$INSTALL_DIR"

# 1. Skrip trunk: ada, executable, lulus bash -n.
for script in "$TUNNEL_TRUNK" "$COMPOSE_TRUNK"; do
  name="$(basename "$script")"
  if [ ! -f "$script" ]; then
    fail "skrip trunk tidak ada: $name"
    continue
  fi
  if [ ! -x "$script" ]; then
    fail "skrip trunk tidak executable: $name"
  else
    pass "skrip trunk ada + executable: $name"
  fi
  if bash -n "$script" 2>/dev/null; then
    pass "bash -n lulus: $name"
  else
    fail "bash -n gagal: $name"
  fi
done

# 2. Salinan terpasang: ada, executable, identik byte dengan trunk.
for pair in "$TUNNEL_TRUNK|$TUNNEL_INST" "$COMPOSE_TRUNK|$COMPOSE_INST"; do
  trunk="${pair%%|*}"
  inst="${pair#*|}"
  name="$(basename "$inst")"
  if [ ! -f "$inst" ]; then
    fail "salinan terpasang belum ada: $name (pasang dari trunk dulu)"
    continue
  fi
  if [ ! -x "$inst" ]; then
    fail "salinan terpasang tidak executable: $name"
  else
    pass "salinan terpasang executable: $name"
  fi
  if [ -f "$trunk" ] && cmp -s "$trunk" "$inst"; then
    pass "salinan terpasang identik byte dengan trunk: $name"
  else
    fail "salinan terpasang berbeda dari trunk: $name"
  fi
done

# 3. Berkas env: ada, mode 600, hanya variabel hidup, override wajib.
ENV_LAUNCHER=""
ENV_LAUNCHER_SET=0
ENV_PROBE_TIMEOUT=""
ENV_PROBE_TIMEOUT_SET=0
ENV_PUBLIC_URL=""
ENV_PUBLIC_URL_SET=0
ENV_TOKEN_FILE=""
ENV_TOKEN_FILE_SET=0
ENV_IB_PY=""
ENV_IB_PY_SET=0
ENV_LOG_DIR=""
ENV_LOG_DIR_SET=0
ENV_COMPOSE_FILE=""
ENV_COMPOSE_FILE_SET=0

if [ ! -f "$ENV_FILE" ]; then
  fail "berkas env tidak ada (dibutuhkan untuk override launcher F-02)"
else
  env_perm="$(stat -c %a "$ENV_FILE" 2>/dev/null || echo "?")"
  if [ "$env_perm" = "600" ]; then
    pass "mode berkas env 600"
  else
    fail "mode berkas env bukan 600 (mode=$env_perm)"
  fi
  while IFS= read -r rawline || [ -n "$rawline" ]; do
    line="$rawline"
    case "$line" in
      ''|'#'*|' '*|'	'*) ;;
    esac
    # Lewati baris kosong/komentar (termasuk komentar berindentasi).
    trimmed="$(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
    case "$trimmed" in
      ''|'#'*) continue ;;
    esac
    case "$trimmed" in
      *=*) ;;
      *) fail "baris env tanpa '=' (nama baris tidak ditampilkan)"; continue ;;
    esac
    vname="${trimmed%%=*}"
    vname="$(printf '%s' "$vname" | tr -d '[:space:]')"
    vvalue="${trimmed#*=}"
    # Lepas kutip pembungkus untuk pemeriksaan bentuk saja; nilai
    # tidak pernah ditampilkan.
    case "$vvalue" in
      '"'*) vvalue="${vvalue#\"}"; vvalue="${vvalue%\"}" ;;
      "'"*) vvalue="${vvalue#\'}"; vvalue="${vvalue%\'}" ;;
    esac
    case "$vname" in
      NOTEGEN_HEALTH_URL|NOTEGEN_INTERNAL_PROBE_CMD|NOTEGEN_LAUNCHER_CMD|NOTEGEN_REMOTE_CMD|NOTEGEN_REMOTE_PROJECT_DIR|NOTEGEN_REMOTE_TIMEOUT|NOTEGEN_CURL_TIMEOUT|NOTEGEN_REPROBE_WAIT|NOTEGEN_WAIT_AFTER_RESTART|NOTEGEN_POLL_INTERVAL|NOTEGEN_REQUIRE_MIGRATIONS_OK|NOTEGEN_REQUIRE_WORKER_OK|NOTEGEN_MIGRATIONS_HARD|NOTEGEN_PGVECTOR_HARD|NOTEGEN_DEPLOY_LOCK_FILE)
        fail "variabel mati dari draf DEP-23 (diabaikan trunk): $vname"
        ;;
      NOTEGEN_PUBLIC_URL|NOTEGEN_TOKEN_FILE|NOTEGEN_PROBE_TIMEOUT|NOTEGEN_INTERNAL_PROBE_TIMEOUT|NOTEGEN_IB_PY|NOTEGEN_MUSE2_ID|NOTEGEN_CADDY_PORT|NOTEGEN_API_PORT|NOTEGEN_PROJECT_DIR|NOTEGEN_COMPOSE_FILE|NOTEGEN_TUNNEL_LAUNCHER|NOTEGEN_LOG_DIR|NOTEGEN_MAINTENANCE_FILE|NOTEGEN_DRY_RUN|NOTEGEN_TUNNEL_REPROBE_WAIT|NOTEGEN_TUNNEL_PROBEONLY_AFTER|NOTEGEN_MIGRATIONS_REQUIRED|NOTEGEN_WORKER_DEPLOYED|NOTEGEN_COMPOSE_POLL_INTERVAL|NOTEGEN_COMPOSE_WAIT_SECONDS|NOTEGEN_MAX_RESTARTS_PER_HOUR|NOTEGEN_QUOTA_WINDOW_SECONDS|NOTEGEN_RESUME_GRACE_WORKER_SECONDS|NOTEGEN_RESUME_GRACE_GENERAL_SECONDS)
        ;;
      *)
        warn "variabel tidak dikenal (diabaikan trunk bila bukan variabel hidup): $vname"
        ;;
    esac
    case "$vname" in
      NOTEGEN_TUNNEL_LAUNCHER) ENV_LAUNCHER="$vvalue"; ENV_LAUNCHER_SET=1 ;;
      NOTEGEN_PROBE_TIMEOUT) ENV_PROBE_TIMEOUT="$vvalue"; ENV_PROBE_TIMEOUT_SET=1 ;;
      NOTEGEN_PUBLIC_URL) ENV_PUBLIC_URL="$vvalue"; ENV_PUBLIC_URL_SET=1 ;;
      NOTEGEN_TOKEN_FILE) ENV_TOKEN_FILE="$vvalue"; ENV_TOKEN_FILE_SET=1 ;;
      NOTEGEN_IB_PY) ENV_IB_PY="$vvalue"; ENV_IB_PY_SET=1 ;;
      NOTEGEN_LOG_DIR) ENV_LOG_DIR="$vvalue"; ENV_LOG_DIR_SET=1 ;;
      NOTEGEN_COMPOSE_FILE) ENV_COMPOSE_FILE="$vvalue"; ENV_COMPOSE_FILE_SET=1 ;;
    esac
  done < "$ENV_FILE"

  if [ "$ENV_LAUNCHER_SET" -ne 1 ]; then
    fail "override NOTEGEN_TUNNEL_LAUNCHER wajib diset (default trunk salah, F-02)"
  else
    case "$ENV_LAUNCHER" in
      */start-tunnel.sh) pass "override launcher menunjuk start-tunnel.sh" ;;
      *) fail "override launcher tidak menunjuk start-tunnel.sh" ;;
    esac
  fi
  if [ "$ENV_PROBE_TIMEOUT_SET" -eq 1 ]; then
    case "$ENV_PROBE_TIMEOUT" in
      ''|*[!0-9]*) fail "NOTEGEN_PROBE_TIMEOUT bukan angka" ;;
      *)
        if [ "$ENV_PROBE_TIMEOUT" -lt 1 ] || [ "$ENV_PROBE_TIMEOUT" -gt 300 ]; then
          fail "NOTEGEN_PROBE_TIMEOUT di luar 1..300"
        else
          pass "NOTEGEN_PROBE_TIMEOUT angka dalam 1..300"
        fi
        ;;
    esac
  else
    info "NOTEGEN_PROBE_TIMEOUT tidak diset; default trunk 25 berlaku"
  fi
  if [ "$ENV_PUBLIC_URL_SET" -eq 1 ]; then
    case "$ENV_PUBLIC_URL" in
      https://*) pass "NOTEGEN_PUBLIC_URL berprefix https" ;;
      *) fail "NOTEGEN_PUBLIC_URL tidak berprefix https" ;;
    esac
  fi
  if [ "$ENV_COMPOSE_FILE_SET" -eq 1 ]; then
    case "$ENV_COMPOSE_FILE" in
      ''|*/*|*..*) fail "NOTEGEN_COMPOSE_FILE wajib nama berkas relatif tanpa garis miring" ;;
      *) pass "bentuk NOTEGEN_COMPOSE_FILE relatif" ;;
    esac
  fi
fi

# 4. Helper ib.py (disyaratkan pada host operator; informatif di muse2).
if [ "$ENV_IB_PY_SET" -eq 1 ]; then
  IB_PATH="$ENV_IB_PY"
else
  IB_PATH="$HOME/workspace/custom-connectors/custom.instabox-muse2/bin/ib.py"
fi
if [ "$HOST" = "muse2" ]; then
  info "pemeriksaan ib.py dilewati pada host muse2 (mode lokal tidak memakainya)"
else
  if [ ! -f "$IB_PATH" ]; then
    fail "helper ib.py tidak ada pada jalur NOTEGEN_IB_PY"
  elif [ ! -x "$IB_PATH" ]; then
    fail "helper ib.py tidak executable (F-01; mode 760 disyaratkan)"
  else
    ib_perm="$(stat -c %a "$IB_PATH" 2>/dev/null || echo "?")"
    pass "helper ib.py ada + executable (mode=$ib_perm)"
    if [ "$ib_perm" != "760" ]; then
      warn "mode ib.py bukan 760 (mode=$ib_perm); guard trunk hanya menguji executable"
    fi
  fi
fi

# 5. Berkas token: hitungan saja, tanpa membaca nilai.
if [ "$ENV_TOKEN_FILE_SET" -eq 1 ]; then
  TOKEN_PATH="$ENV_TOKEN_FILE"
else
  TOKEN_PATH="$HOME/.config/notegen-tunnel/service-token"
fi
# Perluas $HOME harfiah di awal jalur (bentuk default memakai $HOME).
case "$TOKEN_PATH" in
  '$HOME/'*) TOKEN_PATH="$HOME/${TOKEN_PATH#\$HOME/}" ;;
  '~/'*) TOKEN_PATH="$HOME/${TOKEN_PATH#\~/}" ;;
esac
if [ "$HOST" = "operator" ]; then
  if [ -e "$TOKEN_PATH" ]; then
    fail "berkas token ADA di host operator (AD-187: menyalin token ke VM Muse DILARANG; keberadaan saja dilaporkan, isi tidak dibaca)"
  else
    pass "berkas token tidak ada di host operator (sesuai AD-187)"
  fi
else
  if [ ! -f "$TOKEN_PATH" ]; then
    fail "berkas token tidak ada di host muse2"
  else
    tok_perm="$(stat -c %a "$TOKEN_PATH" 2>/dev/null || echo "?")"
    if [ "$tok_perm" = "600" ]; then
      pass "mode berkas token 600"
    else
      warn "mode berkas token bukan 600 (mode=$tok_perm); trunk hanya memperingatkan"
    fi
    tok_lines="$(awk 'END { print NR }' "$TOKEN_PATH" 2>/dev/null || echo "?")"
    tok_bytes="$(wc -c < "$TOKEN_PATH" 2>/dev/null | tr -d ' ' || echo "?")"
    if [ "$tok_lines" = "2" ]; then
      pass "hitungan baris berkas token = 2 (hitungan saja, isi tidak dibaca; $tok_bytes byte)"
    else
      fail "hitungan baris berkas token bukan 2 (hitungan=$tok_lines)"
    fi
  fi
fi

# 6. Direktori log: informatif saja (skrip membuat saat run pertama).
if [ "$ENV_LOG_DIR_SET" -eq 1 ]; then
  LOG_PATH="$ENV_LOG_DIR"
else
  LOG_PATH="$HOME/workspace/notegen-watchdog-logs"
fi
case "$LOG_PATH" in
  '$HOME/'*) LOG_PATH="$HOME/${LOG_PATH#\$HOME/}" ;;
  '~/'*) LOG_PATH="$HOME/${LOG_PATH#\~/}" ;;
esac
if [ -d "$LOG_PATH" ]; then
  if [ -w "$LOG_PATH" ]; then
    pass "direktori log ada + dapat ditulis"
  else
    fail "direktori log ada tetapi tidak dapat ditulis"
  fi
  if [ -e "$LOG_PATH/MAINTENANCE" ]; then
    warn "berkas MAINTENANCE ada: run akan probe-saja (D-W3)"
  fi
else
  info "direktori log belum ada; skrip membuatnya saat run pertama"
fi

echo "RINGKASAN: lulus=$PASS_COUNT gagal=$FAIL_COUNT peringatan=$WARN_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
