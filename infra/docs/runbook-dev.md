<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!-- This file is part of the NoteGen web fork, licensed under the GNU General Public License v3. See LICENSE and FORK.md. -->
# Runbook Stack Dev (Compose + Caddy)

> STATUS JUJUR: kerangka gelombang 1 Fase 1 (pekerja V1-07). Stack ini
> BELUM PERNAH DIJALANKAN. Tidak ada Docker atau Caddy di VM penulis,
> sehingga `docker-compose.dev.yml` baru divalidasi sintaks YAML-nya dan
> `Caddyfile.dev` belum divalidasi sama sekali. Jangan mengklaim stack
> ini jalan sebelum uji T16 lewat proksi (bagian 7) lulus dan buktinya
> tercatat. Daftar lengkap hal yang belum teruji ada di bagian 10.

## 1. Gambaran stack

Satu pintu Caddy di `http://127.0.0.1:3200` (AD-18). Arsitektur mengikuti
desain F10 bagian 4 dan keputusan AD-18/AD-19, dengan penyesuaian DEV yang
dicatat eksplisit. Frontend adalah static export Next.js (`output: export`,
AD-04/AD-22), bukan server Next.js.

| Service | Image | Port | Peran |
|---|---|---|---|
| `caddy` | `caddy:2-alpine` | Host `127.0.0.1:3200:80` (satu-satunya port terpublikasi) | Satu pintu: `/api/*` ke api, sisanya ke web |
| `web` | `nginx:alpine` | Internal `80` | Menyajikan `out/` hasil build frontend di host (read-only) |
| `api` | `node:24-bookworm-slim` | Internal `3001` | API Fastify dari `server/` (bind mount, install + build + start di container) |
| `worker` | `node:24-bookworm-slim` | Tanpa port | PLACEHOLDER: idle, belum ada kode worker |
| `postgres` | `postgres:17-alpine` | Internal `5432` | Database, volume bernama `pgdata` |

Semua service memakai `restart: unless-stopped`. Volume bernama:
`notegen_dev_pgdata` (data Postgres) dan `notegen_dev_workspace`
(berkas workspace, di-mount ke `/workspace` di api). Tidak ada service
selain Caddy yang memublikasi port ke host.

Perbedaan DEV vs produksi yang disengaja (jangan disalin ke produksi
tanpa tinjauan):

- Api memakai image dasar Node + bind mount karena Dockerfile API belum
  ada di gelombang 1. Image produksi dibangun CI/GHCR pada gelombang 5.
- Web memakai nginx + bind mount `out/` hasil build di host, bukan image
  hasil build.
- Worker adalah placeholder idle, bukan worker nyata.
- Tanpa TLS, tanpa Cloudflare Access, tanpa auth. Health path memang
  tanpa auth aplikasi sesuai desain (W07); endpoint data yang datang
  kemudian wajib menolak tanpa kredensial.
- Caddyfile dev tanpa CSP dan tanpa filter log token (lihat bagian 11).

## 2. Prasyarat

- Docker + Docker Compose v2 di mesin yang menjalankan stack. Mesin
  penulis (VM ini) TIDAK memilikinya; jalankan stack di mesin yang
  memilikinya (mis. mesin dev atau muse-2 saat waktunya tiba, mengikuti
  keputusan deploy).
- Node 24 + pnpm 9 di host, untuk build frontend (bagian 4).
- Berkas env sudah dibuat (bagian 3). Tanpa `server/.env` dan
  `infra/.env`, compose gagal start dan itu perilaku yang disengaja
  (fail closed, bukan default diam-diam).
- Port host `3200` bebas. Port ini kandidat (F10 bagian 4.1); bila
  bentrok, ubah HANYA pemetaan `ports` pada service `caddy` di
  `docker-compose.dev.yml`. `Caddyfile.dev` tetap `:80`.

## 3. Setup env

