id: notegen-tunnel-watchdog
title: NoteGen tunnel watchdog (muse-2, publik)
enabled: false
mode: task
schedule:
  kind: interval
  timezone: Asia/Jakarta
  at: 2026-11-18T04:33:36
  every: 5m
timeout_secs: 300
---

AKTIVASI DITUNDA (AD-138) DAN TERBLOKIR P-3 (AD-201 butir 7).
Berkas ini hanya definisi tercatat: JANGAN diaktifkan sebelum kata
eksplisit user DAN putusan bersama laporan Fase 1 + keputusan opsi B
(AD-201 butir 6) DAN putusan P-3. Definisi ini TIDAK DAPAT
DIAKTIFKAN sebagaimana tertulis sebelum P-3 diputus (DA18-N06):
skrip membutuhkan berkas token DAN helper ib.py pada host yang sama,
tetapi token hanya ada di muse-2 dan ib.py hanya ada di VM operator
(AD-190 butir 3, DA18-K03). Jangan jadikan "definisi tercatat"
sebagai bukti kesiapan aktivasi.

Tujuan: jaga URL publik NoteGen tetap menjawab ready sehat. Skrip
memprobe GET URL publik /api/health/ready dengan header service token,
lalu bila gagal melakukan diagnosis internal pembeda SEBELUM restart
tunnel (spesifikasi-watchdog.md seksi 1). Satu restart tunnel per run,
maksimum 3 upaya gagal berturut-turut sebelum mode probe-saja (D-W1).
Di bawah AD-170, probe bertoken atas origin sehat menjawab 401 yang
diharapkan; semantik exit 2 pada keadaan itu masih terbuka (DA18-N01)
dan kontrak pelaporan di bawah belum boleh dipakai apa adanya.

Prasyarat pemasangan (sekali, sebelum aktivasi; seluruhnya wajib
lulus check-config.sh pada host pelaksana yang benar):

1. Salin skrip TRUNK kini (cabang web, direktori infra/watchdog/,
   `notegen-tunnel-watchdog.sh`, 1023 baris / 40212 byte pada trunk
   afaba68b) ke jalur stabil ~/workspace/notegen-watchdog/ dengan
   nama yang sama, lalu chmod +x. JANGAN arahkan cron ke klon pekerja
   (jalur work/...) karena klon pekerja bersifat sementara. JANGAN
   memakai rakitan DEP-23 (watchdog-tunnel.sh lama, 1371 baris,
   model env-command, tidak pernah P-1).
2. PENEMPATAN TOKEN (AD-187 butir 1, mengikat): berkas service token
   HANYA berada di muse-2 pada ~/.config/notegen-tunnel/service-token
   (0600, tepat 2 baris: baris 1 client id, baris 2 client secret).
   Menyalin service token ke VM Muse DILARANG. Skrip membaca token
   pada host tempat skrip berjalan; eksekusi dari VM operator tanpa
   token akan gagal bersih exit 2 selamanya tanpa pernah memprobe.
   Host pelaksana final ditentukan putusan P-3 (mode lokal di muse-2,
   atau probe jarak jauh dari VM operator); definisi ini tidak
   memutuskan host itu.
3. Launcher tunnel di muse-2 adalah start-tunnel.sh di
   /data/home/notegen-tunnel/start-tunnel.sh. Default trunk kini
   (notegen-tunnel.sh) SALAH (F-02, DA18-K02): set
   NOTEGEN_TUNNEL_LAUNCHER ke jalur start-tunnel.sh di berkas env
   sampai default trunk diperbaiki. Jangan mengandalkan default.
4. Bila host pelaksana adalah VM operator (Opsi P-3 B), helper ib.py
   (NOTEGEN_IB_PY, default trunk) wajib ada dan executable (mode 760
   yang disyaratkan; F-01, DA18-K04). Verifikasi mode pada tiap jalan
   manual; regresi mode membuat run gagal exit 1 tanpa probe.
5. Bila host pelaksana adalah muse-2 (Opsi P-3 A), daemon cron (atau
   penjadwal setara) di muse-2 wajib terverifikasi berjalan lewat
   cara baca-saja oleh operator (DA18-K03: pertanyaan masih terbuka;
   keberadaan berkas crontab tidak membuktikannya).
6. Berkas env ~/workspace/notegen-watchdog/watchdog.env dibuat dari
   infra/watchdog/cron/watchdog.env.example (kontrak env hidup saja,
   chmod 600, tanpa nilai secret; hanya jalur berkas token).

Langkah tiap run (bentuk masa depan; JANGAN dijalankan kini):

1. Jalankan via shell: set -a; . "$HOME/workspace/notegen-watchdog/watchdog.env"; set +a; bash ~/workspace/notegen-watchdog/notegen-tunnel-watchdog.sh
   (tanpa argumen; konfigurasi lewat env. Timeout perintah 300 detik.
   Host pelaksana mengikuti putusan P-3.)
2. Skrip menangani semuanya: probe luar, diagnosis internal lewat
   jalur yang diputus P-3, restart tunnel bila diagnosis membuktikan
   tunnel yang mati, probe ulang, pencatatan, dan mode probe-saja.

Pelaporan (kontrak ini membutuhkan putusan semantik DA18-N01 sebelum
aktivasi; jangan aktifkan dengan kontrak ini apa adanya):

- Exit 0 (SEHAT atau PULIH): diam, jangan kirim apapun ke chat.
- Exit 1 (masih gagal / tanpa tindakan yang diizinkan), exit 2
  (kredensial tepi: HTTP 401/403/302 atau berkas token bermasalah;
  BUKAN masalah tunnel, tanpa restart), atau exit 3 (VM tidak
  terjangkau): laporkan ke chat asal dengan isi output apa adanya.
  Output skrip tidak memuat nilai secret (sudah disamarkan skrip).
- Log: ~/workspace/notegen-watchdog-logs/notegen-tunnel-watchdog-YYYY-MM-DD.log
  pada HOST PELAKSANA (satu berkas per hari, retensi 30 hari, D-W6).
  Di bawah penempatan AD-187, log run tunnel berada di muse-2
  (F-04). Bila MAINTENANCE ada di direktori log yang sama, skrip
  berjalan probe-saja (D-W3): mencatat, tidak me-restart. Prosedur
  pemeliharaan wajib mencakup KEDUA host (DA18-N12).

Larangan mutlak (spesifikasi seksi 6): jangan restart manual di luar
skrip; jangan sentuh knock, museai, Edge, atau 9Router; jangan
auto-resume atau force-resume VM; jangan port-publish; jangan baca
atau tulis di luar direktori proyek NoteGen + artefak NoteGen.
Jangan pernah menampilkan nilai kredensial atau service token.
Jangan jalankan skrip dengan DRY_RUN pada jadwal produksi (DRY_RUN
hanya untuk pengujian). Jangan menjalankan skrip dengan flag
--self-test / --check-config / --reset-*: trunk tidak mem-parsing
argv, sehingga perintah itu menjalankan RUN LIVE PENUH, bukan uji
(DA18-K06). Verifikasi memakai bash -n + check-config.sh +
test-token-format.sh + jalan manual P-1 saja.
