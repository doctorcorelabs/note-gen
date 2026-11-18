<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!-- This file is part of the NoteGen web fork, licensed under the GNU General Public License v3. See LICENSE and FORK.md. -->
# Watchdog NoteGen

Dua skrip watchdog Fase 1 (spesifikasi: `fase1/spesifikasi-watchdog.md`,
putusan AD-133 dan AD-138). Keduanya jalan dari VM operator, bukan dari
muse-2, dan memakai `flock` agar tidak berjalan ganda. Aktivasi sebagai
cron berulang DITUNDA sampai kata eksplisit user (AD-138 butir 7); yang
ada saat ini adalah skrip + definisi cron nonaktif + uji manual.

## Berkas

- `notegen-tunnel-watchdog.sh`: probe jalur publik + restart tunnel.
- `notegen-compose-watchdog.sh`: probe origin + restart service compose.
- `README.md`: berkas ini.

Kedua skrip berdiri sendiri (tanpa pustaka bersama). Aturan validasi
jawaban health (validator Python di dalam tiap skrip) wajib tetap identik
di keduanya; bila satu diubah, ubah yang lain dan buktikan dengan diff.

## Cara kerja singkat

Watchdog tunnel memprobe `GET https://notegen.synapxs.my.id/api/health/ready`
dengan service token Access (timeout 25 detik). Sehat ditentukan oleh
CHECKS: amplop JSON valid + check `db`/`workspace`/`migrations` ok +
`worker` ok bila sudah di-deploy, atas jawaban HTTP 200 atau 503 (dua kode
jawaban endpoint ready). Nilai `ok`/`status` tingkat atas TIDAK memveto:
API melipat check non-blokir (pgvector, worker yang belum di-deploy) ke
dalam `ok`/`status`/kode, sehingga veto mentah membuat aturan non-blokir
mustahil; ketidaksesuaian `ok`/`status` dengan checks dicatat sebagai
peringatan `envelope_inconsistent`. HTTP 401/403/302 berarti masalah
kredensial tepi: exit 2, tanpa restart, tanpa menghubungi muse-2. Gejala
lain (000/timeout/5xx/body bukan JSON/jawaban tidak valid) masuk urutan
diagnosis: probe internal pembeda dulu; restart tunnel (maksimal 1 per run,
tunggu 15 detik, probe ulang 1 kali) hanya bila probe internal sehat.
Sesudah 3 upaya restart gagal berturut-turut, masuk mode probe-saja sampai
satu probe sehat atau reset manual.

Watchdog compose memprobe origin di muse-2 lewat `ib.py` (lihat seksi jalur
probe di bawah), lalu mendiagnosis dengan pasangan (live, ready) + status
container. Tindakan maksimal 1 per run, lalu polling tiap 15 detik sampai
3 menit. Jatah: maksimal 2 restart service yang sama dalam 1 jam untuk
kegagalan yang sama; kegagalan drift/stale/konfigurasi tunduk aturan ketat
(restart kedua hanya bila gejala berubah; konfigurasi dan workspace tidak
pernah di-restart). Restart seluruh stack hanya untuk kondisi seksi 2.4
(lebih dari satu service mati; kegagalan meluas; pasca-resume).

## Jalur probe (AD-133 A1)

