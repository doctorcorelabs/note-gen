<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Codemod fixtures: import `@tauri-apps/*` ke registry platform

Fixture untuk mesin codemod V3-16a dan gate V3-16b. Ditulis oleh
V3-16c dari rencana gelombang 3 seksi 3C, desain registry V1-05
seksi 4, dan interface adapter di tree trunk. Branch mesin
(origin/web-codemod-engine, 922c5830) hanya berisi skeleton README
saat fixture ini ditulis; belum ada kontrak CLI atau transformasi
yang dapat diselarasakan. Selisih bentuk output mesin dicatat di
laporan V3-16c sebagai utang 3C dan di seksi "Keputusan yang
menunggu konfirmasi" di bawah.

Catatan salvage (V3-16cR, 15 November 2026): pekerja asal V3-16c
mati pada restart daemon 04:13 WIB; 39 kasus fixture, manifest, dan
README ini diselamatkan tanpa perubahan isi dari clone pendahulu
yang belum ter-commit, lalu dilengkapi di branch ini. Satu-satunya
perubahan konseptual oleh V3-16cR adalah koreksi kontrak
perbandingan (seksi "Aturan perbandingan" di bawah): `after.ts`
adalah keadaan akhir target sesudah tindak lanjut pekerja
gelombang, bukan klaim output mentah mesin. Koreksi ini didasarkan
pada draf mesin V3-16a yang belum ter-push (diamati read-only di
clone pendahulu V3-16a; mesin itu import-only, lihat butir K-0).
Branch mesin yang ter-push tetap skeleton saat salvage ini
ditulis; perilaku mesin final mengikuti V3-16aR dan keputusan
integrator.

Catatan salvage generasi ke-2 (V3-16cR2, 15 November 2026):
V3-16cR mati pada restart daemon 04:51 WIB sesudah push
c4b9fe4f; pekerjaan dilanjutkan dari tip branch yang sama
tanpa perubahan isi pada commit pendahulu. Audit 85 berkas R1,
penyelarasan dengan mesin V3-16aR2, dan pemutakhiran panduan
dicatat di laporan V3-16cR2 di `fase1/`.

## Tata letak

Tiap kasus adalah satu direktori di bawah `fixtures/` dengan
`before.ts` (kode upstream) dan `after.ts` (bentuk target). Kasus
bertahap (staged) menambah berkas `after-*.ts` per tahap jalan.
`manifest.json` adalah indeks yang dapat dibaca mesin: id, gelombang,
spesifier, pola, kind, berkas, dan ekspektasi laporan.

Fixture adalah contoh sintetis, bukan kode produksi. Fixture tidak
tercakup typecheck root (tsconfig `include` tidak mencakup
`scripts/`) dan tidak tercakup guard platform (cakupan guard adalah
`src/`). Fixture tetap wajib valid secara sintaks TypeScript dan
wajib lulus parse AST; validasi itu dijalankan atas salinan staging,
bukan atas tree repo.

## Kind

| Kind | Arti | Ekspektasi atas mesin |
|---|---|---|
| `auto` | Penulisan ulang sepenuhnya mekanis. | Keadaan akhir sesudah mesin + tindak lanjut terpandu laporan sama dengan `after.ts` secara semantik (lihat aturan perbandingan dua tahap). |
| `manual-review` | Import dapat ditulis ulang, tetapi keputusan semantik wajib dibuat manusia. | Mesin menulis ulang import (kecuali bila `identical` true) DAN mencatat berkas di laporan jalan sebagai MANUAL-REVIEW. Manusia menyelesaikan keputusan yang tercantum di manifest sebelum merge gelombang. |
| `no-op` | Mesin wajib tidak mengubah berkas. | Output byte-identik dengan `before.ts`. |
| `unsupported` | Mesin tidak boleh menulis ulang dan tidak boleh mengklaim sukses. | Mesin melaporkan UNSUPPORTED, membiarkan berkas tidak berubah, dan tidak melaporkan sukses atas berkas itu. |

Pasangan identik (`identical: true` di manifest) adalah pasangan
yang disengaja, bukan kesalahan salin: SQL funnel, api/image,
re-ekspor, dan kasus no-op. Jangan "memperbaiki" pasangan identik
menjadi pasangan berbeda tanpa keputusan tercatat.

## Aturan perbandingan: semantik, dua tahap, bukan byte

`after.ts` adalah keadaan akhir target: bentuk berkas sesudah
codemod selesai sepenuhnya, termasuk penulisan ulang call site ke
member expression platform. Output mentah mesin belum tentu sama
dengan `after.ts`: draf mesin V3-16a yang diamati bersifat
import-only (hanya pernyataan import yang diubah; call site
dilaporkan beserta pengganti yang disarankan untuk diterapkan
pekerja gelombang). Karena itu perbandingan dilakukan dua tahap:

- Tahap E (output mesin): pernyataan import pada output mesin
  dibandingkan dengan pernyataan import pada `after.ts` secara
  semantik. Spesifier target wajib hilang dari import (kecuali
  tahap bertahap dan pasangan identik yang didokumentasikan);
  import platform wajib hadir sesuai `after.ts`; teks non-import
  wajib tidak berubah oleh mesin.
- Tahap A (keadaan akhir): sesudah pengganti terpandu laporan
  mesin diterapkan atas call site (oleh pekerja gelombang, atau
  oleh mesin bila keputusan K-0 memperluas mesin), seluruh berkas
  dibandingkan dengan `after.ts` secara semantik.

Bila mesin final diperluas hingga menulis ulang call site
(keputusan K-0 opsi mesin-penuh), tahap E dan tahap A menyatu:
output mesin langsung dibandingkan dengan `after.ts`. Sampai K-0
diputus, kegagalan tahap E atas call site BUKAN kegagalan fixture;
yang dinilai adalah tahap E atas import + kelengkapan laporan
mesin (setiap call site yang musti berubah tercantum beserta
penggantinya) + tahap A atas keadaan akhir.

Perbedaan berikut DIIZINKAN dan bukan
kegagalan:

- Gaya kutip (`'` vs `"`), titik koma, spasi, dan baris kosong.
- Penggabungan atau pemecahan pernyataan import dari modul yang
  sama (mis. import nilai + import type digabung dengan inline
  `type`, atau sebaliknya), selama himpunan binding yang diimpor
  sama.
- Urutan binding di dalam satu pernyataan import.
- Penempatan pernyataan import platform di antara import lain,
  selama tidak mengubah urutan efek samping modul.

Perbedaan berikut adalah KEGAGALAN:

- Spesifier target masih muncul di output (kecuali pada tahap
  bertahap yang memang menyisakannya, atau pada pasangan identik
  yang didokumentasikan).
- Nama adapter, nama metode, atau nama tipe yang berbeda dari
  `after.ts` (mis. `platform.store.get` padahal targetnya
  `platform.store.load`).
- Call site yang hilang, bertambah, atau berubah argumennya.
- Binding lokal yang hilang tanpa pengganti member expression
  yang setara.
- Perubahan logika di luar penulisan ulang import (codemod hanya
  mengganti sumber API).

Untuk kasus bertahap, tiap tahap dibandingkan dengan berkas
tahapnya masing-masing, dan bentuk final dibandingkan dengan
`after.ts`. Urutan tahap hanya fleksibel bila manifest menyatakan
`stageOrderFlexible: true`.

## Cara menjalankan fixture atas mesin

Jalankan dari root repo, atas SALINAN staging (jangan pernah
menjalankan mesin dengan flag tulis langsung atas direktori
fixture di tree kerja):

1. Salin tiap `before.ts` ke direktori staging di luar tree repo.
2. Jalankan mesin satu spesifier per jalan, dengan daftar berkas
   eksplisit, tanpa flag tulis lebih dulu (dry-run) untuk membaca
   diff; lalu jalankan dengan flag tulis atas salinan staging.
3. Bandingkan output dengan `after.ts` (atau berkas tahap) memakai
   aturan dua tahap di atas: tahap E atas import, tahap A atas
   keadaan akhir sesudah tindak lanjut terpandu laporan.
4. Periksa laporan jalan mesin: kasus `manual-review` dan
   `unsupported` wajib tercantum; kasus `auto` tidak boleh
   tercantum sebagai manual.
5. Catat hasil per kasus (lulus/gagal + selisih) di laporan
   pekerja. Kegagalan fixture menghentikan klaim "mesin siap"
   sampai diperbaiki atau diputuskan lain oleh koordinator.

Nama perintah CLI mesin mengikuti implementasi V3-16a; dokumen
ini sengaja tidak mengarang nama perintah. Panduan pemakaian
lengkap ada di luar repo: `fase1/panduan-codemod.md`.

## Cakupan