Dua berkas env, sesuai kepemilikan yang sudah ada. Keduanya TIDAK PERNAH
di-commit. Nilai di bawah ini placeholder; ganti seluruhnya.

### 3.1 `server/.env` (untuk service api)

```sh
cp server/.env.example server/.env
chmod 600 server/.env
```

Isi yang wajib benar untuk stack compose (lihat `server/.env.example`
untuk daftar lengkap dan komentarnya):

- `DATABASE_URL`: DSN Postgres dengan host `postgres` (nama service
  compose), BUKAN `localhost`. Bentuknya:

  ```text
  DATABASE_URL=postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<POSTGRES_DB>
  ```

  User, password, dan nama database HARUS SAMA dengan `POSTGRES_USER`,
  `POSTGRES_PASSWORD`, dan `POSTGRES_DB` di `infra/.env` pada deployment
  yang sama. Bila tidak sama, check `db` pada ready menjawab 503
  (`DB_AUTH_FAILED` atau `DB_NOT_FOUND`) dan itu sinyal yang benar.
- `WORKSPACE_ROOT`: nilai di `server/.env` DIGANTI oleh compose menjadi
  `/workspace` (lihat `environment` pada service api). Tetap isi dengan
  path absolut yang valid agar berkas ini tetap benar untuk jalan
  native di luar compose.
- `HOST` dan `PORT`: nilai di `server/.env` DIGANTI oleh compose
  menjadi `0.0.0.0` dan `3001`. Penggantian ini disengaja: di dalam
  container, api harus mendengarkan semua interface agar Caddy dalam
  jaringan compose dapat menjangkaunya.
- Variabel Bagian B di `server/.env.example` (secret auth, token
  layanan, verifikasi Access) belum dibaca kode Fase 0/awal Fase 1.
  Isi placeholder-nya saja; jangan menganggapnya aktif sebelum kodenya
  ada.

Catatan: `server/.env` yang sama dipakai untuk jalan native (di luar
compose) dan untuk compose, tetapi nilai `DATABASE_URL` berbeda host
(`localhost` untuk native, `postgres` untuk compose). Bila berpindah
cara jalan, sesuaikan host pada `DATABASE_URL`. Jangan membuat berkas
env ketiga untuk menutupi perbedaan ini tanpa keputusan desain.

### 3.2 `infra/.env` (untuk service postgres)

```sh
cp infra/.env.example infra/.env
chmod 600 infra/.env
```

Isi ketiga variabel (lihat `infra/.env.example`):

```text
POSTGRES_DB=CHANGE_ME_DB
POSTGRES_USER=CHANGE_ME_USER
POSTGRES_PASSWORD=CHANGE_ME_PASSWORD
```

Ketiganya wajib diisi dan wajib cocok dengan `DATABASE_URL` di
`server/.env` (bagian 3.1). Variabel ini hanya dibaca compose/entrypoint
Postgres; aplikasi tidak membacanya langsung.

### 3.3 Aturan secret

- Secret hanya lewat berkas env. `docker-compose.dev.yml` tidak memuat
  nilai secret dan tidak merakit `DATABASE_URL` dari potongan.
- Berkas `.env` nyata dilarang di-commit dan dilarang masuk log, laporan,
  atau tangkapan layar. Bila nilai nyata pernah tertulis di tempat yang
  salah, rotasi nilainya dan catat insidennya; jangan hanya menghapus
  tulisannya.
- Nilai env_file diteruskan apa adanya ke container; tidak ada
  interpolasi `${...}` di berkas compose dev ini, sehingga tidak ada
  aturan escape `$$` untuk nilai env. Satu-satunya `$$` di berkas
  compose ada di healthcheck postgres dan itu escape compose untuk
  ekspansi env di dalam container, bukan bagian dari nilai.

## 4. Build frontend (host)

Service `web` menyajikan direktori `out/` di root repo. Build di host
sebelum `up` (build ini terbukti lulus di Fase 0: 64/64 halaman):

