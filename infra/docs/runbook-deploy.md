# Runbook Deploy: CSP dan SCRAM (Gelombang 4)

Status: masukan pengerasan untuk adopsi gelombang 5, BELUM LIVE.
Berkas konfigurasi yang dibahas di sini (`infra/Caddyfile.prod`,
`infra/docker-compose.deploy.yml`, `infra/postgres/pg_hba.conf`)
mendarat di repo lewat gelombang 4 tetapi belum dipakai stack
apa pun sampai gelombang 5 mengadopsinya ke rakitan deploy dan
menjalankan validasi di bawah. Jangan menjalankan stack deploy
dari berkas-berkas ini sebelum K-15 (image GHCR) tertutup.

## 1. Rakitan deploy

Salin ke direktori rakitan (rencana: `/data/home/note-gen-web/`,
bukan git repo) sebagai satu paket:

- `infra/docker-compose.deploy.yml` sebagai `docker-compose.yml`
  rakitan (atau jalankan dengan `-f` dari direktori infra; jalur
  relatif di berkas mengasumsikan Caddyfile dan `postgres/` berada
  di samping berkas compose).
- `infra/Caddyfile.prod` sebagai `./Caddyfile.prod`.
- `infra/postgres/pg_hba.conf` sebagai `./postgres/pg_hba.conf`.
- Berkas env lokal rakitan `./api.env` dan `./postgres.env`, yang
  TIDAK PERNAH di-commit. Buat dari `.env.example` yang sesuai
  dengan nilai produksi; tiap nilai secret memakai placeholder
  CHANGE_ME di berkas example dan nilai nyata hanya di rakitan.

Kontrak variabel env (verifikasi sebelum `up` pertama):

- `postgres.env` memuat `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB` (tanpa nilai default diam-diam; healthcheck gagal
  secara jujur bila variabel kosong).
- `DATABASE_URL` di `api.env` memakai kredensial yang sama dengan
  `postgres.env` (user, password, dan nama database yang sama).
  Ketidakcocokan berarti API tidak dapat terhubung; tidak ada
  fallback trust yang menyembunyikannya.

Direktori device untuk volume bind-backed WAJIB sudah ada di host
sebelum `up` pertama (lihat komentar volume di berkas compose).
Penempatan volume di bawah `/data` mengikuti usulan DEP-13
(D-DEP13-2); bila koordinator menolak bentuk itu, alternatifnya
adalah volume bernama polos ditambah bukti `docker info`.

## 2. CSP: Report-Only dulu, penegakan gated K-12

### 2.1 Kebijakan aktif (Tahap 1)

Caddy menetapkan header berikut HANYA pada respons blok fallback
ke `web:80` (halaman HTML/statis). Respons `/api/*` dan
`/api/health*` tidak membawa header CSP dari Caddy.

Header: `Content-Security-Policy-Report-Only`

```
default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; media-src 'self' blob: data:; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; manifest-src 'self'; upgrade-insecure-requests; report-uri /api/csp-reports; report-to csp-endpoint
```

Header pendamping pada cakupan yang sama:

- `Reporting-Endpoints: csp-endpoint="/api/csp-reports"` (wajib,
  agar direktif `report-to` berfungsi; tanpa header ini hanya
  `report-uri` yang bekerja).
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin` (pengecualian hanya
  bila uji membuktikan worker/runtime plugin rusak, K-12g)
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  (USULAN, butuh konfirmasi gelombang 5)
- `Strict-Transport-Security: max-age=31536000` (USULAN, butuh
  konfirmasi gelombang 5; tanpa includeSubDomains dan tanpa
  preload; hanya efektif lewat HTTPS)

Tidak ada `X-Frame-Options` terpisah (`frame-ancestors` sudah ada).
Tidak ada `<meta>` CSP untuk halaman utama. `upgrade-insecure-requests`
dipertahankan karena skema yang dihadapi browser di balik perimeter
TLS adalah HTTPS; hapus direktif itu untuk deployment localhost
non-HTTPS, dan jangan mengambil bukti K-12 dari deployment
`http://` publik.

### 2.2 Verifikasi header (V1)

Jalankan di mesin yang memiliki Docker (Caddy lewat image
`caddy:2-alpine`); tidak ada binary Caddy di VM authoring.

```sh
# 1. Validasi konfigurasi (wajib lulus sebelum uji apa pun).
docker run --rm -v "$PWD/Caddyfile.prod:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile

# 2. Header atas /: tepat satu header Report-Only + pendamping.
curl -si http://127.0.0.1:3200/ | grep -i "^content-security-policy-report-only:\|^reporting-endpoints:\|^x-content-type-options:\|^referrer-policy:\|^cross-origin-opener-policy:\|^cross-origin-resource-policy:\|^permissions-policy:\|^strict-transport-security:"

# 3. API dan health: TIDAK ada header CSP dari Caddy; health tetap no-store.
curl -si http://127.0.0.1:3200/api/health/live | grep -i "^content-security-policy" || echo "OK: no CSP header on API"
curl -si http://127.0.0.1:3200/api/health/live | grep -i "^cache-control:"
```

