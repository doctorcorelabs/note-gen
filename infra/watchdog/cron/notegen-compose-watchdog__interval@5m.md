---
id: notegen-compose-watchdog
title: NoteGen compose watchdog (muse-2, internal)
enabled: false
mode: task
schedule:
  kind: interval
  timezone: Asia/Jakarta
  at: 2026-11-18T04:33:36
  every: 5m
timeout_secs: 300
---

AKTIVASI DITUNDA (AD-138). Berkas ini hanya definisi tercatat: JANGAN
diaktifkan sebelum kata eksplisit user DAN putusan bersama laporan
Fase 1 + keputusan opsi B (AD-201 butir 6). Aktivasi berkala menunggu
pencabutan STOP global 17 Nov 2026 dan go-ahead aktivasi watchdog.
Bukti penerimaan gelombang 5 adalah definisi ini + satu jalan manual
sehat per watchdog sesudah deploy (fase 5D), bukan aktivasi berkala.
BLOKIR TAMBAHAN: perbaikan F-ABC-A1 belum diputus parent (templat
watchdog compose memakai bentuk berkas tunggal yang menjatuhkan
override 5C; AD-195, DA18-K01); jangan aktifkan sebelum putusan itu.

Tujuan: jaga stack compose NoteGen di muse-2 tetap sehat dari dalam.
Skrip memprobe ready lewat Caddy dan langsung ke API lewat ib.py,
membaca status container, mendiagnosis db/workspace bila gagal, lalu
melakukan paling banyak SATU tindakan per run (spesifikasi-watchdog.md
seksi 2). Jatah: maksimum 2 restart service yang sama per jam untuk
kegagalan yang sama; aturan ketat untuk drift/stale/konfigurasi.
Skrip ini tidak memakai service token (tidak terkena DA18-N06).

OFFSET DARI WATCHDOG TUNNEL (2-3 menit): kedua definisi memakai anchor
`at` yang SAMA dan interval yang sama (5 menit), sehingga run keduanya
mulai bersamaan; offset dijamin oleh `sleep 150` eksplisit sebagai
langkah pertama body ini (150 detik = 2,5 menit sesudah run tunnel
dimulai). Mekanisme ini deterministik dan tidak bergantung pada fase
anchor scheduler: bila anchor berubah saat aktivasi, offset 150 detik
tetap berlaku karena kedua jadwal berbagi anchor. JANGAN menambahkan
offset kedua lewat anchor `at` yang berbeda (akan menggandakan offset).
CATATAN ANGGARAN (DA18-N07): `timeout_secs: 300` SUDAH termasuk
`sleep 150`, menyisakan 150 detik untuk skrip; run tidak sehat dengan
polling penuh dapat melampauinya dan dibunuh scheduler di tengah
polling. Penyelarasan timeout/offset menunggu durasi terukur Uji B;
jangan menaikkan timeout diam-diam.

Prasyarat pemasangan (sekali, sebelum aktivasi; seluruhnya wajib
lulus check-config.sh):

1. Salin skrip TRUNK kini (cabang web, direktori infra/watchdog/,
   `notegen-compose-watchdog.sh`, 1567 baris / 59344 byte pada trunk
   afaba68b) ke jalur stabil ~/workspace/notegen-watchdog/ dengan
   nama yang sama, lalu chmod +x. JANGAN arahkan cron ke klon pekerja
   (jalur work/...) karena klon pekerja bersifat sementara. JANGAN
   memakai rakitan DEP-23 (watchdog-compose.sh lama, 2154 baris,
   model env-command, tidak pernah P-1).
2. Jalur proyek compose di muse-2 dan nama berkas compose sudah
   dikonfirmasi saat assembly (default skrip: /data/home/note-gen-web/
   + docker-compose.yml; ubah lewat env NOTEGEN_PROJECT_DIR /
   NOTEGEN_COMPOSE_FILE bila assembly memutuskan lain). PERINGATAN
   F-ABC-A1: stack live berjalan dari berkas dasar + override 5C;
   pemanggilan berkas tunggal menjatuhkan override dan membuat image
   api terurai ke tag yang ditolak registry. Bentuk pemanggilan yang
   benar menunggu putusan parent; workaround berdiri adalah pemulihan
   manual dua berkas (AD-196), bukan tindakan watchdog.
