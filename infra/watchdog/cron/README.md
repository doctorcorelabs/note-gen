# Definisi cron watchdog terkoreksi (BERKAS SIAP, TANPA AKTIVASI)

Berkas-berkas di direktori ini adalah DEFINISI SAJA. Tidak ada cron yang
diaktifkan oleh berkas-berkas ini, dan tidak ada berkas di sini yang
menulis crontab. Aktivasi cron apa pun DILARANG sampai putusan bersama
laporan Fase 1 + keputusan opsi B (AD-201 butir 6), dan sampai seluruh
gerbang pada seksi 3 di bawah terpenuhi. Perintah pemasangan tidak
disertakan di sini; yang disertakan hanyalah definisi, contoh env,
fragmen untuk digabung secara manual, dan pemeriksa baca-saja.

Bacaan: G32 (DA29-09 + DA18-K06), DA18-N06, DA18-K01/K02/K03/K04,
DA18-N07, DA18-N01, AD-138, AD-187 butir 1, AD-190 butir 3, AD-201
butir 6 dan 7, S-P0-10.

## 1. Berkas

- `notegen-tunnel-watchdog__interval@5m.md`: definisi cron.d tunnel
  terkoreksi, pengganti definisi tercatat di
  `~/workspace/cron.d/minutely/` (header dipertahankan verbatim dari
  definisi tercatat; isi dikoreksi). `enabled: false`. TERBLOKIR P-3.
- `notegen-compose-watchdog__interval@5m.md`: definisi cron.d compose
  terkoreksi, pengganti definisi tercatat. `enabled: false`. TERBLOKIR
  AD-201 butir 6 + F-ABC-A1.
- `watchdog.env.example`: contoh env dengan KONTRAK ENV HIDUP saja
  (variabel yang benar-benar dibaca skrip trunk). Salin menjadi
  `watchdog.env` di direktori instalasi saat instalasi diizinkan;
  berkas env tidak boleh berisi nilai secret (hanya jalur).
- `crontab.fragment`: fragmen 2 baris untuk crontab sistem. BUKAN
  crontab utuh. Jangan pernah memasangnya langsung; gabungkan dengan
  crontab lama lewat prosedur seksi 4 dan `merge-check.sh`.
- `check-config.sh`: pemeriksa kesiapan BACA-SAJA. Tidak pernah
  menjalankan skrip watchdog, tidak menyentuh jaringan/docker/crontab,
  tidak membaca nilai token (hanya keberadaan, mode, dan hitungan
  baris). Jalankan sebelum instalasi dan sesudah perubahan env.
- `merge-check.sh`: pembangun pratinjau gabungan crontab. Membaca
  salinan crontab lama yang diberikan operator + fragmen, menulis
  pratinjau gabungan untuk ditinjau. Tidak pernah memanggil `crontab`.

Draf DEP-23 (`fase1/deploy-prep/dep-23/cron-draft/`) TIDAK diubah oleh
cabang ini dan tetap artefak perencanaan yang dilarang dipakai sebagai
acuan pemasangan (AD-184 butir 13, R31-8). Definisi di sini
menggantikan draf itu sebagai acuan BILA DAN HANYA BILA aktivasi
diizinkan kelak; sampai saat itu, draf DEP-23 maupun definisi di sini
tidak boleh dipasang.

## 2. Koreksi terhadap draf DEP-23 + definisi tercatat (G32 + DA18-N06)

| Butir | Draf/definisi lama (salah) | Definisi ini (benar) |
|---|---|---|
| Skrip | Rakitan DEP-23 (1371 + 2154 baris, model env-command, tidak pernah P-1) | Trunk `infra/watchdog/` pada `afaba68b`: tunnel 1023 baris / 40212 byte, compose 1567 baris / 59344 byte, yang terverifikasi P-1/Uji A |
| Kontrak env | `NOTEGEN_HEALTH_URL`, `*_CMD`, `NOTEGEN_REMOTE_*`, `NOTEGEN_REQUIRE_*`, `NOTEGEN_CURL_TIMEOUT`, `NOTEGEN_REPROBE_WAIT`, `NOTEGEN_WAIT_AFTER_RESTART`, `NOTEGEN_POLL_INTERVAL`, `NOTEGEN_DEPLOY_LOCK_FILE`, `NOTEGEN_PGVECTOR_HARD`, `NOTEGEN_PROBE_TIMEOUT=10` (semuanya diabaikan trunk, kecuali probe timeout yang memangkas 25 menjadi 10) | Hanya variabel yang dibaca trunk (lihat `watchdog.env.example`); nama kanonis: `NOTEGEN_PUBLIC_URL`, `NOTEGEN_TUNNEL_REPROBE_WAIT`, `NOTEGEN_COMPOSE_POLL_INTERVAL`, `NOTEGEN_COMPOSE_WAIT_SECONDS`, `NOTEGEN_IB_PY`, `NOTEGEN_MUSE2_ID`, dan kawan-kawan |
| Jalur skrip | `$HOME/notegen-watchdog/`, nama `watchdog-tunnel.sh` / `watchdog-compose.sh` | `~/workspace/notegen-watchdog/`, nama `notegen-tunnel-watchdog.sh` / `notegen-compose-watchdog.sh` (AD-138 butir 5, AD-184) |
| Jalur log | `$HOME/.local/state/notegen-watchdog-*/` + format JSONL | `~/workspace/notegen-watchdog-logs/`, satu berkas teks per hari per watchdog, retensi 30 hari (D-W6) |
| Langkah 4 crontab | Backup dibuat tetapi tidak digabung; berkas baru hanya berisi draf (menimpa crontab lama) | Pola gabung aman seksi 4: crontab lama + fragmen, ditinjau, baru dipasang oleh operator; `merge-check.sh` menolak duplikasi baris notegen |
| Self-test / check-config | `--self-test`, `--check-config`, `--reset-probe-only`, `--reset-quota` | Trunk TIDAK mem-parsing argv sama sekali; flag itu akan menjalankan RUN LIVE PENUH. Pengganti: `bash -n`, `check-config.sh` (baca-saja), `test-token-format.sh` dari checkout, jalan manual P-1 |
| Launcher | Nama salah `notegen-tunnel.sh` tanpa override (F-02) | `start-tunnel.sh` lewat `NOTEGEN_TUNNEL_LAUNCHER` sampai default trunk diperbaiki (DA18-K02) |
| Penempatan token | Asumsi jalan dari VM operator + token di muse-2, tanpa membahas F-03 | AD-187: token hanya di muse-2, menyalin ke VM Muse DILARANG; definisi tunnel TIDAK DAPAT DIAKTIFKAN sampai P-3 diputus (DA18-N06) |

