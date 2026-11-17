# E2E Playwright: scaffold Fase 1

Scaffold harness E2E untuk fork web NoteGen. Desain: `fase1/desain-pengujian.md`
seksi 4 (V1-15). Scaffold ini (V2-07) hanya memasang harness dan alur;
perluasan 3D e2e-prep (V3-41) menambah helper auth API, data seed bersama,
varian boot terautentikasi `@smoke`, dan 2 kerangka demo `@demo` untuk gate
A10; slot 3E-V41-HARNESS menambah harness backend per test (lihat seksi
"Backend harness" di bawah) beserta spec `@harness` yang membuktikan
harness itu. Gelombang 4 slot W4-FLOWS mengonversi keenam alur `@smoke`
menjadi spec live, meng-unskip E2E-01b, mengonversi E2E-S1/S3, dan
menambah spec reload `@smoke`, spec bukti hook `@harness`, dan spec
pengukuran profil i18n 9.5 `@i18n-profile`. Yang masih TODO: E2E-S2
(terblokir wiring layanan dialog, AD-33), E2E-S4 (tanpa UI ekspor),
dan 2 kerangka demo `@demo`. Tidak ada lulus palsu.
Pemetaan dan justifikasi penambahan ada di seksi "Alur @scaffold
(brief pemulihan)" dan "Alur @demo (gate A10)" di bawah.

## Cara jalan

```sh
pnpm install
pnpm build
pnpm e2e:smoke   # alur @smoke live (9 test: E2E-01, E2E-01b, E2E-01-auth, E2E-02..E2E-06, E2E-RELOAD)
pnpm e2e          # semua spec di tests/e2e (termasuk spec @scaffold, @harness, @stall, @demo, @i18n-profile)
pnpm exec playwright test --grep @scaffold  # spec @scaffold (E2E-S1/S1b, E2E-S3 live; E2E-S2, E2E-S4 TODO)
pnpm exec playwright test --grep @demo  # hanya 2 kerangka demo @demo (gate A10)
pnpm exec playwright test --grep @harness  # bukti harness + bukti hook H1 (butuh Postgres + E2E_PG_ADMIN_URL)
pnpm exec playwright test --grep @i18n-profile  # pengukuran profil 9.5 en+zh (butuh Postgres + E2E_PG_ADMIN_URL)
```

## Backend harness (3E-V41-HARNESS)

Satu test mendapat satu backend, satu database scratch, dan satu
workspace, tanpa state bersama antar test (desain-pengujian 4.1).
Fixture `backendTest` (`harness/backend-fixture.ts`) melakukan,
per test: (1) menyiapkan workspace seed di disk (`harness/seed.ts`);
(2) mem-boot `server/dist/server.js` dengan `DATABASE_URL` database
scratch yang dibuat untuk test itu dan `WORKSPACE_ROOT` direktori
seed, lalu menunggu `GET /api/health/ready` menjawab ok
(`harness/backend.ts`); (3) menjalankan gateway
(`harness/static-server.mjs` mode proxy) yang melayani static export
`out/` dan meneruskan `/api/*` ke backend test itu, sehingga browser,
cookie sesi, dan cek Origin melihat satu origin; (4) membuat akun
seed + login lewat API (`harness/auth.ts`, kredensial dibuat per
backend dan hanya hidup di memori); (5) men-seed 2 tag + 5 record
lewat kind layer (`harness/seed-records.ts`, `POST /api/transactions`
dengan kind `tags.create`/`marks.create`; rute REST marks/tags ADA di
trunk sejak W4-WIRE, tetapi seeder tetap memakai kind layer karena
itulah jalur yang dipakai klien inbox terkirim). Teardown menghentikan gateway, menghentikan
backend + menghapus database scratch, lalu menghapus workspace.

Prasyarat, semuanya gagal cepat dengan error bernama bila tidak ada:
server yang sudah di-build (`server/dist/server.js`), dependensi
server terinstal (driver `pg` dipakai untuk membuat/menghapus
database scratch), klaster Postgres 17 yang terjangkau, dan variabel
`E2E_PG_ADMIN_URL`: URL koneksi ke klaster scratch yang menunjuk
database maintenance (mis. database `postgres`); URL per test
diturunkan darinya dengan mengganti nama database saja. Nilai URL
tidak pernah dicetak atau muncul di pesan error. Tanpa variabel itu,
fixture gagal dengan pesan yang menyebut nama variabelnya; tidak ada
default diam-diam dan tidak ada fallback ke backend bersama.

