#!/usr/bin/env bash
# Pembangun pratinjau gabungan crontab (TANPA menulis crontab).
#
# Skrip ini membaca salinan crontab lama yang diberikan operator +
# fragmen cron terkoreksi, lalu menulis PRATINJAU gabungan untuk
# ditinjau operator. Skrip ini TIDAK PERNAH memanggil `crontab` dalam
# bentuk apa pun, tidak menghapus atau mengubah baris lama, dan
# menolak bila baris notegen aktif sudah ada pada salinan lama
# (operator wajib menghapusnya manual dulu; tidak ada penghapusan
# otomatis). Pemasangan gabungan, bila gerbang aktivasi terpenuhi,
# dilakukan operator dengan perintah crontab-nya sendiri sesudah
# meninjau pratinjau (lihat infra/watchdog/cron/README.md seksi 4).
#
# Pakai: bash merge-check.sh <salinan-crontab-lama> <fragmen> [berkas-keluaran]
# Tanpa berkas keluaran, pratinjau ditulis ke stdout dan ringkasan
# ke stderr. Berkas keluaran yang sudah ada DITOLAK (pilih nama baru).
# Keluar 0 bila pratinjau ditulis, 1 bila validasi gagal, 2 bila
# pemakaian salah.
#
# set -f: field jadwal cron memuat bintang dan harus dibaca harfiah,
# bukan dikembangkan sebagai pola nama berkas.

set -f

usage() {
  echo "Pakai: bash merge-check.sh <salinan-crontab-lama> <fragmen> [berkas-keluaran]" >&2
  exit 2
}

[ $# -ge 2 ] && [ $# -le 3 ] || usage
OLD_FILE="$1"
FRAG_FILE="$2"
OUT_FILE="${3:-}"

[ -f "$OLD_FILE" ] || { echo "FAIL: salinan crontab lama tidak ada" >&2; exit 1; }
[ -f "$FRAG_FILE" ] || { echo "FAIL: fragmen tidak ada" >&2; exit 1; }
if [ -n "$OUT_FILE" ] && [ -e "$OUT_FILE" ]; then
  echo "FAIL: berkas keluaran sudah ada; pilih nama baru" >&2
  exit 1
fi

# 1. Validasi fragmen: hanya komentar, penugasan SHELL, dan baris
#    jadwal 5-field yang perintahnya menyebut watchdog NoteGen.
frag_schedule=0
frag_assign=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*) continue ;;
  esac
  case "$line" in
    SHELL=/bin/bash|SHELL=/bin/sh)
      frag_assign=$((frag_assign + 1))
      continue
      ;;
    *=*)
      echo "FAIL: fragmen memuat penugasan selain SHELL" >&2
      exit 1
      ;;
  esac
  # Baris jadwal: 5 field + perintah.
  set -- $line
  if [ $# -lt 6 ]; then
    echo "FAIL: baris fragmen bukan jadwal 5-field + perintah" >&2
    exit 1
  fi
  f1="$1"; f2="$2"; f3="$3"; f4="$4"; f5="$5"
  for field in "$f1" "$f2" "$f3" "$f4" "$f5"; do
    case "$field" in
      ''|*[!0-9*,/-]*)
        echo "FAIL: field jadwal fragmen tidak valid" >&2
        exit 1
        ;;
    esac
  done
  case "$line" in
    *notegen-watchdog*notegen-*-watchdog.sh*) ;;
    *)
      echo "FAIL: perintah fragmen tidak menyebut skrip watchdog NoteGen" >&2
      exit 1
      ;;
  esac
  case "$line" in
    *crontab*)
      echo "FAIL: perintah fragmen menyebut crontab" >&2
      exit 1
      ;;
  esac
  frag_schedule=$((frag_schedule + 1))
done < "$FRAG_FILE"

if [ "$frag_schedule" -ne 2 ]; then
  echo "FAIL: fragmen wajib memuat tepat 2 baris jadwal (ditemukan $frag_schedule)" >&2
  exit 1
fi

# 2. Salinan lama: tolak bila baris notegen AKTIF sudah ada.
old_active_notegen=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*) continue ;;
  esac
  lower="$(printf '%s' "$line" | tr 'A-Z' 'a-z')"
  case "$lower" in
    *notegen*)
      old_active_notegen=$((old_active_notegen + 1))
      ;;
  esac
done < "$OLD_FILE"
if [ "$old_active_notegen" -gt 0 ]; then
  echo "FAIL: $old_active_notegen baris notegen aktif sudah ada pada salinan lama; hapus manual dulu, lalu jalankan ulang" >&2
  exit 1
fi

# 3. Gabung: salinan lama utuh + penanda + baris aktif fragmen.
old_lines="$(wc -l < "$OLD_FILE" | tr -d ' ')"
new_lines=$((frag_schedule + frag_assign))
emit_merged() {
  if [ -s "$OLD_FILE" ]; then
    cat "$OLD_FILE"
    # Pastikan berkas lama diakhiri baris baru sebelum penanda.
    last="$(tail -c 1 "$OLD_FILE" | tr -d '\n')"
    if [ -n "$last" ]; then
      printf '\n'
    fi
  fi
  echo "# --- notegen watchdog (fragmen terkoreksi; pratinjau, belum dipasang) ---"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    echo "$line"
  done < "$FRAG_FILE"
}

if [ -n "$OUT_FILE" ]; then
  emit_merged > "$OUT_FILE"
  total_lines="$(wc -l < "$OUT_FILE" | tr -d ' ')"
  echo "PRATINJAU ditulis (bukan crontab terpasang): baris lama=$old_lines, baris baru=$new_lines, total=$total_lines. Tinjau berkas keluaran sebelum pemasangan apa pun." >&2
else
  emit_merged
  echo "RINGKASAN (stderr): baris lama=$old_lines, baris baru=$new_lines. Pratinjau di atas; belum ada crontab yang ditulis." >&2
fi
exit 0