```sh
pnpm install --frozen-lockfile
pnpm build
```

Periksa `out/index.html` ada. `out/` di-ignore git dan tidak di-commit.
Perubahan kode frontend sesudahnya: build ulang di host; nginx membaca
dari disk per request sehingga `out/` yang baru tersaji tanpa restart
container (perilaku ini belum teruji di stack ini, lihat bagian 10).

## 5. Menjalankan stack

Dari direktori `infra/` (penting: jalankan dari sini agar path relatif
env_file dan bind mount terurai benar):

```sh
cd infra
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs -f
```

Start pertama memakan waktu: penarikan image, lalu service api
memasang dependensi (`pnpm install --frozen-lockfile`), membangun
(`pnpm build`), dan menjalankan server. Healthcheck api diberi masa
tenggang start 60 detik; jangan menyimpulkan gagal dari start yang
lambat. Periksa log api bila ragu:

```sh
docker compose -f docker-compose.dev.yml logs api
```

Perubahan kode `server/`: restart service api agar install + build
berjalan ulang (tidak ada hot reload pada kerangka dev ini):

```sh
docker compose -f docker-compose.dev.yml restart api
```

URL yang dihadapi pengguna dev: `http://127.0.0.1:3200`.

## 6. Cek health live/ready

Health adalah satu-satunya bukti stack hidup. Halaman root yang tampil
(HTML 200) TIDAK membuktikan aplikasi hidup (jebakan false-OK D1).
Selalu cek endpoint health, lewat proksi dan langsung.

### 6.1 Lewat proksi (cara utama)

```sh
curl -s -i http://127.0.0.1:3200/api/health/live
curl -s -i http://127.0.0.1:3200/api/health/ready
curl -s http://127.0.0.1:3200/api/health
```

Hasil yang diharapkan saat sehat:

- Live: HTTP 200, `ok: true`, `status: "live"`, hanya kunci check
  `process`. Live tidak pernah menyentuh DB atau disk.
- Ready: HTTP 200, `ok: true`, `status: "ready"`, check `db` dan
  `workspace` berstatus `ok`. Pada Fase 0/awal Fase 1, `migrations`
  dan `worker` berstatus `skipped` dan `pgvector` dapat berstatus
  `fail` + `PGVECTOR_MISSING` secara jujur dan non-blokir bila
  ekstensi `vector` tidak tersedia di image Postgres yang dipakai.
  Kontrak ini terkunci di desain health (W07); jangan mengubah
  interpretasinya di sini.
- Alias `/api/health`: sama dengan ready, kecuali field waktu/latensi.
- Semua respons membawa `Cache-Control: no-store`.

Hasil yang diharapkan saat dependensi gagal (bukan cacat, tetapi
sinyal yang benar):

- Postgres mati atau DSN salah: live tetap 200, ready 503 +
  `ok: false` + `status: "not_ready"` dengan check `db` berstatus
  `fail` dan kode error katalog W07.
- Workspace tidak dapat ditulis: live 200, ready 503 dengan check
  `workspace` berstatus `fail`.

### 6.2 Langsung ke container (tanpa proksi)

Untuk membedakan gagalnya proksi dari gagalnya api:

```sh
docker compose -f docker-compose.dev.yml exec api node -e "fetch('http://127.0.0.1:3001/api/health/live').then(async r => console.log(r.status, await r.text())).catch(() => { console.error('FAIL'); process.exit(1); })"
docker compose -f docker-compose.dev.yml exec postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose -f docker-compose.dev.yml ps
```

`ps` menampilkan status healthcheck per service (`healthy`,
`unhealthy`, `starting`). Bila probe langsung lulus tetapi probe
lewat proksi gagal, masalahnya ada di Caddy/routing, bukan di api.

### 6.3 Log worker placeholder

```sh
docker compose -f docker-compose.dev.yml logs worker
```