## 3. Gerbang aktivasi (SEMUA wajib terpenuhi; tidak satu pun terpenuhi kini)

1. Putusan bersama laporan Fase 1 + keputusan opsi B (AD-201 butir 6)
   + pencabutan STOP global + kata eksplisit user.
2. P-3 diputus (AD-201 butir 7) dan patch opsi yang diputus mendarat +
   terverifikasi (jalan manual + Uji C); definisi tunnel tidak dapat
   aktif sebelum ini.
3. Perbaikan F-ABC-A1 diputus parent (bentuk berkas tunggal watchdog
   compose menjatuhkan override 5C; DA18-K01, AD-195/AD-196).
4. Semantik exit 2 di bawah AD-170 diputus (DA18-N01): tanpa putusan,
   kontrak pelaporan cron akan melaporkan tiap 5 menit pada keadaan
   sehat.
5. Anggaran waktu compose diukur pada Uji B dan `timeout_secs` /
   offset diselaraskan (DA18-N07).
6. Prasyarat per definisi (skrip, env, mode `ib.py` 760, token,
   launcher, log) lulus `check-config.sh` pada host pelaksana yang
   benar.
7. Prosedur MAINTENANCE/state dua-host ditulis (DA18-N12).

## 4. Prosedur gabung crontab (hanya sesudah gerbang seksi 3 terpenuhi)

Prosedur ini TIDAK dijalankan kini. Ditulis di sini agar bentuk yang
benar tercatat dan bentuk draf lama yang menimpa tidak dipakai lagi.

1. Operator mengambil salinan crontab lama sendiri:
   `crontab -l > /tmp/notegen-cron-lama.txt` (bila crontab kosong,
   berkas kosong adalah keadaan yang sah; catat itu).
2. Operator menjalankan `merge-check.sh` dengan salinan lama +
   `crontab.fragment` untuk menghasilkan pratinjau gabungan.
   `merge-check.sh` menolak bila baris notegen sudah ada (hapus manual
   dulu; tidak ada penghapusan otomatis).
3. Operator meninjau pratinjau: seluruh baris lama utuh + 2 baris baru,
   jadwal benar, jalur benar, tidak ada nilai secret.
4. Hanya sesudah tinjauan, operator memasang gabungan dengan perintah
   crontab-nya sendiri dan memverifikasi dengan `crontab -l`.
5. Bukti aktivasi: tunggu dua interval, periksa run sehat di log teks
   harian (bukan JSONL), sesuai protokol P-1.

Rollback (menonaktifkan): hapus HANYA baris notegen dari crontab
dengan pola gabung terbalik (salin, saring, tinjau, pasang); tidak
menghapus log/state. Mode probe-saja darurat memakai berkas
`MAINTENANCE` di direktori log (AD-138 butir 4, D-W3); variabel
`NOTEGEN_DEPLOY_LOCK_FILE` tidak dibaca trunk dan tidak boleh dipakai.

## 5. Verifikasi yang diizinkan kini (tanpa aktivasi, tanpa run live)

- `bash -n` atas kedua skrip trunk + kedua skrip pemeriksa di sini.
- `check-config.sh --host <operator|muse2>` pada host yang relevan
  (baca-saja; tidak menjalankan watchdog).
- `test-token-format.sh` dari checkout trunk (nilai dummy + mock
  lokal + stub ib.py; tidak menyentuh muse-2).
- Validasi bentuk jadwal fragmen (5 field + perintah; lihat
  `merge-check.sh`).

Yang DILARANG kini: memasang cron apa pun; menulis crontab di host
mana pun; menjalankan skrip watchdog dengan flag apa pun (argv
diabaikan = run live); menyalin token; mengubah konfigurasi live.
