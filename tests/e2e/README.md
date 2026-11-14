# E2E Playwright: scaffold Fase 1

Scaffold harness E2E untuk fork web NoteGen. Desain: `fase1/desain-pengujian.md`
seksi 4 (V1-15). Scaffold ini (V2-07) hanya memasang harness dan alur:
6 alur `@smoke` dari desain (1 alur nyata boot + 5 alur TODO yang gagal
eksplisit) ditambah 4 spec `@scaffold` untuk alur kritis brief pemulihan
gelombang 2 (login, hapus catatan, record+tag, unduh arsip), semuanya TODO
yang gagal eksplisit. Tidak ada lulus palsu. Pemetaan dan justifikasi
penambahan ada di seksi "Alur @scaffold (brief pemulihan)" di bawah.

## Cara jalan

```sh
pnpm install
pnpm build
pnpm e2e:smoke   # 6 alur @smoke (saat ini: boot nyata, 5 TODO gagal eksplisit)
pnpm e2e          # semua spec di tests/e2e (termasuk 4 spec @scaffold)
pnpm exec playwright test --grep @scaffold  # hanya 4 spec @scaffold
```

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
| E2E-01 boot tanpa backend | `boot.spec.ts` | Nyata. Ditujukan lulus terhadap build web saat ini: guard boot (M14) memblokir dengan layar error BOOT_SESSION_UNKNOWN yang dapat dipahami, bukan halaman kosong dan bukan redirect buta, karena server statis tidak menjawab `/api/auth/me` (404). Varian boot terautentikasi (redirect ke `/core/main` + pohon file) menunggu harness backend gelombang 3; jangan melemahkan assertion fail-closed ini. |
| E2E-01b boot store rusak | `boot.spec.ts` | `test.skip` sebagai utang terdokumentasi: harness belum bisa merusak store. Bukan lulus. |
| E2E-02 buat + simpan | `create-save.spec.ts` | TODO: gagal dengan pesan "fitur belum mendarat". |
| E2E-03 ubah artikel lama | `edit-existing.spec.ts` | TODO: gagal dengan pesan "fitur belum mendarat". |
| E2E-04 cari | `search.spec.ts` | TODO: gagal dengan pesan "fitur belum mendarat". |
| E2E-05 file dari luar | `external-file.spec.ts` | TODO: gagal dengan pesan "fitur belum mendarat". |
| E2E-06 pengaturan bertahan | `settings-persist.spec.ts` | TODO: gagal dengan pesan "fitur belum mendarat". |
| E2E-S1 login | `login.spec.ts` | TODO `@scaffold`: gagal dengan pesan "fitur belum mendarat". UI login belum ada; tanpa locator tebakan. |
| E2E-S2 hapus catatan (CRUD) | `notes-crud.spec.ts` | TODO `@scaffold`: gagal dengan pesan "fitur belum mendarat". Create = E2E-02, Read/Update = E2E-03. |
| E2E-S3 record + tag | `record-tag.spec.ts` | TODO `@scaffold`: gagal dengan pesan "fitur belum mendarat". |
| E2E-S4 unduh arsip | `archive-download.spec.ts` | TODO `@scaffold`: gagal dengan pesan "fitur belum mendarat". UI ekspor belum ada; tanpa locator tebakan. |

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

## Struktur

| Berkas | Isi |
|---|---|
| `playwright.config.ts` (root) | `testDir`, Chromium headless, 1 worker, retry 1 di CI / 0 lokal, reporter list, `webServer` server statis. |
| `harness/static-server.mjs` | Server statis `out/` tanpa dependensi; gagal cepat bila `out/` tidak ada; `Cache-Control: no-store`. |
| `harness/selectors.ts` | Semua locator, beserta status verifikasi per locator. |
| `harness/app-page.ts` | Page object: boot, buka file, buat catatan, cari global. |
| `harness/preflight.ts` | Cek HTTP 200 untuk `/markdown-lexer.js?v=4` dan `/plugin-runtime.js`. |
| `harness/seed.ts` | Seed workspace deterministik (belum terhubung ke aplikasi, lihat di bawah). |
| `harness/external-writer.ts` | Penulis file atomik "proses luar" untuk E2E-05. |
| `harness/todo.ts` | Helper `notYetLanded` untuk spec TODO. |

## Status verifikasi selector (A4)

Semua selector diperiksa terhadap komponen aktual di repo acuan (HEAD
4dcaa3f) dan katalog pesan Inggris (`messages/en.json`, locale default `en`).
Pekerja pengganti V2-07 memeriksa ulang tiap selector dan memeriksa kode
pustaka `@headless-tree/core` 1.7.0 (container `role: "tree"`,
`aria-label`; item `role: "treeitem"`, `aria-label: getItemName()`) dan
`cmdk` 1.1.1 (`CommandItem` merender `role: "option"`) dari tarball npm.
"TERVERIFIKASI (source)" berarti role/nama/atribut mengikuti source komponen
+ katalog pesan; perilaku runtime di browser nyata tetap belum terverifikasi
sampai ada run hijau. Tidak satu pun selector di bawah ini terbukti lewat
run browser saat scaffold ditulis, kecuali dinyatakan lain di laporan
`fase1/laporan-e2e-scaffold.md`.

TERVERIFIKASI (source):

| Selector | Bukti source |
|---|---|
| `getByRole('tree', { name: 'Workspace files' })` | `file-manager.tsx` `getContainerProps(t('treeLabel'))`; `article.file.treeLabel` = "Workspace files"; `@headless-tree/core` container props (`role: "tree"`, `aria-label`). |
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
| `data-testid` apa pun | 0 hasil grep `data-testid` di seluruh `src/`. Scaffold ini tidak menambah `data-testid`: perubahan UI milik pemilik UI. |
| Halaman login (rute, field, tombol) | Tidak ada UI login di repo acuan; desain-auth menetapkan endpoint API dan halaman `/setup`, bukan rute/field login. Spec `login.spec.ts` tanpa locator sampai UI login dikirim pemilik UI. |
| Pemicu unduh arsip (tombol/halaman ekspor) | Tidak ada UI ekspor web; `backup-settings.tsx` upstream adalah UI direktori lokal desktop (dialog Tauri). Spec `archive-download.spec.ts` tanpa locator sampai UI ekspor dikirim pemilik UI. |

## Asumsi yang belum terverifikasi

- A4 (desain-pengujian 0.4): selector di atas terverifikasi terhadap source,
  belum terhadap DOM hasil render. Run hijau pertama adalah bukti runtime.
- Seed workspace (`harness/seed.ts`) belum terhubung: belum ada cara
  (env/API) untuk memberi tahu aplikasi direktori workspace untuk satu test.
  Sampai wiring itu mendarat, tidak ada alur yang boleh mengklaim memakai seed.
- Isolasi per test (workspace + database + port per worker, desain 4.1)
  belum mendarat; konfigurasi memakai 1 worker terhadap satu server statis.
 - Backend/auth belum mendarat; suite saat ini hanya menguji artefak statis
  + shim POC yang ada di build. Alur yang butuh API tidak dapat ditulis
  nyata sampai backend mendarat. Pengecualian: E2E-01 menguji kontrak
  fail-closed guard boot persis dalam kondisi tanpa backend (probe sesi
  404), dan itu adalah perilaku nyata yang dipin, bukan placeholder.
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