3. Port Caddy internal sudah dikonfirmasi (default 3200, kandidat
   K-05; ubah lewat NOTEGEN_CADDY_PORT bila peta port live berbeda).
4. Bila service worker sudah di-deploy, set NOTEGEN_WORKER_DEPLOYED=1
   (default 0 karena compose deploy Fase 1 tidak memuat service
   worker; worker gagal hanya jadi peringatan selama 0).
5. Helper ib.py (NOTEGEN_IB_PY, default trunk) wajib ada dan
   executable (mode 760 yang disyaratkan; F-01, DA18-K04). Verifikasi
   mode pada tiap jalan manual; regresi mode membuat run gagal
   exit 1 tanpa probe.
6. Berkas env ~/workspace/notegen-watchdog/watchdog.env dibuat dari
   infra/watchdog/cron/watchdog.env.example (kontrak env hidup saja,
   chmod 600, tanpa nilai secret).

Langkah tiap run (bentuk masa depan; JANGAN dijalankan kini):

1. Jalankan via shell: sleep 150; set -a; . "$HOME/workspace/notegen-watchdog/watchdog.env"; set +a; bash ~/workspace/notegen-watchdog/notegen-compose-watchdog.sh
   (tanpa argumen; konfigurasi lewat env. Timeout perintah 300 detik
   sudah termasuk sleep.)
2. Skrip menangani semuanya: probe internal, status container,
   diagnosis, satu tindakan + polling sampai 3 menit, pencatatan,
   jatah, dan masa tenggang pasca-resume (D-W2: worker 6 menit).

Pelaporan:

- Exit 0 (SEHAT, PULIH, atau MASA TENGGANG): diam, jangan kirim
  apapun ke chat. CATATAN: run yang dilewati karena lock juga keluar
  0 dan tidak dapat dibedakan dari run sehat lewat exit code saja
  (DA18-N07); sinyalnya hanya satu baris log.
- Exit 1 (masih gagal / tanpa tindakan yang diizinkan), exit 2
  (kredensial eksekusi ib.py), atau exit 3 (VM tidak terjangkau;
  skrip TIDAK me-resume VM, dan run ini tidak memakai jatah):
  laporkan ke chat asal dengan isi output apa adanya. Output skrip
  tidak memuat nilai secret (sudah disamarkan skrip).
- Log: ~/workspace/notegen-watchdog-logs/notegen-compose-watchdog-YYYY-MM-DD.log
  (satu berkas per hari, retensi 30 hari, D-W6). Bila MAINTENANCE ada
  di direktori log yang sama, skrip berjalan probe-saja (D-W3):
  mencatat, tidak me-restart. Prosedur pemeliharaan wajib mencakup
  KEDUA host (DA18-N12).

Larangan mutlak (spesifikasi seksi 6): jangan restart manual di luar
skrip; jangan sentuh knock, museai, Edge, atau 9Router; jangan
auto-resume atau force-resume VM; jangan port-publish; jangan prune;
semua perintah docker/compose bercakupan proyek NoteGen; jangan baca
atau tulis di luar direktori proyek NoteGen + artefak NoteGen.
Jangan pernah menampilkan nilai kredensial atau service token.
Jangan jalankan skrip dengan DRY_RUN pada jadwal produksi (DRY_RUN
hanya untuk pengujian). Jangan menjalankan skrip dengan flag
--self-test / --check-config / --reset-*: trunk tidak mem-parsing
argv, sehingga perintah itu menjalankan RUN LIVE PENUH, bukan uji
(DA18-K06). Verifikasi memakai bash -n + check-config.sh +
test-token-format.sh + jalan manual P-1 saja.