Harapan: satu baris status placeholder lalu tidak ada aktivitas.
Container worker berstatus Up TIDAK berarti fungsi worker ada; check
`worker` pada ready tetap `skipped` sampai worker nyata mendarat.

## 7. Rencana uji T16 lewat proksi

T16 adalah uji health lewat proksi (desain W07, rencana T01-T16).
Di Fase 0, T16 DITUNDA karena belum ada compose + Caddy, dan dicatat
sebagai utang uji (F1-56) yang WAJIB dijalankan sebelum deploy pertama.
T16 adalah satu-satunya uji yang membuktikan tidak ada false OK lewat
proksi. Skenario di bawah ini adalah rencana; BELUM DIJALANKAN.

Prasyarat jalan uji: stack hidup dan skenario T16-1 lulus. Catat
perintah dan output mentah tiap skenario ke bukti uji (direktori
`evidence/` milik pekerja yang menjalankan T16 di pohon perencanaan,
bukan di repo). Jangan melaporkan lulus tanpa output mentah.

| ID | Skenario | Perintah kunci | Hasil yang diharapkan |
|---|---|---|---|
| T16-1 | Sehat lewat proksi | `curl` live, ready, alias via `127.0.0.1:3200` (bagian 6.1) | Live 200 + `ok: true`; ready 200 + `ok: true` (dengan `skipped`/peringatan jujur sesuai bagian 6.1); alias sama dengan ready |
| T16-2 | Api mati | `docker compose -f docker-compose.dev.yml stop api`, lalu `curl` live + ready via proksi; hidupkan lagi | TIDAK ADA respons 200 + `ok: true` dari proksi. Harapan: 502 dari Caddy (atau refused/timeout), tanpa JSON `ok: true`. Respons 200 + `ok: true` saat api mati adalah FAIL dan berarti proksi/cache menjawab palsu |
| T16-3 | Postgres mati | `docker compose -f docker-compose.dev.yml stop postgres`, lalu `curl` live + ready via proksi; hidupkan lagi, ready pulih TANPA restart api | Live 200; ready 503 + `ok: false` + `db: fail`. Sesudah postgres hidup, ready kembali 200 tanpa restart api (semantik yang sama dengan T03 Fase 0, kini lewat proksi) |
| T16-4 | Caddy mati | `docker compose -f docker-compose.dev.yml stop caddy`, lalu `curl` via proksi; hidupkan lagi | Connection refused (curl rc=7), tanpa JSON dari sumber manapun. Probe langsung ke api (bagian 6.2) tetap lulus selama skenario ini, membuktikan api hidup dan yang mati hanya pintunya |
| T16-5 | Path/metode salah via proksi | `GET /api/health/unknown`, `POST /api/health/ready`, `GET /health/ready` via proksi | 404 pada ketiganya. TIDAK ADA 200 + `ok: true` dari path/metode salah. `GET /` hanya dicatat sebagai info, tidak pernah dipakai sebagai bukti health |

Kriteria lulus T16: kelima skenario di atas lulus dengan bukti output,
dan tidak satu pun perilaku false OK dari daftar W07 bagian 4.2 yang
ditemukan lewat proksi (khususnya: ready 200 saat DB mati, body
hardcode, respons cache saat api mati, live diartikan sebagai ready).
Bila satu skenario gagal, T16 GAGAL; perbaiki routing/proksi atau
kontrak health-nya, jalankan ulang dari T16-1, dan catat jalan yang
gagal apa adanya. Bila T16 membuktikan masalah proksi yang tidak bisa
diterima, koordinator BERHENTI dan melapor (AD-22); berpindah opsi
arsitektur di tengah Fase 1 dilarang.

## 8. Menghentikan dan membersihkan

```sh
docker compose -f docker-compose.dev.yml down
```

`down` menghentikan dan menghapus container, tetapi MEMPERTAHANKAN
volume bernama (`pgdata`, `workspace`). Data dev bertahan untuk jalan
berikutnya.