Jalur melewati perimeter Cloudflare Access, HANYA untuk pengujian:
backend test berjalan dengan `CF_ACCESS_ENABLED=false`,
`NODE_ENV=development`, `COOKIE_SECURE=false`, dan `PUBLIC_BASE_URL`
origin gateway loopback. Kombinasi itu persis bentuk dev lokal yang
diizinkan konfigurasi server sendiri (`server/src/config/env.ts`):
Access nonaktif ditolak di production dan ditolak dengan origin
non-localhost, dan harness tidak mengubah aturan itu. Tidak ada kode
bypass, tidak ada header Access palsu, dan tidak ada berkas produksi
yang disentuh. Gateway hanya meneruskan ke backend loopback. Jangan
pakai konfigurasi ini di luar run pengujian di loopback.

Bukti live harness adalah spec `@harness`
(`backend-harness.spec.ts`, BUKAN `@smoke`, tidak dihitung dalam gate
6/6): gateway melayani bundle + mem-proxy API, probe sesi
terautentikasi, berkas seed ada di disk, dan record seed terbaca
balik lewat kind layer. Jalankan di mesin gate:

```sh
E2E_PG_ADMIN_URL=<url-ke-database-maintenance> pnpm exec playwright test --grep @harness
```

Jangan pernah menulis nilai URL nyata di dokumen, log, atau commit.
Bila run gate mati di tengah jalan, database scratch bernama
`notegen_e2e_*` dapat tertinggal; operator menghapusnya manual dari
klaster scratch (database itu hanya ada di klaster scratch, tidak
pernah di database produksi). Restart backend dan database persisten
untuk E2E-D2 TIDAK didukung fixture ini (fixture bersifat per test
dan ephemeral); itu pekerjaan lanjutan terpisah.

Helper auth API (`harness/auth.ts`) memakai origin API dari
`E2E_API_BASE_URL` (bila harness backend jalan di origin sendiri),
lalu `E2E_BASE_URL`, lalu origin server statis default. `E2E_PORT`
yang non-numerik atau di luar 1-65535 gagal secara eksplisit saat
resolusi (`resolveE2ePort`), tanpa nilai diam-diam. Kredensial
uji dari environment harness (`E2E_TEST_EMAIL`,
`E2E_TEST_PASSWORD`, `E2E_SETUP_TOKEN`) tetap berlaku untuk run
melawan base URL eksternal; fixture backend memakai kredensial yang
dibuat per test. Tidak ada kredensial hardcoded di spec mana pun
dan tidak ada nilai yang pernah di-log.

Target adalah build produksi static export (`out/`), BUKAN `next dev` dan
BUKAN `next start`: fork memakai `output: "export"`, sehingga tidak ada
server Next.js. Playwright menjalankan server statis tanpa dependensi
`harness/static-server.mjs` lewat entri `webServer` di `playwright.config.ts`.

Melawan server yang sudah jalan (preview deploy, server manual):

```sh
E2E_BASE_URL=http://127.0.0.1:4173 pnpm e2e:smoke
```

Dalam mode ini tidak ada `webServer` yang dimulai; preflight bundle tetap
jalan lewat HTTP. Port default 4173 dapat diubah lewat `E2E_PORT`.
Browser: `pnpm exec playwright install chromium` (sekali per mesin/CI).

## Status alur