Harapan: tepat satu header Report-Only pada `/` dengan string
persis seksi 2.1; nol header CSP pada `/api/*` dan health;
`Cache-Control: no-store` pada health tidak berubah. Header ganda
yang berpotongan adalah cacat konfigurasi, bukan pertahanan
berlapis: periksa jumlah kemunculan, bukan hanya keberadaan.

### 2.3 Uji kirim laporan

Endpoint `POST /api/csp-reports` sudah ada (204 kosong, tanpa
sesi, rate limit lokal 30/menit/IP, body 16 KiB, maks 10
laporan/request, log tersanitasi saja, tidak menyimpan). Uji
kedua format wire (legacy `application/csp-report` dan Reporting
API `application/reports+json`); keduanya dijawab 204 dan
rekaman lognya tersanitasi (tanpa query, token, atau nilai
secret). Banjir di atas 30/menit/IP dijawab 429.

Peringatan `trustProxy` (utang U2 V3-39bR): sampai `trustProxy`
di-wiring, `request.ip` adalah peer langsung (Caddy) sehingga
seluruh laporan berbagi satu ember 30/menit. Konfirmasi keadaan
wiring itu sebelum menafsirkan kehilangan laporan sebagai
ketiadaan pelanggaran.

### 2.4 Prosedur Report-Only sampai penegakan

1. Jalankan Tahap 1 atas seluruh alur (desain-h4-csp seksi 6.2):
   boot, login/setup/pengaturan, editor + worker lexer, KaTeX dan
   Mermaid, gambar `data:`/`blob:`, audio blob, WebSocket watcher
   same-origin, panel plugin nonaktif, dan alur iframe `srcdoc`.
2. Kumpulkan log pelanggaran; lampirkan log mentah tersanitasi.
   Klasifikasikan tiap pelanggaran: (a) cacat kode yang harus
   diperbaiki di kode; (b) pelonggaran beralasan dengan penunjuk
   kode pemicu; (c) pelanggaran jalur non-MVP yang diharapkan
   diblokir (bukti pertahanan bekerja).
3. Aturan lulus: 0 pelanggaran yang tidak dijelaskan. Pelanggaran
   yang belum diklasifikasikan memblokir penegakan.
4. Koordinator memutus tiap butir K-12 (desain-h4-csp seksi 5)
   dari bukti dan mencatatnya, termasuk selisih `worker-src`,
   `style-src 'unsafe-inline'` bersyarat, dan `'wasm-unsafe-eval'`.
5. Penegakan: ganti nama header menjadi `Content-Security-Policy`
   dengan nilai K-12 (kandidat tercatat di komentar akhir
   `Caddyfile.prod`), jalankan ulang V1 sampai V3, pantau laporan
   pelanggaran sebagai sinyal regresi. Pelaporan tetap aktif
   sesudah penegakan.
6. Bila Tahap 1 menemukan skrip inline Next.js yang memecahkan
   boot atau kerusakan `srcdoc` yang tidak dapat dijelaskan,
   eksekusi BERHENTI di Report-Only dan kembali ke K-12. Tidak ada
   jalan pintas `'unsafe-inline'` untuk `script-src`.

Pemeriksaan build sebelum penegakan (V4): periksa HTML hasil
build static export untuk `<script>` inline tanpa `src` (A5) dan
CSS hasil build untuk URL font `data:` (K-12f); catat hasilnya.
Tanpa bukti build, K-12 tidak dapat diputus.

## 3. SCRAM untuk Postgres deploy

### 3.1 Mekanisme

- `infra/postgres/pg_hba.conf` (di-mount read-only, dipakai lewat
  `hba_file`) memuat dua baris saja, keduanya
  `scram-sha-256`: `local all all` dan `host all all all`. Tidak
  ada baris trust. Tidak ada baris replikasi: replikasi ditolak
  karena tidak ada baris yang cocok (fail closed).
- `command` service postgres menetapkan
  `password_encryption=scram-sha-256` secara eksplisit. PG17 sudah
  memakai nilai itu sebagai default; penetapan eksplisit menjaga
  perilaku bila default berubah dan membuat enkripsi terverifikasi
  lewat `SHOW password_encryption`.
- `POSTGRES_HOST_AUTH_METHOD` sengaja TIDAK dipakai: variabel itu
  hanya memengaruhi berkas HBA yang digenerasi entrypoint, dan
  berkas itu digantikan sepenuhnya oleh `hba_file` di sini.
- `password_encryption` hanya memengaruhi password BARU atau
  DIUBAH. Volume data lama yang passwordnya dibuat sebelum SCRAM
  wajib di-hash ulang (seksi 3.3).

### 3.2 Verifikasi (jalan atas container deploy)