| Kasus | Gelombang | Spesifier | Pola | Kind |
|---|---|---|---|---|
| `g1-store-static` | G1 | `@tauri-apps/plugin-store` | 1 | auto |
| `g1-store-dynamic` | G1 | `@tauri-apps/plugin-store` | 5 | auto |
| `g1-store-type-only` | G1 | `@tauri-apps/plugin-store` | 3 | auto |
| `g1-sql-funnel` | G1 | `@tauri-apps/plugin-sql` | 1, 3 | manual-review |
| `g1-fs-static` | G1 | `@tauri-apps/plugin-fs` | 1, 4 | auto |
| `g1-fs-type-only` | G1 | `@tauri-apps/plugin-fs` | 3 | auto |
| `g1-path-static` | G1 | `@tauri-apps/api/path` | 1 | auto |
| `g1-fs-dynamic-module` | G1 | `@tauri-apps/plugin-fs` | 5, 6 | auto |
| `g2-core-invoke` | G2 | `@tauri-apps/api/core` | 1 | auto |
| `g2-core-channel` | G2 | `@tauri-apps/api/core` | 1 | auto |
| `g2-core-istauri` | G2 | `@tauri-apps/api/core` | 1 | auto |
| `g2-http-static` | G2 | `@tauri-apps/plugin-http` | 1, 3, 4 | auto |
| `g2-http-dynamic` | G2 | `@tauri-apps/plugin-http` | 5 | auto |
| `g3-dialog-static` | G3 | `@tauri-apps/plugin-dialog` | 1, 4 | auto |
| `g3-dialog-dynamic` | G3 | `@tauri-apps/plugin-dialog` | 5 | auto |
| `g3-opener-static` | G3 | `@tauri-apps/plugin-opener` | 1 | manual-review |
| `g3-clipboard-static` | G3 | `@tauri-apps/plugin-clipboard-manager` | 1 | auto |
| `g3-asset-convert` | G3 | `@tauri-apps/api/core` | 1 | auto |
| `g4-window-static` | G4 | `@tauri-apps/api/window` | 1 | auto |
| `g4-webviewwindow-static` | G4 | `@tauri-apps/api/webviewWindow` | 1 | auto |
| `g4-window-size-value` | G4 | `@tauri-apps/api/window` | 1 | manual-review |
| `g4-event-static` | G4 | `@tauri-apps/api/event` | 1 | auto |
| `g4-event-type-only` | G4 | `@tauri-apps/api/event` | 3 | auto |
| `g4-os-static` | G4 | `@tauri-apps/plugin-os` | 1, 4 | auto |
| `g4-app-version` | G4 | `@tauri-apps/api/app` | 1, 5 | auto |
| `g4-notification-multiline` | G4 | `@tauri-apps/plugin-notification` | 2 | auto |
| `g5-shortcut-static` | G5 | `@tauri-apps/plugin-global-shortcut` | 1 | auto |
| `g5-shell-static` | G5 | `@tauri-apps/plugin-shell` | 1 | auto |
| `g5-process-static` | G5 | `@tauri-apps/plugin-process` | 1 | auto |
| `g5-autostart-multiline` | G5 | `@tauri-apps/plugin-autostart` | 2, 4 | auto |
| `g5-updater-static` | G5 | `@tauri-apps/plugin-updater` | 1, 3 | manual-review |
| `g5-image-static` | G5 | `@tauri-apps/api/image` | 1, 4 | manual-review |
| `edge-promise-all-batch` | G4 | `@tauri-apps/api/window, @tauri-apps/api/webviewWindow` | 5, 7 | auto |
| `edge-reexport` | EDGE | `@tauri-apps/plugin-store` | 0 | unsupported |
| `edge-multi-specifier-staged` | EDGE | `@tauri-apps/plugin-store, @tauri-apps/api/core, @tauri-apps/api/event` | 7 | auto |
| `edge-no-target` | EDGE | `(none)` | 0 | no-op |
| `edge-other-wave-only` | EDGE | `@tauri-apps/plugin-shell` | 0 | no-op |
| `edge-internals-no-import` | EDGE | `(none)` | 8 | auto |
| `edge-string-literal` | EDGE | `(none)` | 0 | no-op |


Hitungan: 39 kasus (32 kasus gelombang + 7 kasus ber-id edge-*).
Per kolom gelombang di manifest: G1 8, G2 5, G3 5, G4 9 (8 kasus
G4 + edge-promise-all-batch yang memang milik G4), G5 6, EDGE 6.
Per kind: auto 30, manual-review 5, no-op 3, unsupported 1. Ke-21 spesifier `@tauri-apps/*` tercakup; kedelapan
pola desain seksi 4.3 tercakup; re-ekspor tercakup sebagai kasus
tepi defensif (0 kemunculan di tree trunk). Di luar 39 kasus itu,
direktori `gate-violation/` (lihat seksi di bawah) adalah fixture
pelanggaran yang disengaja untuk gate V3-16b; ia bukan kasus
mesin dan tidak masuk hitungan 39.

## Fixture pelanggaran untuk gate (V3-16b)