| Alur | Spec | Status |
|---|---|---|
| E2E-01 boot tanpa backend | `boot.spec.ts` | Nyata. Ditujukan lulus terhadap build web saat ini: guard boot (M14) memblokir dengan layar error BOOT_SESSION_UNKNOWN yang dapat dipahami, bukan halaman kosong dan bukan redirect buta, karena server statis tidak menjawab `/api/auth/me` (404). Varian boot terautentikasi ada di `boot-auth.spec.ts` (E2E-01-auth); jangan melemahkan assertion fail-closed ini. |
| E2E-01b boot store rusak | `boot.spec.ts` | Nyata (di-unskip W4-FLOWS): stub rute membuat `/api/settings` menjawab 200 dengan body yang gagal validasi bentuk, guard menampilkan BOOT_STORE_UNAVAILABLE / STORE_LOAD_FAILED. Mencakup cabang guard untuk endpoint store yang gagal; korupsi dokumen database sejati tidak punya hook poison dan tidak diklaim. |
| E2E-01-auth boot terautentikasi | `boot-auth.spec.ts` | Nyata `@smoke` (dikonversi W4-FLOWS): redirect ke `/core/main` + pohon file + entri seed; menutup CELAH-4 (A5). Navigasi memakai origin gateway fixture sebagai parameter wajib (temuan T-8). |
| E2E-02 buat + simpan | `create-save.spec.ts` | Nyata `@smoke` (dikonversi W4-FLOWS): buat lewat entri menu folder "New File" (toolbar "New Note" membuat di root), isi fixture diketik di mode sumber, disk sama byte-for-byte sesudah reload. |
| E2E-03 ubah artikel lama | `edit-existing.spec.ts` | Nyata `@smoke` (dikonversi W4-FLOWS): edit visual (heading + paragraf), disk memuat perubahan dan mempertahankan bagian lain; gambar relatif ter-render (media 200, natural size > 0); tautan relatif dibuka dengan klik modifier. |
| E2E-04 cari | `search.spec.ts` | Nyata `@smoke` (dikonversi W4-FLOWS): hasil menunjuk berkas seed + snippet, status fuzzy terlihat, aktivasi hasil dibuktikan lewat observasi editor (temuan D-DEMO-8), istilah absen menampilkan empty state eksplisit. |
| E2E-05 file dari luar | `external-file.spec.ts` | Nyata `@smoke` (dikonversi W4-FLOWS): berkas ditulis atomik dari luar, muncul di pohon (timeout 30 dtk diturunkan dari interval polling 10 dtk, BUKAN batas kontrak 1 dtk), dibuka, tanpa duplikat. |
| E2E-06 pengaturan bertahan | `settings-persist.spec.ts` | Nyata `@smoke` (dikonversi W4-FLOWS, E2E-06-darkMode): darkMode ditulis lewat API settings (AD-113/AD-123 butir 11: tanpa kontrol UI, tanpa klaim read-back UI), revisi naik 1, nilai bertahan sesudah reload. |
| E2E-RELOAD seed reload | `reload.spec.ts` | Nyata `@smoke` (ditambah W4-FLOWS): berkas seed + record seed + dokumen settings utuh sesudah reload penuh; revisi settings tidak churn. |
| E2E-HARNESS bukti harness | `backend-harness.spec.ts` | NYATA `@harness` (bukan `@smoke`, tidak dihitung gate): gateway + sesi + seed terbaca balik. Hijau di tiap gate merge; hanya jalan di mesin dengan Postgres + `E2E_PG_ADMIN_URL`. |
| E2E-BOOT-SQL-PROOF | `boot-sql-proof.spec.ts` | NYATA `@harness`: boot + probe SQL + load store + round-trip kind layer. Header diperbarui W4-FLOWS: pemanggil adapter produksi bergating flag (hook H1) dicatat; bukti browser hook ada di `boot-hook.spec.ts`. |
| E2E-HOOK bukti hook H1 | `boot-hook.spec.ts` | NYATA `@harness` (ditambah W4-FLOWS): deep link `?e2e-boot-proof=1` menulis `window.__notegenBootProof` + POST `/api/db/batch` ber-CSRF teramati; tanpa flag, hook `undefined`. |
| E2E-S1 login | `login.spec.ts` | Nyata `@scaffold` (dikonversi W4-FLOWS, promosi ke `@smoke` diusulkan ke koordinator): login UI lewat fixture tanpa sesi + varian password salah (alert generik); storage diperiksa tanpa token (boolean saja, tanpa nilai). |
| E2E-S2 hapus catatan (CRUD) | `notes-crud.spec.ts` | TODO `@scaffold` (tetap TODO di W4-FLOWS): TERBLOKIR celah produk - layanan dialog web belum terpasang (AD-33), `platform.dialog.ask()` melempar error sehingga konfirmasi hapus tidak pernah tampil dan berkas tetap ada (probe 8-9). Menu konteks + rute trash berfungsi; yang hilang hanya wiring dialog. |
| E2E-S3 record + tag | `record-tag.spec.ts` | Nyata `@scaffold` (dikonversi W4-FLOWS, promosi ke `@smoke` diusulkan ke koordinator): tag kedua ditetapkan lewat dialog detail record web (TagChecklist + "Save tags", BUKAN tombol desktop "Manage tags"), terbaca balik lewat API, bertahan sesudah reload. |
| E2E-S4 unduh arsip | `archive-download.spec.ts` | TODO `@scaffold`: gagal dengan pesan "fitur belum mendarat". UI ekspor belum ada; tanpa locator tebakan. Tetap TODO di W4-FLOWS. |
| I18N-9.5 profil teratentikasi | `i18n-profile.spec.ts` | Pengukuran `@i18n-profile` (ditambah W4-FLOWS, AD-120 Q3): shell teratentikasi diukur di mode en + zh (marker 12+12, CJK, tangkapan shell/editor/Settings); hanya mekanika boot yang di-assert, marker tidak di-gate. Adjudikasi Q3b milik gate penutupan. |
| E2E-D1 demo A10 | `demo.spec.ts` | TODO `@demo`: gagal dengan pesan "fitur belum mendarat". Kerangka urutan demo gate A10; tetap TODO di W4-FLOWS (di luar lingkup slot). |
| E2E-D2 cek data A10 | `demo.spec.ts` | TODO `@demo`: gagal dengan pesan "fitur belum mendarat". Kerangka cek data utuh sesudah restart backend; menunggu kontrol restart harness + database uji persisten. Tetap TODO di W4-FLOWS. |