Verifikasi Access di origin mengecualikan `GET /api/health/ready` hanya
untuk peer loopback soket (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`); probe
yang tiba lewat Caddy (peer = IP container Caddy) wajib membawa JWT valid.
`GET /api/health/live` bebas untuk semua peer. Konsekuensinya:

- Probe internal utama watchdog compose adalah ready langsung loopback di
  dalam container api (`docker compose exec api`, fetch ke
  `127.0.0.1:3001`), tanpa token. Probe ready lewat Caddy
  (`http://127.0.0.1:<PORT>/api/health/ready` dari host muse-2) tetap
  dijalankan tiap run sebagai pembanding: 200 + valid berarti jalur Caddy
  sehat; 401/403 berarti jalur Caddy dijaga Access sebagaimana dirancang
  (bukan kegagalan origin); gagal lain + langsung sehat berarti Caddy
  dicurigai. Watchdog compose tidak membaca berkas token; jalur token
  diuji ujung-ke-ujung oleh probe publik watchdog tunnel.
- Probe internal watchdog tunnel memakai pasangan probe yang sama, dengan
  putusan: internal sehat hanya bila ready lewat Caddy valid, atau ready
  langsung valid + Caddy menjawab 401/403.

PORT Caddy dapat diubah lewat `NOTEGEN_CADDY_PORT` (default 3200, kandidat
K-05; konfirmasi terhadap peta port live saat setup). Port API internal
dapat diubah lewat `NOTEGEN_API_PORT` (default 3001).

## Konfigurasi (environment)

Bersama:

| Variabel | Default | Arti |
|---|---|---|
| `NOTEGEN_IB_PY` | `~/workspace/custom-connectors/custom.instabox-muse2/bin/ib.py` | helper eksekusi jarak jauh (argumen `--id`) |
| `NOTEGEN_MUSE2_ID` | `m_agqydoqzdmqmstatkg6mkqcymi` | id mesin muse-2 |
| `NOTEGEN_CADDY_PORT` | `3200` | port host Caddy (kandidat K-05) |
| `NOTEGEN_API_PORT` | `3001` | port API di dalam container |
| `NOTEGEN_PROJECT_DIR` | `/data/home/note-gen-web` | direktori rakitan compose di muse-2 |
| `NOTEGEN_COMPOSE_FILE` | `docker-compose.yml` | berkas dasar compose di direktori rakitan |
| `NOTEGEN_COMPOSE_OVERRIDE_FILE` | `docker-compose.override.yml` | berkas override compose di direktori rakitan; selalu dipakai bersama berkas dasar (lihat seksi bentuk pemanggilan) |
| `NOTEGEN_COMPOSE_ALLOW_SINGLE_FILE` | `0` | `1` = izinkan bentuk satu berkas secara eksplisit; tercatat di log tiap run |
| `NOTEGEN_INTERNAL_PROBE_TIMEOUT` | `10` | timeout detik probe internal |
| `NOTEGEN_LOG_DIR` | `~/workspace/notegen-watchdog-logs` | direktori log + state (D-W6) |
| `NOTEGEN_MAINTENANCE_FILE` | `$NOTEGEN_LOG_DIR/MAINTENANCE` | sinyal pemeliharaan (D-W3) |
| `NOTEGEN_DRY_RUN` | `0` | `1` = catat tindakan, jangan eksekusi restart |
| `NOTEGEN_MIGRATIONS_REQUIRED` | `1` | `1` = check migrations wajib ok |
| `NOTEGEN_WORKER_DEPLOYED` | `0` | `1` = check worker wajib ok (set saat worker di-deploy) |

Khusus tunnel: `NOTEGEN_PUBLIC_URL` (default URL publik ready),
`NOTEGEN_TOKEN_FILE` (default `~/.config/notegen-tunnel/service-token`),
`NOTEGEN_PROBE_TIMEOUT` (default 25),
`NOTEGEN_TUNNEL_LAUNCHER` (default
`/data/home/notegen-tunnel/notegen-tunnel.sh`),
`NOTEGEN_TUNNEL_REPROBE_WAIT` (default 15),
`NOTEGEN_TUNNEL_PROBEONLY_AFTER` (default 3).

Khusus compose: `NOTEGEN_COMPOSE_POLL_INTERVAL` (default 15),
`NOTEGEN_COMPOSE_WAIT_SECONDS` (default 180),
`NOTEGEN_MAX_RESTARTS_PER_HOUR` (default 2),
`NOTEGEN_QUOTA_WINDOW_SECONDS` (default 3600),
`NOTEGEN_RESUME_GRACE_WORKER_SECONDS` (default 360),
`NOTEGEN_RESUME_GRACE_GENERAL_SECONDS` (default 180).

## Bentuk pemanggilan compose (dua berkas)

Bentuk kanonis semua pemanggilan compose watchdog adalah dua berkas:
`docker compose -f docker-compose.yml -f docker-compose.override.yml ...`.
Satu `-f` menjatuhkan pemuatan otomatis `docker-compose.override.yml`
oleh Compose, sehingga image terurai ke `PLACEHOLDER_TAG` di berkas
dasar dan registry menolak pull (F-ABC-A1, AD-195/AD-196: API mati
15 menit 42 detik pada Uji A). Bentuk satu berkas tidak pernah dipakai
secara diam-diam oleh skrip mana pun.

Setiap templat perintah jarak jauh memeriksa keberadaan kedua berkas
di muse-2 sebelum memanggil compose dan melaporkan hasilnya sebagai
`COMPOSE_GUARD` (kumpul probe, diagnosis) atau `ACTION_GUARD`
(tindakan). Nilai guard: `ok`, `missing_base`, `missing_override`,
`no_project_dir`, dan khusus tindakan `placeholder_image` serta
`config_unresolved`. Guard kumpul probe atau tindakan yang bukan `ok` berarti run berakhir
exit 1 tanpa tindakan (compose: tanpa pemakaian jatah dan tanpa
polling; tunnel: tanpa restart), dengan baris `ERROR` di log. Guard
diagnosis yang bukan `ok` dicatat sebagai `ERROR` dan hasil diagnosis
tidak dipakai; tindakan sesudahnya tetap ditolak guard tindakan.
Bentuk berkas yang dipakai tiap run tercatat pada baris log
`compose_files` dan pada baris `probe_internal`/`diagnosis`.

Tindakan `up` (stack maupun per-service atas container hilang)
ditolak tambahan bila `docker compose config` atas bentuk dua
berkas masih memuat `PLACEHOLDER_TAG`, atau bila konfigurasi tidak
dapat diurai. Keluaran `config` hanya diuji polanya dan tidak pernah
dicatat. Tindakan `restart` tidak memakai uji placeholder (restart
tidak mengurai image) tetapi tetap tunduk pada guard keberadaan
berkas. Bentuk satu berkas hanya lewat
`NOTEGEN_COMPOSE_ALLOW_SINGLE_FILE=1` yang eksplisit; penolakan
placeholder untuk `up` tetap berlaku pada bentuk itu. Baris log
`DRY_RUN` menampilkan bentuk berkas yang persis akan dipakai.

## Berkas token (milik Q1A, bukan skrip ini)

Watchdog tunnel membaca service token Access dari berkas 0600 khusus
`~/.config/notegen-tunnel/service-token` di VM operator. Format kanonis
(AD-145; runbook Q1A seksi 3.7): tepat 2 baris bernilai, baris 1 client
id dan baris 2 client secret, tanpa spasi, tanpa tab, tanpa tanda kutip,
tanpa backslash, dan tanpa prefix `Bearer` di kedua baris. Tidak ada
baris ketiga bernilai; baris kosong akhir berkas dan newline final
diterima, dan CR akhir baris di-strip. Format satu baris `id:secret`
DITOLAK; tidak ada dukungan format ganda. Token diterbitkan Q1A; pekerja
watchdog tidak membuat, mengubah, atau menampilkan nilainya. Bila berkas
tidak ada atau formatnya salah, skrip gagal bersih exit 2 tanpa probe.
Peringatan dicatat bila mode berkas bukan 0600. Nilai token tidak pernah
masuk log/stdout.

## Kontrak launcher tunnel (milik Q1A)

Launcher di `NOTEGEN_TUNNEL_LAUNCHER` wajib idempoten, kembali dengan
cepat, dan mencetak tepat satu penanda hasil: frasa `sudah berjalan` bila
tunnel sudah hidup (tidak berbuat apa-apa), atau frasa `dimulai` bila
tunnel memang di-start. Watchdog membedakan keduanya dari output launcher
dan mencatatnya; bila tidak ada penanda, hasilnya dicatat tidak diketahui
dan putusan mengandalkan probe ulang. Bila launcher tidak ada atau tidak
executable, watchdog tidak me-restart dan exit 1 (tanpa hitung kegagalan).
Path default di atas adalah nilai harapan; bila Q1A menamainya lain, set
`NOTEGEN_TUNNEL_LAUNCHER` di definisi cron dan catat di runbook.

## Perintah jarak jauh (inventaris lengkap)

Hanya subcommand `ib.py` `exec` dan `get` yang dipakai (selalu `--id`).
Perintah remote yang dijalankan:

- Kumpul probe (baca saja): `curl` loopback ke Caddy (ready + live),
  `docker compose -f <dasar> -f <override> exec api` (ready + live
  langsung), `docker compose -f <dasar> -f <override> ps` (compose
  saja). Semua di dalam direktori proyek + kedua berkas compose,
  sesudah guard keberadaan berkas lulus (lihat seksi bentuk
  pemanggilan).
- Diagnosis compose (baca saja): `pg_isready` di container postgres,
  stat direktori workspace dari container api (tanpa mengubah apa pun),
  keduanya lewat bentuk dua berkas + guard yang sama.
- Tindakan compose: `docker compose -f <dasar> -f <override> restart
  <service>` (allowlist: caddy/web/api/postgres/worker),
  `docker compose -f <dasar> -f <override> up -d <service>` bila
  container service hilang, atau `... up -d` seluruh stack hanya
  untuk kondisi seksi 2.4; tindakan `up` ditolak guard bila
  konfigurasi terurai memuat `PLACEHOLDER_TAG`. Tanpa flag
  build/recreate paksa.
- Tindakan tunnel: menjalankan launcher di atas, tidak ada yang lain.

Skrip tidak menjalankan perintah penghapus data/volume, pembersihan image
atau sistem, operasi lifecycle mesin, publikasi port, atau perintah apa
pun di luar direktori proyek + artefak NoteGen. Skrip tidak menyentuh
layanan lain di muse-2 dan tidak memeriksa apakah layanan lain hidup.
Perintah jarak jauh selalu diakhiri `exit 0` di sisi remote dengan status
asli di dalam payload berpenanda, sehingga kegagalan `ib.py` hanya berarti
masalah transpor/API/kredensial/VM. Bentuk JSON respons `ib.py` tidak
dikunci: ekstraktor mencari blok payload di semua nilai string respons.

## Exit code

- `0`: sehat, pulih sesudah tindakan, atau masa tenggang worker (grace).
- `1`: tetap gagal, tanpa tindakan yang diizinkan, atau kegagalan
  konfigurasi/perkakas lokal. Jatah restart tidak dipakai bila tindakan
  tidak benar-benar dicoba.
- `2`: masalah kredensial (tepi: 401/403/302 publik atau berkas token;
  eksekusi: penolakan otorisasi `ib.py`). Tanpa restart.
- `3`: VM tidak terjangkau. Tanpa tindakan, tanpa auto-resume dalam
  bentuk apa pun. Bila keadaan mesin tidak dapat dipastikan, dilaporkan
  sebagai tidak terjangkau tanpa mengklaim keadaan mesin.

Lock contention (run sebelumnya masih berjalan) keluar 0 tanpa bertindak.

## Log, state, pemeliharaan

Log: satu berkas per watchdog per hari di `NOTEGEN_LOG_DIR`
(`notegen-tunnel-watchdog-YYYY-MM-DD.log`,
`notegen-compose-watchdog-YYYY-MM-DD.log`), stempel WIB, retensi minimum
30 hari (berkas lebih tua dari 30 hari dihapus tiap run). Log memuat kode
HTTP, nilai `ok`/`status`, nama check yang gagal + kode error katalog,
hasil probe pembeda, status container, tindakan, hasil probe ulang, dan
perubahan keadaan. Body mentah, nilai token/header/secret/DSN, dan pesan
error mentah driver tidak pernah dicatat. State (hitung kegagalan,
penanda mode probe-saja, jatah restart, episode resume, keadaan lalu)
tinggal di `$NOTEGEN_LOG_DIR/state/` dan hanya memuat angka/waktu/nama.

Bila berkas `MAINTENANCE` ada di direktori log (D-W3), kedua watchdog
masuk mode probe-saja: memprobe dan mencatat, tidak me-restart. Exit code
tetap mencerminkan kesehatan yang diamati. Reset manual mode probe-saja
tunnel: hapus `$NOTEGEN_LOG_DIR/state/tunnel-probe-only` dan catat
resetnya di PROGRESS. Satu probe ready sehat penuh me-reset seluruh jatah
restart compose; reset manual jatah: hapus
`$NOTEGEN_LOG_DIR/state/compose-quotas` dan catat alasannya.

Masa tenggang pasca-resume (D-W2): sejak kontak pertama yang berhasil
sesudah periode tidak terjangkau, worker tidak dinyatakan bermasalah
selama 6 menit (stale 5 menit + 60 detik startup), dan tidak ada restart
dalam 3 menit pertama (polling sampai tenggang habis). Episode berakhir
sesudah 1 jam.

## Jalankan manual

```sh
bash infra/watchdog/notegen-tunnel-watchdog.sh
bash infra/watchdog/notegen-compose-watchdog.sh
NOTEGEN_DRY_RUN=1 bash infra/watchdog/notegen-compose-watchdog.sh
```

Uji format berkas token (tanpa muse-2, tanpa jaringan luar; server mock
lokal + stub `ib.py` di direktori temporer):

```sh
bash infra/watchdog/test-token-format.sh
```

Jalan manual sehat per skrip adalah bukti aktivasi pada penerimaan fase
5D (aktivasi cron berulang ditunda, AD-138). Sebelum aktivasi cron: salin
kedua skrip dari trunk yang sudah merge ke path stabil
`~/workspace/notegen-watchdog/` (definisi cron mengarah ke sana; jangan
arahkan cron ke klon pekerja), jadikan executable, dan verifikasi satu
jalan manual sehat per skrip dari path itu.

## Batas terbuka

- Nama berkas compose rakitan (`docker-compose.yml` vs `-f` dari direktori
  infra) dan path launcher mengikuti slot rakitan/Q1A; default di sini
  adalah nilai harapan yang wajib dikonfirmasi saat setup dan dicatat di
  runbook. Watchdog gagal aman (tanpa tindakan) bila artefaknya tidak ada.
  Berkas override wajib ada secara default; bentuk satu berkas hanya
  lewat `NOTEGEN_COMPOSE_ALLOW_SINGLE_FILE=1` (lihat seksi bentuk
  pemanggilan).
- Compose deploy di trunk tidak memiliki service `worker` (G2/K-13):
  watchdog tidak pernah me-restart service yang tidak ada; kegagalan
  worker tanpa service worker berarti eskalasi. Set
  `NOTEGEN_WORKER_DEPLOYED=1` hanya sesudah worker nyata di-deploy.
- Bentuk healthcheck container API dan probe liveness web (D-W4/D-W5)
  belum diputus; watchdog menilai web lewat status container + healthcheck
  apa pun bentuknya, dan Caddy lewat perbandingan probe, bukan healthcheck.
- Perilaku bentuk JSON `ib.py` atas perintah remote yang gagal tidak
  pernah diamati langsung oleh slot ini (muse-2 tidak disentuh); desain
  payload + ekstraktor toleran dibuat untuk itu dan wajib dikonfirmasi
  pada jalan manual pertama terhadap muse-2 di fase 5D.