```sh
docker compose -f docker-compose.dev.yml down -v
```

`down -v` MENGHAPUS volume bernama beserta seluruh data dev
(Postgres + berkas workspace). Hanya jalankan bila data dev memang
boleh hilang. Tidak ada backup otomatis pada stack dev ini.

Menghapus image yang ditarik (bila perlu ruang):

```sh
docker compose -f docker-compose.dev.yml down --rmi local
```

Perintah ini tidak menghapus volume. Jangan menjalankan `docker system
prune` tanpa memahami dampaknya ke proyek lain di mesin yang sama.

## 9. Troubleshooting

| Gejala | Kemungkinan penyebab | Tindakan |
|---|---|---|
| `web` unhealthy / 403 via proksi | `out/` belum dibangun di host | Build frontend (bagian 4), lalu cek lagi. Jangan mengubah mount untuk menutupi `out/` yang kosong |
| `api` unhealthy / restart berulang | `server/.env` tidak ada; `DATABASE_URL` salah host; postgres belum healthy | Cek `logs api`. Pastikan `server/.env` ada dan `DATABASE_URL` memakai host `postgres` (bagian 3.1). Pastikan `postgres` healthy di `ps` |
| Ready 503 `DB_AUTH_FAILED` / `DB_NOT_FOUND` | Kredensial `DATABASE_URL` tidak cocok dengan `infra/.env` | Samakan user/password/database di kedua berkas (bagian 3), lalu `restart api`. Bila postgres sudah terlanjur init dengan kredensial lama, kredensial di `infra/.env` tidak mengubah user yang sudah ada di volume `pgdata`; hapus volume dev (`down -v`) dan start ulang dengan kredensial yang benar, atau ubah user di dalam database |
| Ready 503 `DB_UNREACHABLE` | Postgres belum siap atau nama service salah | Tunggu postgres healthy; periksa `logs postgres`. Jangan mengubah host `DATABASE_URL` menjadi `localhost` di dalam compose |
| Ready 503 `WORKSPACE_*` | Mount volume workspace bermasalah | Periksa `logs api` dan `docker compose config` untuk mount `workspace:/workspace`. Jangan mengeset `WORKSPACE_ROOT` ke path host |
| `postgres` unhealthy / exit | `infra/.env` tidak ada atau salah satu dari tiga variabel kosong | Cek `logs postgres`. Pastikan ketiga variabel terisi (bagian 3.2) |
| Port 3200 bentrok | Proses lain memakai 3200 | Ubah HANYA pemetaan `ports` service `caddy` (bagian 2). Jangan mengubah `:80` di `Caddyfile.dev` |
| `caddy` exit / routing salah | `Caddyfile.dev` tidak valid atau nama upstream salah | Cek `logs caddy`. Berkas ini belum tervalidasi (bagian 10); laporkan pesan error Caddy apa adanya ke koordinator, jangan menebak perbaikan |
| `pnpm install` gagal di api | Jaringan registry tidak terjangkau dari container | Cek `logs api` untuk pesan error mentahnya. Investigasi gantungan/EPERM terkait install (F1-59/F1-60) berjalan terpisah; jangan mengubah command api diam-diam sebagai jalan pintas |
| Worker Up tetapi ready menyebut `worker: skipped` | Bukan gejala: itu harapan yang benar | Placeholder memang tidak mengerjakan apapun (bagian 6.3). Worker nyata datang pada gelombang berikutnya |

## 10. Hal yang belum teruji

Alasan umum: tidak ada Docker dan tidak ada Caddy di VM penulis
(diverifikasi dengan `command -v docker` dan `command -v caddy`: tidak
ditemukan). Validasi yang dilakukan di VM ini terbatas pada sintaks
YAML (Python `yaml`) dan grep atas berkas (em dash 0, secret 0); lihat
laporan pekerja V1-07 di pohon perencanaan.