## Alur @scaffold (brief pemulihan): pemetaan dan justifikasi

Desain-pengujian seksi 4.4: menambah alur E2E di luar 6 alur tanpa
justifikasi tercatat adalah penyimpangan. Justifikasi tercatat untuk 4
spec `@scaffold` adalah: brief pemulihan gelombang 2 (batch 00:37 WIB
15 Nov 2026) memerintahkan scaffold untuk 6 alur kritis fork web yaitu
login, catatan CRUD, record+tag, pencarian, pengaturan, unduh arsip.
Dua di antaranya sudah tertutup spec `@smoke` desain (pencarian =
E2E-04, pengaturan = E2E-06) dan tidak diduplikasi. Tiga sisanya
menyentuh permukaan BARU fork web yang tidak dicakup seksi 4.2 karena
belum ada saat desain ditulis: login (API auth desain-auth, tanpa UI
di repo acuan), record+tag (kontrak records/tags V1-14), dan unduh
arsip (kontrak backup V1-17). Spec keempat (E2E-S2) melengkapi CRUD
dengan kaki hapus yang tidak dicakup E2E-02/E2E-03. Keempat spec
memakai tag `@scaffold`, BUKAN `@smoke`, sehingga definisi gate
`e2e-smoke` di desain seksi 5 tidak berubah; koordinator memutuskan
kapan masing-masing dipromosikan ke `@smoke` setelah fiturnya mendarat
dan satu run hijau membuktikan selectornya. Spec E2E-S4 hanya mencakup
unduh satu arsip, bukan impor/ekspor massal yang dikecualikan seksi
4.4; perbedaan itu dinyatakan eksplisit di komentar spec.

Aturan TODO (`harness/todo.ts`): spec TODO memanggil `notYetLanded` sebagai
pernyataan pertama dan tidak melakukan apa pun. Dilarang memakai
`test.skip`, `test.fixme`, atau `test.fail` untuk alur TODO, dan dilarang
menambah assertion placeholder. Saat fitur mendarat, penulis alur mengganti
pemanggilan itu dengan langkah nyata yang sudah diuraikan di komentar spec.

## Alur @demo (gate A10): justifikasi