```sh
# Enkripsi aktif dan berkas HBA yang dipakai adalah berkas khusus.
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SHOW password_encryption;" -c "SHOW hba_file;"

# Verifier password berbentuk SCRAM (boolean saja; JANGAN pernah
# mencetak kolom passwd itu sendiri).
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT usename, passwd LIKE 'SCRAM-SHA-256\$%' AS is_scram FROM pg_shadow;"

# Autentikasi password lewat TCP berhasil; tanpa password ditolak.
PGPASSWORD='<password-dari-postgres.env>' psql -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1;"
```

Harapan: `password_encryption` bernilai `scram-sha-256`,
`hba_file` menunjuk `/etc/postgresql/pg_hba.conf`, `is_scram`
bernilai true untuk tiap role, dan koneksi tanpa password
ditolak. Perintah `psql` lewat TCP di atas hanya berlaku bila
port Postgres dapat dijangkau dari mesin perintah; di stack
deploy, Postgres tidak mem-publish port host, jadi verifikasi
TCP dijalankan dari dalam jaringan compose (mis. lewat container
sekali-pakai pada network yang sama) atau lewat `docker compose
exec` dengan `-h` menunjuk nama service dari container lain.

### 3.3 Hash ulang volume lama

Bila volume `pgdata` sudah ada dari stack sebelum SCRAM dan
verifiernya bukan SCRAM (cek `is_scram` di seksi 3.2):

```sh
# Di dalam container postgres, sebagai role pemilik database.
# Ganti <password-baru> dengan nilai dari postgres.env rakitan.
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "ALTER ROLE \"$POSTGRES_USER\" PASSWORD '<password-baru>';"
```

Jalankan ulang cek `is_scram` sesudahnya; hasilnya wajib true.
Jangan mengubah password lewat `POSTGRES_PASSWORD` saja: variabel
itu hanya dipakai entrypoint saat inisialisasi cluster kosong dan
tidak mengubah password role yang sudah ada.

### 3.4 Debug tanpa trust

Debug lewat `docker compose exec postgres psql` membutuhkan
`PGPASSWORD` karena tidak ada baris trust:

```sh
docker compose exec -e PGPASSWORD='<password-dari-postgres.env>' postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Jangan menambahkan baris trust sementara untuk debug; baris
sementara yang terlupakan adalah jalur tanpa autentikasi.

## 4. Mengapa klaster dev tetap memakai default entrypoint

Compose dev (`infra/docker-compose.dev.yml`) TIDAK diubah oleh
gelombang 4 dan TIDAK memakai berkas HBA khusus: Postgres dev
memakai berkas HBA yang digenerasi entrypoint image (default
entrypoint, termasuk trust lokal). Keputusan ini disengaja:

- Klaster dev adalah scratch single-tenant di mesin dev (muse-2),
  tanpa port yang dipublikasi ke host dan tanpa data produksi.
  Permukaan ancamannya adalah mesin dev itu sendiri, bukan
  jaringan.
- Alur debug dev (`docker compose exec postgres psql` tanpa
  password, healthcheck tanpa kredensial eksplisit) bergantung
  pada default entrypoint; mengubahnya menambah gesekan tanpa
  menambah keamanan yang berarti di lingkungan scratch.
- Batas keamanan yang diperkeras adalah jalur deploy. Dev dan
  deploy adalah dua konfigurasi berbeda dengan dua berkas compose
  berbeda; menyamakan keduanya akan mengaburkan batas itu dan
  berisiko memecahkan alur dev yang menjadi tumpuan gelombang 5
  untuk validasi T16.

Bila koordinator kelak memutuskan dev juga memakai SCRAM,
perubahannya adalah pekerjaan terpisah: mount berkas HBA yang
sama (atau varian dev) ke compose dev dan sesuaikan healthcheck
serta alur debugnya. Sampai keputusan itu ada, jangan menyalin
konfigurasi SCRAM deploy ke compose dev secara diam-diam.

## 5. Keputusan terbuka (pemilik: gelombang 5 / koordinator)

- K-12: nilai CSP penegakan final, dari bukti Report-Only.
- K-15: image GHCR web/api (stack deploy belum dapat di-up).
- K-03: pgvector atas `postgres:17-alpine` (jangan diam-diam
  ganti image; bukti G4 langkah 1 wajib jalan dulu).
- Konfirmasi nilai `Strict-Transport-Security` dan daftar
  `Permissions-Policy` (keduanya USULAN di berkas ini).
- Konfirmasi wiring `trustProxy` sebelum menafsirkan log laporan
  CSP (seksi 2.3).
- Ratifikasi pengecualian K-09/K-18 untuk perilaku buang-field
  endpoint laporan (DEC-02); konfirmasi sebelum mengandalkan
  perilaku itu.
- T16 lewat proksi + `caddy validate` atas `Caddyfile.prod` di
  mesin deploy (bukti adopsi gelombang 5).