| Hal | Status | Yang dibutuhkan untuk membuktikannya |
|---|---|---|
| `docker compose up` dari `infra/` | Belum teruji | Mesin dengan Docker + Compose v2; jalan + `ps` + log tercatat |
| `Caddyfile.dev` (sintaks + routing) | Belum teruji | `caddy validate` dan jalan stack; T16-1 sampai T16-5 |
| Healthcheck tiap service | Belum teruji | Jalan stack; `ps` menampilkan status health yang benar pada tiap keadaan (sehat, dependensi mati) |
| Command api (corepack + install + build + start) | Belum teruji | Jalan stack; log api menunjukkan install/build/start berhasil dari tree bersih |
| Placeholder worker (idle, restart, depends_on) | Belum teruji | Jalan stack; `logs worker` + `ps` |
| Volume `pgdata`/`workspace` (persistensi, `down` vs `down -v`) | Belum teruji | Jalan stack, tulis data, `down`, `up` lagi, data utuh; `down -v` menghapus |
| Postgres 17 + check health (minimal T01, T03, T04 di 17) | Belum teruji | Stack jalan dengan `postgres:17-alpine`; uji ulang health di 17 sebelum deploy (F1-49). Uji Fase 0 memakai Postgres 16.15, bukan 17 |
| WebSocket watcher lewat proksi | Belum teruji | Watcher terimplementasi (gelombang 2) + uji lewat proksi |
| Streaming AI (SSE) lewat proksi tanpa putus | Belum teruji | Fitur AI terimplementasi (Fase 2) + uji streaming; timeout proksi disetel dari hasil uji, bukan asumsi |
| Perilaku suspend/resume terhadap stack | Belum teruji | Uji cycle end-to-end sebelum serah terima (di luar scope dev lokal) |
| Batas resource (`mem_limit`/`cpus`) | Belum teruji | Pengamatan pemakaian nyata; nilai di compose adalah nilai awal, bukan hasil ukur |

## 11. Batas dan catatan repo

- Stack ini DEV ONLY. Compose dan Caddyfile produksi (GHCR by digest,
  tunnel, Access, watchdog, backup) adalah pekerjaan terpisah pada
  gelombang 5 dan TIDAK BOLEH dibuat dengan menyalin berkas dev ini
  tanpa tinjauan. Perbedaan yang sudah diketahui: image produksi dari
  GHCR (bukan bind mount), CSP + filter log token pada Caddyfile
  produksi, secret dan `.env` 0600 di remote, serta healthcheck dan
  batas resource dari data trial.
- CSP tidak ditetapkan di `Caddyfile.dev`. CSP ditetapkan pekerjaan
  frontend/shim dari bukti build (O-07/F10 bagian 4.4); menyalin CSP
  dari proyek lain dilarang.
- Filter log token (redaksi `Authorization`/`Cookie`/token layanan di
  log akses) adalah pengerasan Caddyfile produksi. Log dev bersifat
  lokal; jangan menempel log mentah yang memuat header auth ke laporan
  atau chat.
- Catatan gitignore: pola `docs/` di `.gitignore` root menutup
  direktori bernama `docs` di semua tingkat, termasuk `infra/docs/`.
  Berkas runbook ini masuk repo lewat `git add -f`. Berkas BARU lain
  di `infra/docs/` akan mengalami hal yang sama; pakai `git add -f`
  atau tambahkan eksepsi gitignore lewat pekerjaan hygiene (di luar
  scope runbook ini). Sekali ter-track, perubahan berkas ini tampil
  normal di `git status`.
- Rujukan desain: `design/10-build-deploy.md` bagian 3, 4, dan 9;
  `fase0/KEPUTUSAN-ARSITEKTUR.md` AD-04, AD-05, AD-06, AD-18, AD-19;
  `fase0/laporan-health.md` bagian 2, 5 (T16), dan 9. Bila runbook ini
  bertentangan dengan keputusan arsitektur, keputusan arsitektur yang
  menang dan runbook wajib diperbaiki.