Desain-pengujian seksi 4.4 menuntut justifikasi tercatat untuk tiap alur
di luar 6 alur. Justifikasi untuk 2 spec `@demo` (`demo.spec.ts`,
E2E-D1/E2E-D2) adalah: keduanya BUKAN keluarga alur baru, melainkan
penyusunan 6 alur `@smoke` + login (E2E-S1) + record+tag (E2E-S3)
menjadi urutan persis yang dinamai gate A10 rencana gelombang 3 seksi
4.3 (demo parsial MVP lewat browser: login; folder + 3 catatan; edit,
simpan, reload; 5 record + 2 tag; cari + buka hasil; 2 pengaturan +
reload; data utuh sesudah restart backend). Tag `@demo` (bukan `@smoke`,
bukan `@scaffold`) menjaga definisi gate `e2e-smoke` di desain seksi 5
tetap tidak berubah, mengikuti preseden `@scaffold`. E2E-D2 hanya
mencakup cek data sesudah restart backend lokal yang disebut A10;
unduh arsip dan ketahanan suspend/resume adalah gate gelombang 4-5 dan
tidak diklaim di sini.

## Struktur

| Berkas | Isi |
|---|---|
| `playwright.config.ts` (root) | `testDir`, Chromium headless, 1 worker, retry 1 di CI / 0 lokal, reporter list, `webServer` server statis (tanpa proxy: E2E-01 mem-pin kondisi tanpa backend). |
| `harness/static-server.mjs` | Server statis `out/` tanpa dependensi; gagal cepat bila `out/` tidak ada; `Cache-Control: no-store`. Mode proxy bila `E2E_API_BASE_URL` di-set: `/api/*` diteruskan ke backend loopback (test-only). |
| `harness/backend.ts` | Boot backend per test: database scratch, secret per test, tunggu ready, teardown + hapus database. Bypass Access test-only terdokumentasi di header. |
| `harness/backend-fixture.ts` | Fixture Playwright `backendTest`: workspace seed + backend + gateway + sesi + seed record/tag per test; teardown lengkap. |
| `harness/seed-records.ts` | Seed tag/record lewat kind layer (`POST /api/transactions`, kind `tags.create`/`marks.create`); tanpa rute REST yang dikarang. |
| `harness/selectors.ts` | Semua locator, beserta status verifikasi per locator. |
| `harness/app-page.ts` | Page object: boot, buka file, buat catatan, cari global. |
| `harness/login-page.ts` | Page object halaman `/login` (V3-03): buka login, sign-in, langkah TOTP, alert. |
| `harness/auth.ts` | Helper auth API: setup akun pertama, login via API, probe sesi; kredensial hanya dari environment harness. |
| `harness/seed-data.ts` | Data seed bersama (hanya data, tanpa I/O): fixture buat/edit, istilah cari, berkas luar, seed record/tag, catatan demo; tanpa seed pengaturan (pilihan tertunda). |
| `harness/preflight.ts` | Cek HTTP 200 untuk `/markdown-lexer.js?v=4` dan `/plugin-runtime.js`. |
| `harness/seed.ts` | Seed workspace deterministik (belum terhubung ke aplikasi, lihat di bawah). |
| `harness/external-writer.ts` | Penulis file atomik "proses luar" untuk E2E-05. |
| `harness/todo.ts` | Helper `notYetLanded` untuk spec TODO. |

## Status verifikasi selector (A4)

Semua selector diperiksa terhadap komponen aktual di repo acuan (HEAD
4dcaa3f) dan katalog pesan Inggris (`messages/en.json`, locale default `en`),
KECUALI baris bertanda "[trunk]" yang diperiksa terhadap trunk fork
69c77dac oleh perluasan 3D e2e-prep (halaman login/setup V3-03, test-id
pencarian V3-28). Pekerja pengganti V2-07 memeriksa ulang tiap selector
dan memeriksa kode pustaka `@headless-tree/core` 1.7.0 (container
`role: "tree"`, `aria-label`; item `role: "treeitem"`, `aria-label:
getItemName()`) dan `cmdk` 1.1.1 (`CommandItem` merender `role:
"option"`) dari tarball npm.
"TERVERIFIKASI (source)" berarti role/nama/atribut mengikuti source komponen
+ katalog pesan; perilaku runtime di browser nyata tetap belum terverifikasi
sampai ada run hijau. Tidak satu pun selector di bawah ini terbukti lewat
run browser saat scaffold ditulis, kecuali dinyatakan lain di laporan
`fase1/laporan-e2e-scaffold.md`.