Direktori `gate-violation/` memuat satu berkas
`violation.ts`: import `@tauri-apps/plugin-store` yang belum
dimigrasi, satu pola turunan `Store.load` mentah, dan satu
penyebutan `__TAURI_INTERNALS__`. Berkas ini adalah INPUT UJI
gate, bukan input mesin: salin ke bawah `src/` pada tree staging,
lalu gate 4 lapis wajib MERAH pada lapis 1 (grep spesifier) dan
lapis 2 (grep pola turunan). Berkas ini tidak boleh di-commit di
bawah `src/` dan tidak boleh dijalankan lewat mesin sebagai kasus
biasa (ia tidak punya pasangan before/after). Skrip gate milik
V3-16b; fixture ini milik V3-16c sebagai koordinasi lewat berkas.
Detail ekspektasi per lapis ada di `gate-violation/README.md`.

## Bentuk after yang dipakai fixture

Seluruh after memakai bentuk kanonis berikut, yang diturunkan dari
barrel trunk `src/lib/platform/index.ts` dan interface adapter
trunk:

- Import nilai: `import { platform } from '@/lib/platform'`, lalu
  `platform.<adapter>.<metode>(...)`. Barrel tidak mengekspor
  fungsi adapter mandiri, sehingga tidak ada after berbentuk
  import fungsi langsung dari platform.
- Import tipe: `import type { <Nama> } from '@/lib/platform'`
  dengan nama tipe barrel (mis. `StoreHandle`, `UpdateInfo`,
  `LogicalSizeValue` diganti objek polos, bukan kelas).
- Deteksi: `isTauriRuntime` dari barrel.
- Nilai enum: `BaseDirectory` diimpor sebagai nilai dari barrel.
- String nama command invoke tidak diubah.
- Logika pemanggil tidak diubah selain penulisan ulang sumber API
  dan konstruktor/factory yang dipetakan interface (Channel,
  WebviewWindow, LogicalSize/PhysicalPosition).

## Keputusan yang menunggu konfirmasi

Butir berikut adalah keputusan fixture yang wajib dikonfirmasi
V3-16a (mesin) atau koordinator sebelum fixture dipakai sebagai
gate pengunci. Bila keputusan berubah, fixture yang terdampak
diregenerasi dan perubahan dicatat; jangan mengubah after dengan
tangan tanpa memperbarui manifest dan generator.

K-0. Cakupan mesin: import-only + tindak lanjut terpandu laporan,
atau mesin-penuh (mesin juga menulis ulang call site)? Draf mesin
V3-16a yang belum ter-push memakai model import-only; `after.ts`
fixture memakai bentuk keadaan akhir. Sampai integrator memutus
K-0, perbandingan dua tahap pada seksi "Aturan perbandingan"
berlaku dan tidak ada klaim "mesin lulus fixture" atas output
mentah mesin. Opsi putusan: (a) mesin tetap import-only dan
harness perbandingan dua tahap dipakai sebagai gate fixture;
(b) mesin diperluas menulis ulang call site dan output mesin
dibandingkan langsung dengan `after.ts`. Kedua opsi memakai
`after.ts` yang sama sebagai keadaan akhir target.

1. Bentuk alias: nama lokal alias tidak dipertahankan sebagai
   binding; call site ditulis ulang ke member expression platform.
   Terdampak: g1-fs-static, g2-http-static, g3-dialog-static,
   g4-os-static, g5-autostart-multiline.
2. Pemetaan tipe Store ke StoreHandle (g1-store-type-only).
3. Pemetaan tipe Update ke UpdateInfo (g5-updater-static).
4. Pengecualian subset convertFileSrc pada jalan G2 atas api/core
   (g3-asset-convert): mesin mendukung pengecualian per nama, atau
   pekerja G2 mengecualikan ke-9 berkas dari daftar berkas.
5. Penanganan pola 8 (`__TAURI_INTERNALS__`) oleh mesin
   (edge-internals-no-import): mode yang sama atau mode terpisah
   yang terdokumentasi.
6. Perilaku mesin atas re-ekspor (edge-reexport): wajib
   UNSUPPORTED + tidak sukses; bentuk pelaporan mengikuti kontrak
   CLI mesin.

## Yang bukan tugas fixture

Fixture tidak menggantikan gate 4 lapis atas tree nyata, tidak
menggantikan audit manual (call site clear/reset/reload/close,
pembaca apiKey, set undefined, audit platform() untuk nilai
'web', keputusan per call site opener/dialog), dan tidak
menentukan urutan merge. Urutan merge, gate per gelombang, dan
eskalasi konflik diatur panduan di luar repo.

## Lisensi dan kebersihan

Seluruh berkas fixture membawa header SPDX GPL-3.0-only. Fixture
memakai 0 karakter em dash. Fixture tidak memuat secret, kredensial,
atau data nyata; nama berkas store (`store.json`) dan nama command
(`ping`, `stream_command`) adalah nilai sintetis.