TERVERIFIKASI (source):

| Selector | Bukti source |
|---|---|
| `getByRole('tree').first()` (locale-free; JANGAN pakai nama) | `file-manager.tsx` `getContainerProps(t('treeLabel'))`; `article.file.treeLabel` TERLOKALISASI ("Workspace files" / "工作区文件", dibuktikan run I18N-9.5-ZH); `@headless-tree/core` container props (`role: "tree"`, `aria-label`). |
| `getByRole('treeitem', { name: '<nama file>' })` | `@headless-tree/core` item props (`role: "treeitem"`, `aria-label: getItemName()`); `use-file-tree.ts` `getItemName` = nama item. |
| `[data-file-manager-item-path="<path relatif>"]` | `file-tree-row.tsx`; nilai dari `computedParentPath` (`lib/path.ts`): path relatif workspace, mis. `notes/getting-started.md`. |
| `getByRole('textbox', { name: 'Search files' })` | `file-manager.tsx` input filter, `aria-label={t('search.label')}`; `article.file.search.label` = "Search files". |
| `getByRole('textbox', { name: 'Search notes, records, and canvases...' })` | `sidebar-search.tsx` input, `aria-label` = `placeholder`; `search.placeholder` di `en.json`. |
| Teks `No search results` | `sidebar-search.tsx` empty state; `search.noResults` di `en.json`. |
| `getByRole('option', { name: '<judul>' })` untuk hasil cari | `sidebar-search.tsx` memakai `CommandItem`; `cmdk` merender `role: "option"`. |
| `getByRole('button', { name: 'New Note' })` | `file-actions.tsx` + `tooltip-button.tsx` (`aria-label={tooltipText}`); `article.file.toolbar.newArticle` = "New Note". |
| `getByRole('button', { name: 'New Folder' / 'Refresh' })` | Sama, `newFolder` / `refresh` di `article.file.toolbar`. |
| `aria-label` "Source mode" pada editor source | `tiptap-editor.tsx` prop `ariaLabel={tSourceMode('source')}`; `settings.editor.sourceMode.source` = "Source mode". |
| `getByRole('button', { name: 'Manage tags' })` | `record-tag-editor.tsx` `DialogTrigger` Button, teks `record.tagging.manage` = "Manage tags" di `en.json`. Satu tombol per baris record; alur wajib membatasi cakupan ke record yang diuji. |
| Teks menu "Delete" | `article.file.context.delete` = "Delete" di `en.json`; handler ada di `file-item.tsx` (`useFileDeletion`). Hanya TEKS yang terverifikasi; locator menu (`menuitem`) TIDAK terverifikasi, lihat tabel di bawah. |
| [trunk] `getByLabel('Email'/'Password')` + `getByRole('button', { name: 'Sign in' })` di `/login` | `src/app/login/page.tsx` (V3-03): label terasosiasi `htmlFor` + id tetap (`login-email`, `login-password`); string Inggris hardcoded di source halaman. Judul "Sign in to NoteGen" adalah TEKS, bukan heading (CardTitle merender `div`). |
| [trunk] Langkah TOTP: `getByLabel('Verification code'/'Recovery code')` + tombol "Verify" | `src/app/login/page.tsx`: label terasosiasi + id tetap (`login-code`, `login-recovery-code`); judul langkah "Two-step verification" adalah teks. |
| [trunk] `getByLabel(...)` + tombol "Create first account" di `/setup` | `src/app/setup/page.tsx` (V3-03): label terasosiasi + id tetap (`setup-token`, `setup-email`, `setup-password`, `setup-confirm-password`, `setup-workspace-name`); judul "Set up NoteGen" adalah teks. |
| [trunk] `getByTestId('search-input'/'search-clear'/'search-results'/'search-empty'/'search-fuzzy-status')` | `sidebar-search.tsx` (V3-28): atribut `data-testid` literal di source; sesuai usulan inventaris 10.4. Hanya kehadiran + peran `status` baris fuzzy yang dipin; teks persisnya tidak dipin di sini. |

TIDAK BISA diverifikasi (inference pustaka, butuh run untuk membuktikan):

| Selector | Alasan |
|---|---|
| `.ProseMirror` (editor visual) | Tidak satu pun source repo menyebut class ini untuk render; konvensi Tiptap/ProseMirror. |
| `.cm-content` (editor source) | Class dari internal CodeMirror 6; hanya `aria-label`-nya yang terverifikasi. |
| `.ProseMirror img` (gambar di editor) | Markup `<img>` dihasilkan Tiptap; `data-relative-src` terverifikasi sebagai sumber kebenaran markdown, bukan sebagai markup render. |
| `getByRole('dialog', { name: 'Settings' })` | Judul "Settings" terverifikasi (`settings-dialog.tsx`, `DialogTitle` sr-only), tetapi nama aksesibel dialog di DOM hidup belum diperiksa. |
| `getByRole('dialog', { name: 'Manage tags' })` | Judul "Manage tags" terverifikasi (`record-tag-editor.tsx`, `DialogTitle`), tetapi nama aksesibel dialog di DOM hidup belum diperiksa. Sama seperti dialog Settings. |
| Checkbox tag di editor tag | Label = nama tag (+ " (primary)" untuk tag primer) lewat `htmlFor` di `record-tag-editor.tsx`; checkbox tag primer disabled di source. Asosiasi role/label di DOM hidup belum diperiksa. |
| Tombol detail record (`aria-label` = isi/type) | `mark-item.tsx` `aria-label={label}`, `label = content \|\| t(mark.type)`; atribut `data-mark-detail-trigger` ada di source. Label diturunkan dari isi, belum dibuktikan di DOM hidup. |
| `getByRole('menuitem', { name: 'Delete' })` | Teks "Delete" terverifikasi di katalog, tetapi role container menu, role menuitem, dan mekanisme pemicu (klik kanan) tidak ditelusur ke komponen. |

TIDAK BISA diverifikasi (tidak ada hook stabil di source):

| Kebutuhan | Alasan |
|---|---|
| Tombol pembuka Settings | Tombol di title bar dan app sidebar TIDAK punya `aria-label`; hanya teks tooltip. Membuka Settings lewat role/nama tidak dapat diandalkan sampai pemilik UI menambah nama aksesibel atau `data-testid`. |
| Pindah tab sidebar (Notes/Record/Canvas) | `expandable-tabs.tsx` hanya merender teks judul saat tab terpilih; tab tak terpilih hanya ikon tanpa nama aksesibel. |
| Indikator "tersimpan" editor | Tidak ada string status simpan di UI editor (grep atas direktori editor: nihil). E2E-02/E2E-03 wajib menunggu efek simpan lewat polling isi disk, bukan lewat UI. |
| `data-testid` di luar pencarian | Repo acuan: 0 hasil grep `data-testid` di seluruh `src/`. Di trunk, UI pencarian punya test-id (lihat tabel terverifikasi di atas); halaman login/setup TIDAK punya test-id, dan scaffold ini tidak menambah `data-testid`: perubahan UI milik pemilik UI. |
| Halaman login (rute, field, tombol) | SUDAH TERATASI di trunk: halaman `/login` mendarat di V3-03 dengan locator terverifikasi (lihat tabel di atas). Baris ini dipertahankan sebagai catatan sejarah; spec `login.spec.ts` kini memakai locator itu. |
| Pemicu unduh arsip (tombol/halaman ekspor) | Tidak ada UI ekspor web; `backup-settings.tsx` upstream adalah UI direktori lokal desktop (dialog Tauri). Spec `archive-download.spec.ts` tanpa locator sampai UI ekspor dikirim pemilik UI. |
| Input rename file | Input rename tanpa nama aksesibel (inventaris R1): hanya dapat dipilih lewat konteks baris yang sedang di-rename. Alur buat folder/catatan (E2E-02, E2E-D1) wajib membuktikan input ini di DOM hidup. |
| Dialog buat record (WebRecordCreate) | Komponen mendarat di V3-26a tetapi tidak terpasang di halaman mana pun di trunk (V3-26b mendarat tanpa pemasangan); tidak ada locator sampai pemasangan tindak lanjut mendarat. Jangan menulis locator dari komponen yang tidak terjangkau browser. |

## Asumsi yang belum terverifikasi

- A4 (desain-pengujian 0.4): selector di atas terverifikasi terhadap source,
  belum terhadap DOM hasil render. Run hijau pertama adalah bukti runtime.
- Seed workspace (`harness/seed.ts`) terhubung lewat fixture backend
  (`harness/backend-fixture.ts`: direktori seed menjadi `WORKSPACE_ROOT`
  per test), tetapi BELUM terbukti live: belum ada run yang membuktikan
  entri seed tampil di pohon. Sampai run gate membuktikannya, tidak ada
  alur yang boleh mengklaim memakai seed lewat aplikasi.
- Isolasi per test (workspace + database + port per test, desain 4.1)
  diimplementasikan fixture backend (`harness/backend.ts` +
  `harness/backend-fixture.ts`), tetapi BELUM terbukti live. Konfigurasi
  tetap 1 worker; menaikkan worker butuh bukti live dulu.
- Backend/auth: server backend + endpoint auth SUDAH mendarat di trunk
  (gelombang 3A/3B), dan harness E2E-nya sudah mendarat sebagai kode
  (backend uji per test + isolasi workspace/database + seed wiring +
  jalur loopback melewati perimeter Cloudflare Access, lihat seksi
  "Backend harness" di atas). Yang belum ada adalah BUKTI LIVE-nya:
  0 run hijau browser sejauh ini, karena klaster Postgres di VM
  penulisan down; run live pertama adalah tugas gate merge di muse-2.
  Pengecualian: E2E-01 menguji kontrak fail-closed guard boot persis
  dalam kondisi tanpa backend (probe sesi 404), dan itu adalah perilaku
  nyata yang dipin, bukan placeholder.
- Seed pengaturan: tidak ada kunci/nilai pengaturan yang dipin di
  `harness/seed-data.ts`; pilihan pengaturan E2E-06 masih tertunda
  (V3-29 mendarat tanpa mencatat pilihan). Jangan mengarang kunci.
- Nilai debounce (A5) DIKONFIRMASI dari source repo acuan oleh pekerja
  pengganti V2-07: autosave editor 500 ms (`tiptap-editor.tsx`
  `scheduleMarkdownChange`, `setTimeout(..., 500)`), debounce simpan
  store 500 ms (`src/stores/article.ts`, `setTimeout(..., 500)` di
  `saveCurrentArticle`), debounce watcher 300 ms
  (`use-workspace-file-watcher.ts`, `delayMs: 300`), kalkulasi vektor
  5 detik (`src/stores/article.ts`, `setTimeout(..., 5000)`). Spec
  tetap tidak bergantung pada nilai persisnya: semua tunggu memakai
  observasi efek, tanpa `waitForTimeout` dan tanpa `sleep` tetap.
- Pohon file tervirtualisasi (`rowVirtualizer` di `file-manager.tsx`):
  hanya baris yang tampil yang ada di DOM. Alur yang membuka file di
  luar viewport wajib scroll dulu atau mempersempit pohon lewat input
  filter; locator per baris tidak dapat menemukan baris yang belum
  ter-render.
- CI: konfigurasi siap untuk job `e2e-smoke` (Chromium headless, retry 1,
  `reuseExistingServer: false` di CI). Jalan GitHub Actions sesungguhnya
  belum terverifikasi.

## Aturan anti-flaky (desain 4.3, mengikat)

- Tidak ada `sleep` tetap dan tidak ada `waitForTimeout` di spec maupun
  helper. Semua tunggu adalah observasi: elemen tampil, URL berubah,
  respons diterima, atau isi file di disk berubah.
- Satu test, satu workspace, satu database, setelah wiring isolasi mendarat.
- Retry maksimal 1 di CI; retry yang sukses tetap dilaporkan flaky oleh
  reporter list. Retry lokal dilarang menyembunyikan kegagalan pertama.
