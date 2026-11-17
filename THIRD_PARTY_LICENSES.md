# Third-Party Licenses

Inventaris lisensi dependensi fork web NoteGen (gate G6, F10 bagian 8.4).
Karya fork sendiri dilisensikan GPLv3; lihat `LICENSE` dan `FORK.md`.
Berkas ini mencatat lisensi dependensi pihak ketiga, BUKAN lisensi kode fork.

## 0. Pilihan lokasi berkas

F10 bagian 8.4 dan G6 mengizinkan `docs/licenses.md` ATAU
`THIRD_PARTY_LICENSES.md`. Berkas ini memakai bentuk kedua, di root repo,
dengan alasan: direktori `docs/` di-ignore `.gitignore` (situs dokumen
upstream yang tidak ada di trunk), sehingga `docs/licenses.md` membutuhkan
pengecualian direktori yang rumit; bentuk root hanya membutuhkan satu baris
pengecualian `!THIRD_PARTY_LICENSES.md`, sejajar preseden `!FORK.md`, dan
paling mudah ditemukan di samping `LICENSE` saat conveyance.

## 1. Cakupan dan metode

- Trunk yang diinventaris: commit `2cd58757fbcf0aacd9d399e810b77ab1449eaec7`
  (branch `web`), 18 November 2026.
- Sumber paket: bagian `packages:` di `pnpm-lock.yaml` root (1411 paket
  unik nama@versi) dan `server/pnpm-lock.yaml` (240 paket); gabungan 1540
  paket unik. Varian peer digabung per nama@versi karena lisensi melekat
  pada paket. Hitung ulang independen (parser awk berbeda) mengonfirmasi
  1411 / 240 / 1540.
- Sumber lisensi, urutan: (1) field `license` di `package.json` paket
  terpasang (cocok persis nama@versi, tanpa tebakan); (2) metadata registri
  npm per nama@versi persis, hanya untuk paket yang tidak teridentifikasi
  dari instalasi ditambah paket ber-flag (193 kueri); (3) teks berkas
  LICENSE paket terpasang untuk 4 paket yang field-nya kosong di kedua
  sumber (lihat bagian 5). `pnpm-lock.yaml` v9 tidak memuat info lisensi.
- Hasil: 1540 dari 1540 teridentifikasi (100 persen); 0 konflik
  root-vs-server, 0 konflik registri-vs-instalasi, 0 paket terpasang di
  luar lockfile. Skrip dan output mentah disimpan di luar repo (evidence
  perencanaan gelombang 5, slot W5-LICENSE r14); berkas ini adalah
  ringkasan tercatat yang wajib dibuat ulang bila lockfile berubah.
- Di luar cakupan: crate Rust (`src-tauri/Cargo.lock`, 918 entri, 769 nama
  unik) dan aset non-kode. Keputusan cakupan: rilis web pertama tidak
  memakai Rust/Tauri di image (F10 bagian 5.1), sehingga inventaris crate
  ditunda ke tonggak desktop; rilis desktop apa pun WAJIB menginventaris
  crate terlebih dahulu. Plugin clipboard Rust yang di-vendor
  (`src-tauri/vendor/tauri-plugin-clipboard`, MIT, lihat LICENSE di
  direktori itu) ikut dalam penundaan yang sama. Keputusan ini menunggu
  penerimaan koordinator.

## 2. Ringkasan

| Lisensi (verbatim) | Jumlah |
| --- | ---: |
| MIT | 1305 |
| ISC | 71 |
| Apache-2.0 | 49 |
| BSD-3-Clause | 24 |
| BSD-2-Clause | 16 |
| Apache-2.0 OR MIT | 14 |
| MIT OR Apache-2.0 | 14 |
| MPL-2.0 | 13 |
| LGPL-3.0-or-later | 9 |
| Unlicense | 8 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 |
| CC-BY-4.0 | 2 |
| BlueOak-1.0.0 | 2 |
| CC0-1.0 | 2 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| Python-2.0 | 1 |
| (MIT OR Apache-2.0) | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| EPL-2.0 OR GPL-3.0-or-later | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |
| MIT AND ISC | 1 |

Total: 1540 paket.

## 3. Kategori kompatibilitas

Kategori ditetapkan mekanis dari string lisensi; putusan akhir milik
peninjau/koordinator. Tidak ada paket berkategori BLOKIR pada trunk ini.

| Kategori | Arti |
| --- | --- |
| PERMISIF | Lisensi permisif; kompatibel dengan distribusi karya GPLv3 sejauh kewajiban atribusi/pemberitahuan dipenuhi lewat inventaris ini. |
| TINJAU_LGPL | LGPL; searah GPLv3 (dapat direlisensi ke GPL-3.0); peninjau mencatat status distribusi dan kewajiban teks LGPL bila biner ikut terdistribusi. |
| TINJAU_COPYLEFT_LEMAH | Copyleft tingkat berkas (MPL-2.0); kewajiban menyangkut modifikasi berkas berlisensi itu sendiri. Fork tidak memodifikasi berkas-berkas ini (tanpa patch pnpm, tanpa direktori patches). |
| TINJAU_DWI_LISENSI | Dwi-lisensi; sisi yang dipakai fork dicatat di bagian 4 dan menunggu penerimaan koordinator. |

| Kategori | Jumlah |
| --- | ---: |
| PERMISIF | 1512 |
| TINJAU_LGPL | 13 |
| TINJAU_COPYLEFT_LEMAH | 13 |
| TINJAU_DWI_LISENSI | 2 |

Per asal lockfile: hanya root 1300, hanya server 129, kedua lockfile 111.

## 4. Catatan peninjauan (28 paket)

Tidak ada paket berlisensi tidak kompatibel dengan GPLv3 pada trunk ini
(0 AGPL, 0 GPL-2.0/GPL-1.0, 0 SSPL, 0 lisensi nonkomersial, 0 BUSL/Elastic/
Commons Clause, 0 proprietary/UNLICENSED). Tidak ada rencana penggantian
yang dibutuhkan. Ke-28 paket di bawah ini memerlukan catatan peninjauan,
bukan penggantian.

### 4.1 LGPL (13 paket, semua transitif, hanya lockfile root)

Sembilan biner `@img/sharp-libvips-*@1.2.0` (LGPL-3.0-or-later) adalah
biner platform libvips untuk `sharp`. Empat paket platform sharp
(`@img/sharp-wasm32@0.34.3`, `@img/sharp-win32-*@0.34.3`) memakai
kombinasi `Apache-2.0 AND LGPL-3.0-or-later` (plus MIT untuk wasm32).
Rantai: `sharp@0.34.3` (Apache-2.0) adalah dependensi OPSIONAL `next`
dan tidak dipanggil saat runtime karena `images.unoptimized: true` di
`next.config.ts`; hanya biner platform build/deploy yang pernah
terpasang dalam praktik. Bila Dockerfile kelak menyertakan biner
libvips/sharp di image yang dipublikasikan, teks LGPL dan pemberitahuan
yang diwajibkan wajib tersedia di artefak rilis. Inventaris ini
mencakup lockfile, bukan isi image final; SBOM saat publikasi image
adalah pemeriksaan akhir atas apa yang benar-benar terkirim.

### 4.2 MPL-2.0 (13 paket, semua transitif, hanya lockfile root)

`axe-core@4.10.3` (via `eslint-plugin-jsx-a11y`, waktu lint) dan keluarga
`lightningcss@1.32.0` beserta 11 biner platformnya (via
`@tailwindcss/node` dan `vite`, waktu build). Tidak ada modifikasi fork
atas berkas berlisensi MPL (tanpa patch, tanpa vendor). Kewajiban MPL
tingkat berkas terpenuhi sejauh berkas-berkas itu didistribusikan tanpa
modifikasi beserta pemberitahuan lisensinya; peninjau mencatat fakta
tidak-ada-modifikasi ini.

### 4.3 Dwi-lisensi (2 paket)

- `dompurify@3.3.1`, `(MPL-2.0 OR Apache-2.0)`, transitif via
  `mermaid@11.12.2` (satu-satunya konsumen). Sisi yang dipakai fork:
  Apache-2.0. Menunggu penerimaan koordinator.
- `elkjs@0.12.0`, `EPL-2.0 OR GPL-3.0-or-later`, dependensi LANGSUNG
  root. Sisi yang dipakai fork: GPL-3.0-or-later (searah lisensi fork).
  Menunggu penerimaan koordinator.

## 5. Adendum berkas lisensi (4 paket)

Keempat paket ini tidak punya field `license` di `package.json`
terpasang maupun di metadata registri npm (HTTP 200, field kosong).
Lisensinya dibaca langsung dari teks berkas lisensi paket terpasang;
baris awal dikutip verbatim. Pembacaan ini menunggu penerimaan peninjau.

| Paket | Berkas | Bukti teks (baris awal) | Pembacaan |
| --- | --- | --- | --- |
| @sereneinserenade/tiptap-search-and-replace@0.1.1 | LICENSE | "MIT License", "Copyright (c) 2023 Jeet Mandaliya" | MIT |
| fast-shallow-equal@1.0.0 | LICENSE | "This is free and unencumbered software released into the public domain." | Unlicense |
| khroma@2.1.0 | license | "The MIT License (MIT)", "Copyright (c) 2019-present Fabio Spampinato, Andrew Maney" | MIT |
| react-universal-interface@0.6.2 | LICENSE | "This is free and unencumbered software released into the public domain." | Unlicense |

Satu-satunya dependensi langsung di antara keempatnya adalah
`@sereneinserenade/tiptap-search-and-replace` (root).

## 6. Kelengkapan GPLv3 rilis (verifikasi 18 Nov 2026)

- `LICENSE` utuh: identik byte-per-byte dengan LICENSE upstream
  codexu/note-gen branch dev (674 baris, 35129 byte, MD5
  `ed98f2c63f2a8555d2b7cbaa5d83df3b`); selisih terhadap teks GPLv3
  kanonis gnu.org hanya baris 4 (notice hak cipta codexu 2025, milik
  upstream, dipertahankan verbatim sesuai F10 bagian 8.1).
- Notice fork di `FORK.md`: ADA (identitas fork, basis upstream
  `4dcaa3f03a661c1259f8dfcdbc4a94c8cba0ffd5`, notice modifikasi GPLv3,
  penentuan GPL-3.0-only, log sync, changelog).
- Notice fork di `README.md`: BELUM ADA. README masih README upstream
  tanpa baris fork setelah judul (F10 bagian 8.1 mensyaratkan baris
  tersebut); hanya seksi License di akhir yang menyebut GPLv3. Tindak
  lanjut di luar slot inventaris: tambahkan notice fork di README.
- Header lisensi berkas baru: aturan yang dipakai adalah konvensi trunk
  (3 baris: `SPDX-License-Identifier: GPL-3.0-only` + pernyataan bagian
  dari fork GPLv3 + `See LICENSE and FORK.md`, dalam sintaks komentar
  berkas, 10 baris pertama). Audit added-vs-basis-upstream: 726 dari
  755 berkas baru membawa token SPDX; 29 sisanya adalah berkas tanpa
  dukungan komentar (JSON ketat, lockfile), berkas tergenerasi
  (snapshot Drizzle), dokumen, contoh env, dan 1 berkas `.ts` dengan
  bentuk header pra-SPDX (notice hak cipta + pernyataan GPLv3, tanpa
  token SPDX). Penyimpangan dari teks harfiah F10 bagian 8.2: tidak ada
  satu pun header yang memuat baris tahun + pemegang hak cipta; koordinator
  memutuskan apakah teks F10 diamandemen mengikuti konvensi trunk atau
  baris tersebut ditambahkan ke depan. Berkas upstream yang diubah tidak
  wajib berheader (F10 bagian 8.2); 2 dari 462 berkas termodifikasi
  membawa SPDX.
- Metadata paket: `server/package.json` ber-field `GPL-3.0-only` (baik);
  `package.json` root TIDAK punya field `license` (celah, tindak lanjut
  terpisah: tambahkan `GPL-3.0-only`, di luar slot inventaris).
- Repo publik: terverifikasi lewat `git ls-remote` HTTPS tanpa autentikasi
  yang mengembalikan ref `web` (repo privat akan menolak). Belum ada tag
  rilis di remote (0 tag) dan belum ada image GHCR (placeholder di
  compose deploy); pemetaan digest di bagian 7 bersifat prosedural.
- Pemeriksaan lisensi CI: BELUM ADA job `license-check` di
  `.github/workflows/web-ci.yml` (komentar workflow menyebutnya sebagai
  pekerjaan terpisah). G6 langkah 5 (aktivasi sebelum rilis publik
  pertama) adalah tindak lanjut di luar slot ini; skrip inventaris slot
  ini adalah bahan bakunya.

## 7. Pemetaan digest image ke commit (prosedur + templat)

Prosedur ini berlaku untuk SETIAP image yang dipublikasikan ke GHCR
(conveyance). Pemetaan nyata terjadi saat publikasi image; belum ada
image, digest, atau tag rilis pada saat berkas ini ditulis.

Prosedur (F10 bagian 7.2/7.3/8.3, rencana deploy bagian 3.2):

1. Build HANYA di CI dari commit trunk dengan CI hijau; tidak pernah
   dari working tree kotor. Tag image: `<versi-fork>` (immutable),
   `<versi-fork>-<sha-pendek>` (jejak build); tag mutable (`dev`,
   `main`, `latest`) dilarang untuk produksi. Deploy memakai digest
   (`image@sha256:...`), bukan tag.
2. Setiap image membawa label OCI: `org.opencontainers.image.revision`
   = commit fork penuh; `upstream.base.commit` = commit basis upstream
   (`4dcaa3f03a661c1259f8dfcdbc4a94c8cba0ffd5` sampai sync berikutnya);
   `org.opencontainers.image.version` = versi fork.
3. Publikasi menyertakan provenance/SBOM/attestation. SBOM image
   dibandingkan dengan inventaris ini; paket baru yang tidak dikenal
   menghentikan rilis sampai inventaris diperbarui.
4. Catatan rilis (templat di bawah) mencatat pemetaan tag/digest ke
   commit untuk SETIAP image. Tag Git rilis (`fork-v<versi-fork>`)
   dibuat untuk commit tersebut dan TIDAK PERNAH dihapus atau dipindah.
5. Digest di compose deploy WAJIB sama dengan digest di catatan rilis.
   Bila berbeda, deploy dinyatakan tidak terlacak dan dihentikan.
6. Corresponding Source untuk image yang dipublikasikan adalah repo
   publik pada commit bertag tersebut (termasuk Dockerfile, workflow
   CI, skrip build, dan inventaris ini pada commit itu).

Templat catatan rilis (salin per rilis, isi semua placeholder):

```
Rilis fork: <versi-fork, mis. 0.39.2-fork.1>
Tag Git: fork-v<versi-fork> (commit fork: <sha penuh 40 hex>)
Commit basis upstream: 4dcaa3f03a661c1259f8dfcdbc4a94c8cba0ffd5
Tanggal publikasi: <YYYY-MM-DD HH:MM WIB>
CI: <tautan run workflow rilis, hijau>

Image:
- ghcr.io/doctorcorelabs/note-gen-web:<versi-fork>
  digest: sha256:<digest web>
  label revision: <sha penuh commit fork>
- ghcr.io/doctorcorelabs/note-gen-api:<versi-fork>
  digest: sha256:<digest api>
  label revision: <sha penuh commit fork>

Perubahan fork sejak rilis sebelumnya:
- <butir perubahan, sejajar CHANGELOG fork>

Inventaris lisensi: THIRD_PARTY_LICENSES.md pada commit rilis ini
(1540 paket pada 2cd58757; hitung ulang bila lockfile berubah).
SBOM/provenance/attestation: <tautan artefak publikasi>
```

## 8. Tabel paket lengkap

Diurutkan nama, lalu versi. Kolom Sumber: `node_modules` = field license
paket terpasang; `registry` = metadata registri npm; `license-file-text`
= teks berkas LICENSE (bagian 5). Kolom Catatan hanya diisi untuk paket
tinjauan dan adendum; baris lain memakai definisi kategori di bagian 3.

| Paket | Versi | Lisensi | Kategori | Asal | Sumber | Catatan |
| --- | --- | --- | --- | --- | --- | --- |
| @alloc/quick-lru | 5.2.0 | MIT | PERMISIF | root | node_modules |  |
| @antfu/install-pkg | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| @antv/hierarchy | 0.7.1 | MIT | PERMISIF | root | node_modules |  |
| @antv/infographic | 0.2.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/code-frame | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/compat-data | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/core | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/generator | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-annotate-as-pure | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-compilation-targets | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-create-class-features-plugin | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-globals | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-member-expression-to-functions | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-module-imports | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-module-transforms | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-optimise-call-expression | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-plugin-utils | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-replace-supers | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-skip-transparent-expression-wrappers | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-string-parser | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-validator-identifier | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helper-validator-option | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/helpers | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/parser | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/plugin-syntax-jsx | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/plugin-syntax-typescript | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/plugin-transform-modules-commonjs | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/plugin-transform-typescript | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/preset-typescript | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/runtime | 7.27.6 | MIT | PERMISIF | root | node_modules |  |
| @babel/template | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/traverse | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @babel/types | 7.29.7 | MIT | PERMISIF | root | node_modules |  |
| @braintree/sanitize-url | 7.1.2 | MIT | PERMISIF | root | node_modules |  |
| @chevrotain/cst-dts-gen | 11.0.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @chevrotain/gast | 11.0.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @chevrotain/regexp-to-ast | 11.0.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @chevrotain/types | 11.0.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @chevrotain/utils | 11.0.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @codemirror/autocomplete | 6.20.3 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/commands | 6.8.1 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/lang-css | 6.3.1 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/lang-html | 6.4.12 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/lang-javascript | 6.2.5 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/lang-markdown | 6.5.2 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/language | 6.12.4 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/lint | 6.9.7 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/search | 6.7.1 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/state | 6.7.1 | MIT | PERMISIF | root | node_modules |  |
| @codemirror/view | 6.43.8 | MIT | PERMISIF | root | node_modules |  |
| @date-fns/tz | 1.4.1 | MIT | PERMISIF | root | node_modules |  |
| @dnd-kit/accessibility | 3.1.1 | MIT | PERMISIF | root | node_modules |  |
| @dnd-kit/core | 6.3.1 | MIT | PERMISIF | root | node_modules |  |
| @dnd-kit/sortable | 10.0.0 | MIT | PERMISIF | root | node_modules |  |
| @dnd-kit/utilities | 3.2.2 | MIT | PERMISIF | root | node_modules |  |
| @dotenvx/dotenvx | 1.75.1 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| @dotenvx/primitives | 0.8.0 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| @drizzle-team/brocli | 0.10.2 | Apache-2.0 | PERMISIF | server | node_modules |  |
| @emnapi/core | 1.4.4 | MIT | PERMISIF | root | registry |  |
| @emnapi/runtime | 1.4.4 | MIT | PERMISIF | root | registry |  |
| @emnapi/wasi-threads | 1.0.3 | MIT | PERMISIF | root | registry |  |
| @epic-web/invariant | 1.0.0 | MIT | PERMISIF | server | node_modules |  |
| @esbuild-kit/core-utils | 3.3.2 | MIT | PERMISIF | server | node_modules |  |
| @esbuild-kit/esm-loader | 2.6.5 | MIT | PERMISIF | server | node_modules |  |
| @esbuild/aix-ppc64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/aix-ppc64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/android-arm | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/android-arm | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/android-arm | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/android-arm64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/android-arm64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/android-arm64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/android-x64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/android-x64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/android-x64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/darwin-arm64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/darwin-arm64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/darwin-arm64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/darwin-x64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/darwin-x64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/darwin-x64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/freebsd-arm64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/freebsd-arm64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/freebsd-arm64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/freebsd-x64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/freebsd-x64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/freebsd-x64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/linux-arm | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-arm | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-arm | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/linux-arm64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-arm64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-arm64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/linux-ia32 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-ia32 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-ia32 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/linux-loong64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-loong64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-loong64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/linux-mips64el | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-mips64el | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-mips64el | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/linux-ppc64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-ppc64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-ppc64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/linux-riscv64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-riscv64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-riscv64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/linux-s390x | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-s390x | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/linux-s390x | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/linux-x64 | 0.18.20 | MIT | PERMISIF | server | node_modules |  |
| @esbuild/linux-x64 | 0.25.12 | MIT | PERMISIF | server | node_modules |  |
| @esbuild/linux-x64 | 0.28.2 | MIT | PERMISIF | root+server | node_modules |  |
| @esbuild/netbsd-arm64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/netbsd-arm64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/netbsd-x64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/netbsd-x64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/netbsd-x64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/openbsd-arm64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/openbsd-arm64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/openbsd-x64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/openbsd-x64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/openbsd-x64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/openharmony-arm64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/openharmony-arm64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/sunos-x64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/sunos-x64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/sunos-x64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/win32-arm64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/win32-arm64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/win32-arm64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/win32-ia32 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/win32-ia32 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/win32-ia32 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @esbuild/win32-x64 | 0.18.20 | MIT | PERMISIF | server | registry |  |
| @esbuild/win32-x64 | 0.25.12 | MIT | PERMISIF | server | registry |  |
| @esbuild/win32-x64 | 0.28.2 | MIT | PERMISIF | root+server | registry |  |
| @eslint-community/eslint-utils | 4.7.0 | MIT | PERMISIF | root | node_modules |  |
| @eslint-community/regexpp | 4.12.1 | MIT | PERMISIF | root | node_modules |  |
| @eslint/eslintrc | 2.1.4 | MIT | PERMISIF | root | node_modules |  |
| @eslint/js | 8.57.1 | MIT | PERMISIF | root | node_modules |  |
| @fastify/ajv-compiler | 4.0.7 | MIT | PERMISIF | server | node_modules |  |
| @fastify/deepmerge | 3.2.4 | MIT | PERMISIF | server | node_modules |  |
| @fastify/error | 4.2.1 | MIT | PERMISIF | server | node_modules |  |
| @fastify/fast-json-stringify-compiler | 5.2.0 | MIT | PERMISIF | server | node_modules |  |
| @fastify/forwarded | 3.1.2 | MIT | PERMISIF | server | node_modules |  |
| @fastify/merge-json-schemas | 0.2.2 | MIT | PERMISIF | server | node_modules |  |
| @fastify/proxy-addr | 5.1.2 | MIT | PERMISIF | server | node_modules |  |
| @floating-ui/core | 1.7.2 | MIT | PERMISIF | root | node_modules |  |
| @floating-ui/dom | 1.7.2 | MIT | PERMISIF | root | node_modules |  |
| @floating-ui/react-dom | 2.1.4 | MIT | PERMISIF | root | node_modules |  |
| @floating-ui/utils | 0.2.10 | MIT | PERMISIF | root | node_modules |  |
| @formatjs/ecma402-abstract | 2.3.4 | MIT | PERMISIF | root | node_modules |  |
| @formatjs/fast-memoize | 2.2.7 | MIT | PERMISIF | root | node_modules |  |
| @formatjs/icu-messageformat-parser | 2.11.2 | MIT | PERMISIF | root | node_modules |  |
| @formatjs/icu-skeleton-parser | 1.8.14 | MIT | PERMISIF | root | node_modules |  |
| @formatjs/intl-localematcher | 0.5.10 | MIT | PERMISIF | root | node_modules |  |
| @formatjs/intl-localematcher | 0.6.1 | MIT | PERMISIF | root | node_modules |  |
| @headless-tree/core | 1.7.0 | MIT | PERMISIF | root | node_modules |  |
| @headless-tree/react | 1.7.0 | MIT | PERMISIF | root | node_modules |  |
| @hono/node-server | 1.19.14 | MIT | PERMISIF | root | node_modules |  |
| @humanwhocodes/config-array | 0.13.0 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @humanwhocodes/module-importer | 1.0.1 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @humanwhocodes/object-schema | 2.0.3 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| @iconify/types | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| @iconify/utils | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| @img/sharp-darwin-arm64 | 0.34.3 | Apache-2.0 | PERMISIF | root | registry |  |
| @img/sharp-darwin-x64 | 0.34.3 | Apache-2.0 | PERMISIF | root | registry |  |
| @img/sharp-libvips-darwin-arm64 | 1.2.0 | LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Biner libvips; lihat 4.1. |
| @img/sharp-libvips-darwin-x64 | 1.2.0 | LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Biner libvips; lihat 4.1. |
| @img/sharp-libvips-linux-arm | 1.2.0 | LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Biner libvips; lihat 4.1. |
| @img/sharp-libvips-linux-arm64 | 1.2.0 | LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Biner libvips; lihat 4.1. |
| @img/sharp-libvips-linux-ppc64 | 1.2.0 | LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Biner libvips; lihat 4.1. |
| @img/sharp-libvips-linux-s390x | 1.2.0 | LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Biner libvips; lihat 4.1. |
| @img/sharp-libvips-linux-x64 | 1.2.0 | LGPL-3.0-or-later | TINJAU_LGPL | root | node_modules | Biner libvips; lihat 4.1. |
| @img/sharp-libvips-linuxmusl-arm64 | 1.2.0 | LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Biner libvips; lihat 4.1. |
| @img/sharp-libvips-linuxmusl-x64 | 1.2.0 | LGPL-3.0-or-later | TINJAU_LGPL | root | node_modules | Biner libvips; lihat 4.1. |
| @img/sharp-linux-arm | 0.34.3 | Apache-2.0 | PERMISIF | root | registry |  |
| @img/sharp-linux-arm64 | 0.34.3 | Apache-2.0 | PERMISIF | root | registry |  |
| @img/sharp-linux-ppc64 | 0.34.3 | Apache-2.0 | PERMISIF | root | registry |  |
| @img/sharp-linux-s390x | 0.34.3 | Apache-2.0 | PERMISIF | root | registry |  |
| @img/sharp-linux-x64 | 0.34.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @img/sharp-linuxmusl-arm64 | 0.34.3 | Apache-2.0 | PERMISIF | root | registry |  |
| @img/sharp-linuxmusl-x64 | 0.34.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @img/sharp-wasm32 | 0.34.3 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | TINJAU_LGPL | root | registry | Paket platform sharp; lihat 4.1. |
| @img/sharp-win32-arm64 | 0.34.3 | Apache-2.0 AND LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Paket platform sharp; lihat 4.1. |
| @img/sharp-win32-ia32 | 0.34.3 | Apache-2.0 AND LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Paket platform sharp; lihat 4.1. |
| @img/sharp-win32-x64 | 0.34.3 | Apache-2.0 AND LGPL-3.0-or-later | TINJAU_LGPL | root | registry | Paket platform sharp; lihat 4.1. |
| @jitl/quickjs-ffi-types | 0.32.0 | MIT | PERMISIF | root | node_modules |  |
| @jitl/quickjs-singlefile-browser-release-sync | 0.32.0 | MIT | PERMISIF | root | node_modules |  |
| @jridgewell/gen-mapping | 0.3.12 | MIT | PERMISIF | root | node_modules |  |
| @jridgewell/remapping | 2.3.5 | MIT | PERMISIF | root | node_modules |  |
| @jridgewell/resolve-uri | 3.1.2 | MIT | PERMISIF | root | node_modules |  |
| @jridgewell/sourcemap-codec | 1.5.4 | MIT | PERMISIF | root | node_modules |  |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT | PERMISIF | root | node_modules |  |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT | PERMISIF | server | node_modules |  |
| @jridgewell/trace-mapping | 0.3.29 | MIT | PERMISIF | root | node_modules |  |
| @json-render/core | 0.21.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @json-render/react | 0.21.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @lezer/common | 1.5.2 | MIT | PERMISIF | root | node_modules |  |
| @lezer/css | 1.3.6 | MIT | PERMISIF | root | node_modules |  |
| @lezer/highlight | 1.2.1 | MIT | PERMISIF | root | node_modules |  |
| @lezer/html | 1.3.13 | MIT | PERMISIF | root | node_modules |  |
| @lezer/javascript | 1.5.4 | MIT | PERMISIF | root | node_modules |  |
| @lezer/lr | 1.4.2 | MIT | PERMISIF | root | node_modules |  |
| @lezer/markdown | 1.7.2 | MIT | PERMISIF | root | node_modules |  |
| @marijn/find-cluster-break | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| @mermaid-js/parser | 0.6.3 | MIT | PERMISIF | root | node_modules |  |
| @mixmark-io/domino | 2.2.0 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| @modelcontextprotocol/sdk | 1.29.0 | MIT | PERMISIF | root | node_modules |  |
| @mozilla/readability | 0.6.0 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @napi-rs/wasm-runtime | 0.2.12 | MIT | PERMISIF | root | registry |  |
| @next/env | 15.3.2 | MIT | PERMISIF | root | node_modules |  |
| @next/eslint-plugin-next | 15.0.3 | MIT | PERMISIF | root | node_modules |  |
| @next/swc-darwin-arm64 | 15.3.2 | MIT | PERMISIF | root | registry |  |
| @next/swc-darwin-x64 | 15.3.2 | MIT | PERMISIF | root | registry |  |
| @next/swc-linux-arm64-gnu | 15.3.2 | MIT | PERMISIF | root | registry |  |
| @next/swc-linux-arm64-musl | 15.3.2 | MIT | PERMISIF | root | registry |  |
| @next/swc-linux-x64-gnu | 15.3.2 | MIT | PERMISIF | root | node_modules |  |
| @next/swc-linux-x64-musl | 15.3.2 | MIT | PERMISIF | root | node_modules |  |
| @next/swc-win32-arm64-msvc | 15.3.2 | MIT | PERMISIF | root | registry |  |
| @next/swc-win32-x64-msvc | 15.3.2 | MIT | PERMISIF | root | registry |  |
| @nodelib/fs.scandir | 2.1.5 | MIT | PERMISIF | root | node_modules |  |
| @nodelib/fs.stat | 2.0.5 | MIT | PERMISIF | root | node_modules |  |
| @nodelib/fs.walk | 1.2.8 | MIT | PERMISIF | root | node_modules |  |
| @nolyfill/is-core-module | 1.0.39 | MIT | PERMISIF | root | node_modules |  |
| @notegen/plugin-api | 0.1.14 | MIT | PERMISIF | root | node_modules |  |
| @parcel/watcher | 2.5.6 | MIT | PERMISIF | root | node_modules |  |
| @parcel/watcher-android-arm64 | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-darwin-arm64 | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-darwin-x64 | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-freebsd-x64 | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-linux-arm-glibc | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-linux-arm-musl | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-linux-arm64-glibc | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-linux-arm64-musl | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-linux-x64-glibc | 2.5.6 | MIT | PERMISIF | root | node_modules |  |
| @parcel/watcher-linux-x64-musl | 2.5.6 | MIT | PERMISIF | root | node_modules |  |
| @parcel/watcher-win32-arm64 | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-win32-ia32 | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @parcel/watcher-win32-x64 | 2.5.6 | MIT | PERMISIF | root | registry |  |
| @phc/format | 1.0.0 | MIT | PERMISIF | server | node_modules |  |
| @pinojs/redact | 0.4.0 | MIT | PERMISIF | server | node_modules |  |
| @playwright/test | 1.65.1 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @popperjs/core | 2.11.8 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/number | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/primitive | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/primitive | 1.1.5 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-accessible-icon | 1.1.11 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-accordion | 1.2.16 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-alert-dialog | 1.1.19 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-arrow | 1.1.11 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-aspect-ratio | 1.1.11 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-avatar | 1.2.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-checkbox | 1.3.7 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-collapsible | 1.1.16 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-collection | 1.1.12 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-compose-refs | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-compose-refs | 1.1.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-context | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-context | 1.2.0 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-context-menu | 2.3.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-dialog | 1.1.14 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-dialog | 1.1.19 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-direction | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-dismissable-layer | 1.1.10 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-dismissable-layer | 1.1.15 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-dropdown-menu | 2.1.20 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-focus-guards | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-focus-guards | 1.1.4 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-focus-scope | 1.1.12 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-focus-scope | 1.1.7 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-form | 0.1.12 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-hover-card | 1.1.19 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-id | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-id | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-label | 2.1.11 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-menu | 2.1.20 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-menubar | 1.1.20 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-navigation-menu | 1.2.18 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-one-time-password-field | 0.1.12 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-password-toggle-field | 0.1.7 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-popover | 1.1.19 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-popper | 1.3.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-portal | 1.1.13 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-portal | 1.1.9 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-presence | 1.1.4 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-presence | 1.1.7 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-primitive | 2.1.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-primitive | 2.1.7 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-progress | 1.1.12 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-radio-group | 1.4.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-roving-focus | 1.1.15 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-scroll-area | 1.2.14 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-select | 2.3.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-separator | 1.1.11 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-slider | 1.4.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-slot | 1.2.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-slot | 1.3.0 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-switch | 1.3.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-tabs | 1.1.17 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-toast | 1.2.19 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-toggle | 1.1.14 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-toggle-group | 1.1.15 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-toolbar | 1.1.15 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-tooltip | 1.2.12 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-callback-ref | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-callback-ref | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-controllable-state | 1.2.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-controllable-state | 1.2.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-effect-event | 0.0.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-effect-event | 0.0.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-escape-keydown | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-escape-keydown | 1.1.3 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-is-hydrated | 0.1.1 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-layout-effect | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-layout-effect | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-previous | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-rect | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-use-size | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/react-visually-hidden | 1.2.7 | MIT | PERMISIF | root | node_modules |  |
| @radix-ui/rect | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| @reduxjs/toolkit | 2.12.0 | MIT | PERMISIF | root | node_modules |  |
| @remirror/core-constants | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| @rollup/rollup-android-arm-eabi | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-android-arm64 | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-android-x64 | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-darwin-arm64 | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-darwin-x64 | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-freebsd-arm64 | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-freebsd-x64 | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-arm-gnueabihf | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-arm-musleabihf | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-arm64-gnu | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-arm64-musl | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-loong64-gnu | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-loong64-musl | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-ppc64-gnu | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-ppc64-musl | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-riscv64-gnu | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-riscv64-musl | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-s390x-gnu | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-linux-x64-gnu | 4.68.3 | MIT | PERMISIF | root+server | node_modules |  |
| @rollup/rollup-linux-x64-musl | 4.68.3 | MIT | PERMISIF | root+server | node_modules |  |
| @rollup/rollup-openbsd-x64 | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-openharmony-arm64 | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-win32-arm64-msvc | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-win32-ia32-msvc | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-win32-x64-gnu | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rollup/rollup-win32-x64-msvc | 4.68.3 | MIT | PERMISIF | root+server | registry |  |
| @rtsao/scc | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| @rushstack/eslint-patch | 1.12.0 | MIT | PERMISIF | root | node_modules |  |
| @sec-ant/readable-stream | 0.4.1 | MIT | PERMISIF | root | node_modules |  |
| @sereneinserenade/tiptap-search-and-replace | 0.1.1 | MIT | PERMISIF | root | license-file-text | Teks berkas LICENSE; lihat bagian 5. |
| @shadcn/react | 0.2.1 | MIT | PERMISIF | root | node_modules |  |
| @shikijs/core | 3.23.0 | MIT | PERMISIF | root | node_modules |  |
| @shikijs/engine-javascript | 3.23.0 | MIT | PERMISIF | root | node_modules |  |
| @shikijs/engine-oniguruma | 3.23.0 | MIT | PERMISIF | root | node_modules |  |
| @shikijs/langs | 3.23.0 | MIT | PERMISIF | root | node_modules |  |
| @shikijs/themes | 3.23.0 | MIT | PERMISIF | root | node_modules |  |
| @shikijs/types | 3.23.0 | MIT | PERMISIF | root | node_modules |  |
| @shikijs/vscode-textmate | 10.0.2 | MIT | PERMISIF | root | node_modules |  |
| @sindresorhus/merge-streams | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| @standard-schema/spec | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| @standard-schema/utils | 0.3.0 | MIT | PERMISIF | root | node_modules |  |
| @streamdown/cjk | 1.0.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @streamdown/math | 1.0.2 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @swc/counter | 0.1.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @swc/helpers | 0.5.15 | Apache-2.0 | PERMISIF | root | node_modules |  |
| @tailwindcss/node | 4.3.3 | MIT | PERMISIF | root | node_modules |  |
| @tailwindcss/oxide | 4.3.3 | MIT | PERMISIF | root | node_modules |  |
| @tailwindcss/oxide-android-arm64 | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/oxide-darwin-arm64 | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/oxide-darwin-x64 | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/oxide-freebsd-x64 | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/oxide-linux-arm-gnueabihf | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/oxide-linux-arm64-gnu | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/oxide-linux-arm64-musl | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/oxide-linux-x64-gnu | 4.3.3 | MIT | PERMISIF | root | node_modules |  |
| @tailwindcss/oxide-linux-x64-musl | 4.3.3 | MIT | PERMISIF | root | node_modules |  |
| @tailwindcss/oxide-wasm32-wasi | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/oxide-win32-arm64-msvc | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/oxide-win32-x64-msvc | 4.3.3 | MIT | PERMISIF | root | registry |  |
| @tailwindcss/postcss | 4.3.3 | MIT | PERMISIF | root | node_modules |  |
| @tanstack/react-virtual | 3.14.9 | MIT | PERMISIF | root | node_modules |  |
| @tanstack/virtual-core | 3.17.7 | MIT | PERMISIF | root | node_modules |  |
| @tauri-apps/api | 2.0.1 | Apache-2.0 OR MIT | PERMISIF | root | node_modules |  |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT | PERMISIF | root | node_modules |  |
| @tauri-apps/cli | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | node_modules |  |
| @tauri-apps/cli-darwin-arm64 | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | registry |  |
| @tauri-apps/cli-darwin-x64 | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | registry |  |
| @tauri-apps/cli-linux-arm-gnueabihf | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | registry |  |
| @tauri-apps/cli-linux-arm64-gnu | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | registry |  |
| @tauri-apps/cli-linux-arm64-musl | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | registry |  |
| @tauri-apps/cli-linux-riscv64-gnu | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | registry |  |
| @tauri-apps/cli-linux-x64-gnu | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | node_modules |  |
| @tauri-apps/cli-linux-x64-musl | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | node_modules |  |
| @tauri-apps/cli-win32-arm64-msvc | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | registry |  |
| @tauri-apps/cli-win32-ia32-msvc | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | registry |  |
| @tauri-apps/cli-win32-x64-msvc | 2.11.3 | Apache-2.0 OR MIT | PERMISIF | root | registry |  |
| @tauri-apps/plugin-autostart | 2.4.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-clipboard-manager | 2.3.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-dialog | 2.3.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-fs | 2.4.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-global-shortcut | 2.3.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-http | 2.3.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-notification | 2.4.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-opener | 2.4.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-os | 2.3.2 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-process | 2.2.2 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-shell | 2.3.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-sql | 2.3.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-store | 2.3.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tauri-apps/plugin-updater | 2.9.0 | MIT OR Apache-2.0 | PERMISIF | root | node_modules |  |
| @tiptap/core | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-blockquote | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-bold | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-bubble-menu | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-bullet-list | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-character-count | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-code | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-code-block | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-collaboration | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-document | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-drag-handle | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-dropcursor | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-floating-menu | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-gapcursor | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-hard-break | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-heading | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-highlight | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-horizontal-rule | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-image | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-italic | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-link | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-list | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-list-item | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-list-keymap | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-node-range | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-ordered-list | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-paragraph | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-placeholder | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-strike | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-table | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-table-cell | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-table-header | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-table-row | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-task-item | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-task-list | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-text | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-text-align | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-typography | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extension-underline | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/extensions | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/markdown | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/pm | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/react | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/starter-kit | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/suggestion | 3.19.0 | MIT | PERMISIF | root | node_modules |  |
| @tiptap/y-tiptap | 3.0.2 | MIT | PERMISIF | root | node_modules |  |
| @ts-morph/common | 0.27.0 | MIT | PERMISIF | root | node_modules |  |
| @ts-morph/common | 0.29.0 | MIT | PERMISIF | root | node_modules |  |
| @tybys/wasm-util | 0.10.0 | MIT | PERMISIF | root | registry |  |
| @types/chai | 5.2.3 | MIT | PERMISIF | root+server | node_modules |  |
| @types/crypto-js | 4.2.2 | MIT | PERMISIF | root | node_modules |  |
| @types/d3 | 7.4.3 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-array | 3.2.2 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-axis | 3.0.6 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-brush | 3.0.6 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-chord | 3.0.6 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-color | 3.1.3 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-contour | 3.0.6 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-delaunay | 6.0.4 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-dispatch | 3.0.7 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-drag | 3.0.7 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-dsv | 3.0.7 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-ease | 3.0.2 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-fetch | 3.0.7 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-force | 3.0.10 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-format | 3.0.4 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-geo | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-hierarchy | 3.1.7 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-interpolate | 3.0.4 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-path | 3.1.1 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-polygon | 3.0.2 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-quadtree | 3.0.6 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-random | 3.0.3 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-scale | 4.0.9 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-scale-chromatic | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-selection | 3.0.11 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-shape | 3.1.8 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-time | 3.0.4 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-time-format | 4.0.3 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-timer | 3.0.2 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-transition | 3.0.9 | MIT | PERMISIF | root | node_modules |  |
| @types/d3-zoom | 3.0.8 | MIT | PERMISIF | root | node_modules |  |
| @types/debug | 4.1.13 | MIT | PERMISIF | root | node_modules |  |
| @types/deep-eql | 4.0.2 | MIT | PERMISIF | root+server | node_modules |  |
| @types/estree | 1.0.10 | MIT | PERMISIF | root+server | node_modules |  |
| @types/estree | 1.0.9 | MIT | PERMISIF | root | node_modules |  |
| @types/estree-jsx | 1.0.5 | MIT | PERMISIF | root | node_modules |  |
| @types/geojson | 7946.0.16 | MIT | PERMISIF | root | node_modules |  |
| @types/hast | 3.0.4 | MIT | PERMISIF | root | node_modules |  |
| @types/js-cookie | 2.2.7 | MIT | PERMISIF | root | node_modules |  |
| @types/json5 | 0.0.29 | MIT | PERMISIF | root | node_modules |  |
| @types/katex | 0.16.8 | MIT | PERMISIF | root | node_modules |  |
| @types/linkify-it | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| @types/lodash | 4.17.20 | MIT | PERMISIF | root | node_modules |  |
| @types/lodash-es | 4.17.12 | MIT | PERMISIF | root | node_modules |  |
| @types/markdown-it | 14.1.2 | MIT | PERMISIF | root | node_modules |  |
| @types/mdast | 4.0.4 | MIT | PERMISIF | root | node_modules |  |
| @types/mdurl | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| @types/ms | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| @types/node | 18.19.119 | MIT | PERMISIF | root | node_modules |  |
| @types/node | 20.19.8 | MIT | PERMISIF | root | node_modules |  |
| @types/node | 24.19.2 | MIT | PERMISIF | server | node_modules |  |
| @types/node-fetch | 2.6.12 | MIT | PERMISIF | root | node_modules |  |
| @types/pg | 8.23.1 | MIT | PERMISIF | server | node_modules |  |
| @types/react | 19.2.17 | MIT | PERMISIF | root | node_modules |  |
| @types/react-dom | 19.2.3 | MIT | PERMISIF | root | node_modules |  |
| @types/trusted-types | 2.0.7 | MIT | PERMISIF | root | node_modules |  |
| @types/turndown | 5.0.6 | MIT | PERMISIF | root | node_modules |  |
| @types/unist | 2.0.11 | MIT | PERMISIF | root | node_modules |  |
| @types/unist | 3.0.3 | MIT | PERMISIF | root | node_modules |  |
| @types/use-sync-external-store | 0.0.6 | MIT | PERMISIF | root | node_modules |  |
| @types/validate-npm-package-name | 4.0.2 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/eslint-plugin | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/parser | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/project-service | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/scope-manager | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/tsconfig-utils | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/type-utils | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/types | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/typescript-estree | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/utils | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @typescript-eslint/visitor-keys | 8.37.0 | MIT | PERMISIF | root | node_modules |  |
| @ungap/structured-clone | 1.3.0 | ISC | PERMISIF | root | node_modules |  |
| @unrs/resolver-binding-android-arm-eabi | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-android-arm64 | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-darwin-arm64 | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-darwin-x64 | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-freebsd-x64 | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-linux-arm-gnueabihf | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-linux-arm-musleabihf | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-linux-arm64-gnu | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-linux-arm64-musl | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-linux-ppc64-gnu | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-linux-riscv64-gnu | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-linux-riscv64-musl | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-linux-s390x-gnu | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-linux-x64-gnu | 1.11.1 | MIT | PERMISIF | root | node_modules |  |
| @unrs/resolver-binding-linux-x64-musl | 1.11.1 | MIT | PERMISIF | root | node_modules |  |
| @unrs/resolver-binding-wasm32-wasi | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-win32-arm64-msvc | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-win32-ia32-msvc | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @unrs/resolver-binding-win32-x64-msvc | 1.11.1 | MIT | PERMISIF | root | registry |  |
| @vitest/expect | 3.2.7 | MIT | PERMISIF | root+server | node_modules |  |
| @vitest/mocker | 3.2.7 | MIT | PERMISIF | root+server | node_modules |  |
| @vitest/pretty-format | 3.2.7 | MIT | PERMISIF | root+server | node_modules |  |
| @vitest/runner | 3.2.7 | MIT | PERMISIF | root+server | node_modules |  |
| @vitest/snapshot | 3.2.7 | MIT | PERMISIF | root+server | node_modules |  |
| @vitest/spy | 3.2.7 | MIT | PERMISIF | root+server | node_modules |  |
| @vitest/utils | 3.2.7 | MIT | PERMISIF | root+server | node_modules |  |
| @xobotyi/scrollbar-width | 1.9.5 | MIT | PERMISIF | root | node_modules |  |
| @xyflow/react | 12.11.2 | MIT | PERMISIF | root | node_modules |  |
| @xyflow/system | 0.0.79 | MIT | PERMISIF | root | node_modules |  |
| abort-controller | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| abstract-logging | 2.0.1 | MIT | PERMISIF | server | node_modules |  |
| accepts | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| acorn | 8.15.0 | MIT | PERMISIF | root | node_modules |  |
| acorn-jsx | 5.3.2 | MIT | PERMISIF | root | node_modules |  |
| advanced-cropper | 0.17.1 | MIT | PERMISIF | root | node_modules |  |
| agentkeepalive | 4.6.0 | MIT | PERMISIF | root | node_modules |  |
| ajv | 6.12.6 | MIT | PERMISIF | root | node_modules |  |
| ajv | 8.20.0 | MIT | PERMISIF | root+server | node_modules |  |
| ajv-formats | 2.1.1 | MIT | PERMISIF | root | node_modules |  |
| ajv-formats | 3.0.1 | MIT | PERMISIF | root+server | node_modules |  |
| ansi-colors | 4.1.3 | MIT | PERMISIF | root | node_modules |  |
| ansi-regex | 5.0.1 | MIT | PERMISIF | root | node_modules |  |
| ansi-regex | 6.2.2 | MIT | PERMISIF | root | node_modules |  |
| ansi-styles | 4.3.0 | MIT | PERMISIF | root | node_modules |  |
| argon2 | 0.45.2 | MIT | PERMISIF | server | node_modules |  |
| argparse | 2.0.1 | Python-2.0 | PERMISIF | root | node_modules |  |
| aria-hidden | 1.2.6 | MIT | PERMISIF | root | node_modules |  |
| aria-query | 5.3.2 | Apache-2.0 | PERMISIF | root | node_modules |  |
| array-buffer-byte-length | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| array-includes | 3.1.9 | MIT | PERMISIF | root | node_modules |  |
| array.prototype.findlast | 1.2.5 | MIT | PERMISIF | root | node_modules |  |
| array.prototype.findlastindex | 1.2.6 | MIT | PERMISIF | root | node_modules |  |
| array.prototype.flat | 1.3.3 | MIT | PERMISIF | root | node_modules |  |
| array.prototype.flatmap | 1.3.3 | MIT | PERMISIF | root | node_modules |  |
| array.prototype.tosorted | 1.1.4 | MIT | PERMISIF | root | node_modules |  |
| arraybuffer.prototype.slice | 1.0.4 | MIT | PERMISIF | root | node_modules |  |
| assertion-error | 2.0.1 | MIT | PERMISIF | root+server | node_modules |  |
| ast-types | 0.16.1 | MIT | PERMISIF | root | node_modules |  |
| ast-types-flow | 0.0.8 | MIT | PERMISIF | root | node_modules |  |
| async-function | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| asynckit | 0.4.0 | MIT | PERMISIF | root | node_modules |  |
| atob | 2.1.2 | (MIT OR Apache-2.0) | PERMISIF | root | node_modules |  |
| atomic-sleep | 1.0.0 | MIT | PERMISIF | server | node_modules |  |
| atomically | 1.7.0 | MIT | PERMISIF | root | node_modules |  |
| available-typed-arrays | 1.0.7 | MIT | PERMISIF | root | node_modules |  |
| avvio | 9.3.1 | MIT | PERMISIF | server | node_modules |  |
| axe-core | 4.10.3 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | node_modules | MPL via eslint-plugin-jsx-a11y; lihat 4.2. |
| axobject-query | 4.1.0 | Apache-2.0 | PERMISIF | root | node_modules |  |
| bail | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| balanced-match | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| balanced-match | 4.0.4 | MIT | PERMISIF | root | node_modules |  |
| baseline-browser-mapping | 2.10.43 | Apache-2.0 | PERMISIF | root | node_modules |  |
| body-parser | 2.3.0 | MIT | PERMISIF | root | node_modules |  |
| brace-expansion | 1.1.12 | MIT | PERMISIF | root | node_modules |  |
| brace-expansion | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| brace-expansion | 5.0.7 | MIT | PERMISIF | root | node_modules |  |
| braces | 3.0.3 | MIT | PERMISIF | root | node_modules |  |
| browserslist | 4.28.6 | MIT | PERMISIF | root | node_modules |  |
| buffer-from | 1.1.2 | MIT | PERMISIF | server | node_modules |  |
| bundle-name | 4.1.0 | MIT | PERMISIF | root | node_modules |  |
| busboy | 1.6.0 | MIT | PERMISIF | root | node_modules |  |
| bytes | 3.1.2 | MIT | PERMISIF | root | node_modules |  |
| cac | 6.7.14 | MIT | PERMISIF | root+server | node_modules |  |
| call-bind | 1.0.8 | MIT | PERMISIF | root | node_modules |  |
| call-bind-apply-helpers | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| call-bound | 1.0.4 | MIT | PERMISIF | root | node_modules |  |
| callsites | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| caniuse-lite | 1.0.30001727 | CC-BY-4.0 | PERMISIF | root | node_modules |  |
| caniuse-lite | 1.0.30001806 | CC-BY-4.0 | PERMISIF | root | node_modules |  |
| ccount | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| chai | 5.3.3 | MIT | PERMISIF | root+server | node_modules |  |
| chalk | 4.1.2 | MIT | PERMISIF | root | node_modules |  |
| chalk | 5.6.2 | MIT | PERMISIF | root | node_modules |  |
| character-entities | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| character-entities-html4 | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| character-entities-legacy | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| character-reference-invalid | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| check-error | 2.1.3 | MIT | PERMISIF | root+server | node_modules |  |
| chevrotain | 11.0.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| chevrotain-allstar | 0.3.1 | MIT | PERMISIF | root | node_modules |  |
| chokidar | 4.0.3 | MIT | PERMISIF | root | node_modules |  |
| class-variance-authority | 0.7.1 | Apache-2.0 | PERMISIF | root | node_modules |  |
| classcat | 5.0.5 | MIT | PERMISIF | root | node_modules |  |
| classnames | 2.5.1 | MIT | PERMISIF | root | node_modules |  |
| cli-cursor | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| cli-spinners | 2.9.2 | MIT | PERMISIF | root | node_modules |  |
| client-only | 0.0.1 | MIT | PERMISIF | root | node_modules |  |
| clsx | 2.1.1 | MIT | PERMISIF | root | node_modules |  |
| cmdk | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| code-block-writer | 13.0.3 | MIT | PERMISIF | root | node_modules |  |
| color | 4.2.3 | MIT | PERMISIF | root | node_modules |  |
| color-convert | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| color-name | 1.1.4 | MIT | PERMISIF | root | node_modules |  |
| color-string | 1.9.1 | MIT | PERMISIF | root | node_modules |  |
| combined-stream | 1.0.8 | MIT | PERMISIF | root | node_modules |  |
| comma-separated-tokens | 2.0.3 | MIT | PERMISIF | root | node_modules |  |
| commander | 11.1.0 | MIT | PERMISIF | root | node_modules |  |
| commander | 14.0.3 | MIT | PERMISIF | root | node_modules |  |
| commander | 7.2.0 | MIT | PERMISIF | root | node_modules |  |
| commander | 8.3.0 | MIT | PERMISIF | root | node_modules |  |
| concat-map | 0.0.1 | MIT | PERMISIF | root | node_modules |  |
| conf | 10.2.0 | MIT | PERMISIF | root | node_modules |  |
| confbox | 0.1.8 | MIT | PERMISIF | root | node_modules |  |
| content-disposition | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| content-type | 1.0.5 | MIT | PERMISIF | root | node_modules |  |
| content-type | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| convert-source-map | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| cookie | 0.7.2 | MIT | PERMISIF | root | node_modules |  |
| cookie | 2.0.2 | MIT | PERMISIF | server | node_modules |  |
| cookie-signature | 1.2.2 | MIT | PERMISIF | root | node_modules |  |
| copy-to-clipboard | 3.3.3 | MIT | PERMISIF | root | node_modules |  |
| cors | 2.8.6 | MIT | PERMISIF | root | node_modules |  |
| cose-base | 1.0.3 | MIT | PERMISIF | root | node_modules |  |
| cose-base | 2.2.0 | MIT | PERMISIF | root | node_modules |  |
| cosmiconfig | 9.0.2 | MIT | PERMISIF | root | node_modules |  |
| crelt | 1.0.6 | MIT | PERMISIF | root | node_modules |  |
| cropperjs | 1.6.2 | MIT | PERMISIF | root | node_modules |  |
| cross-env | 10.1.0 | MIT | PERMISIF | server | node_modules |  |
| cross-spawn | 7.0.6 | MIT | PERMISIF | root+server | node_modules |  |
| crypto-js | 4.2.0 | MIT | PERMISIF | root | node_modules |  |
| css | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| css-in-js-utils | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| css-tree | 1.1.3 | MIT | PERMISIF | root | node_modules |  |
| cssesc | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| csstype | 3.1.3 | MIT | PERMISIF | root | node_modules |  |
| csstype | 3.2.3 | MIT | PERMISIF | root | node_modules |  |
| culori | 4.0.2 | MIT | PERMISIF | root | node_modules |  |
| cytoscape | 3.33.1 | MIT | PERMISIF | root | node_modules |  |
| cytoscape-cose-bilkent | 4.1.0 | MIT | PERMISIF | root | node_modules |  |
| cytoscape-fcose | 2.2.0 | MIT | PERMISIF | root | node_modules |  |
| d3 | 7.9.0 | ISC | PERMISIF | root | node_modules |  |
| d3-array | 2.12.1 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| d3-array | 3.2.4 | ISC | PERMISIF | root | node_modules |  |
| d3-axis | 3.0.0 | ISC | PERMISIF | root | node_modules |  |
| d3-brush | 3.0.0 | ISC | PERMISIF | root | node_modules |  |
| d3-chord | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-color | 3.1.0 | ISC | PERMISIF | root | node_modules |  |
| d3-contour | 4.0.2 | ISC | PERMISIF | root | node_modules |  |
| d3-delaunay | 6.0.4 | ISC | PERMISIF | root | node_modules |  |
| d3-dispatch | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-drag | 3.0.0 | ISC | PERMISIF | root | node_modules |  |
| d3-dsv | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-ease | 3.0.1 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| d3-fetch | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-force | 3.0.0 | ISC | PERMISIF | root | node_modules |  |
| d3-format | 3.1.0 | ISC | PERMISIF | root | node_modules |  |
| d3-geo | 3.1.1 | ISC | PERMISIF | root | node_modules |  |
| d3-hierarchy | 3.1.2 | ISC | PERMISIF | root | node_modules |  |
| d3-interpolate | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-path | 1.0.9 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| d3-path | 3.1.0 | ISC | PERMISIF | root | node_modules |  |
| d3-polygon | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-quadtree | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-random | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-sankey | 0.12.3 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| d3-scale | 4.0.2 | ISC | PERMISIF | root | node_modules |  |
| d3-scale-chromatic | 3.1.0 | ISC | PERMISIF | root | node_modules |  |
| d3-selection | 3.0.0 | ISC | PERMISIF | root | node_modules |  |
| d3-shape | 1.3.7 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| d3-shape | 3.2.0 | ISC | PERMISIF | root | node_modules |  |
| d3-time | 3.1.0 | ISC | PERMISIF | root | node_modules |  |
| d3-time-format | 4.1.0 | ISC | PERMISIF | root | node_modules |  |
| d3-timer | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-transition | 3.0.1 | ISC | PERMISIF | root | node_modules |  |
| d3-zoom | 3.0.0 | ISC | PERMISIF | root | node_modules |  |
| dagre-d3-es | 7.0.13 | MIT | PERMISIF | root | node_modules |  |
| damerau-levenshtein | 1.0.8 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| data-view-buffer | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| data-view-byte-length | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| data-view-byte-offset | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| date-fns | 4.1.0 | MIT | PERMISIF | root | node_modules |  |
| dayjs | 1.11.13 | MIT | PERMISIF | root | node_modules |  |
| dayjs | 1.11.19 | MIT | PERMISIF | root | node_modules |  |
| debounce-fn | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| debug | 3.2.7 | MIT | PERMISIF | root | node_modules |  |
| debug | 4.4.1 | MIT | PERMISIF | root | node_modules |  |
| debug | 4.4.3 | MIT | PERMISIF | root+server | node_modules |  |
| decimal.js | 10.6.0 | MIT | PERMISIF | root | node_modules |  |
| decimal.js-light | 2.5.1 | MIT | PERMISIF | root | node_modules |  |
| decode-named-character-reference | 1.3.0 | MIT | PERMISIF | root | node_modules |  |
| decode-uri-component | 0.2.2 | MIT | PERMISIF | root | node_modules |  |
| dedent | 1.7.2 | MIT | PERMISIF | root | node_modules |  |
| deep-eql | 5.0.2 | MIT | PERMISIF | root+server | node_modules |  |
| deep-is | 0.1.4 | MIT | PERMISIF | root | node_modules |  |
| deepmerge | 4.3.1 | MIT | PERMISIF | root | node_modules |  |
| default-browser | 5.5.0 | MIT | PERMISIF | root | node_modules |  |
| default-browser-id | 5.0.1 | MIT | PERMISIF | root | node_modules |  |
| define-data-property | 1.1.4 | MIT | PERMISIF | root | node_modules |  |
| define-lazy-prop | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| define-lazy-prop | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| define-properties | 1.2.1 | MIT | PERMISIF | root | node_modules |  |
| delaunator | 5.0.1 | ISC | PERMISIF | root | node_modules |  |
| delayed-stream | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| depd | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| dequal | 2.0.3 | MIT | PERMISIF | root+server | node_modules |  |
| detect-libc | 2.0.4 | Apache-2.0 | PERMISIF | root | node_modules |  |
| detect-libc | 2.1.2 | Apache-2.0 | PERMISIF | root | node_modules |  |
| detect-node-es | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| devlop | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| diff | 8.0.4 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| doctrine | 2.1.0 | Apache-2.0 | PERMISIF | root | node_modules |  |
| doctrine | 3.0.0 | Apache-2.0 | PERMISIF | root | node_modules |  |
| dompurify | 3.3.1 | (MPL-2.0 OR Apache-2.0) | TINJAU_DWI_LISENSI | root | node_modules | Sisi Apache-2.0 dipakai; lihat 4.3. |
| dot-prop | 6.0.1 | MIT | PERMISIF | root | node_modules |  |
| dotenv | 17.4.2 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| drizzle-kit | 0.31.11 | MIT | PERMISIF | server | node_modules |  |
| drizzle-orm | 0.44.7 | Apache-2.0 | PERMISIF | server | node_modules |  |
| dunder-proto | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| ee-first | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| electron-to-chromium | 1.5.393 | ISC | PERMISIF | root | node_modules |  |
| elkjs | 0.12.0 | EPL-2.0 OR GPL-3.0-or-later | TINJAU_DWI_LISENSI | root | node_modules | Sisi GPL-3.0-or-later dipakai; lihat 4.3. |
| embla-carousel | 8.6.0 | MIT | PERMISIF | root | node_modules |  |
| embla-carousel-react | 8.6.0 | MIT | PERMISIF | root | node_modules |  |
| embla-carousel-reactive-utils | 8.6.0 | MIT | PERMISIF | root | node_modules |  |
| emoji-regex | 10.6.0 | MIT | PERMISIF | root | node_modules |  |
| emoji-regex | 9.2.2 | MIT | PERMISIF | root | node_modules |  |
| encodeurl | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| enhanced-resolve | 5.24.2 | MIT | PERMISIF | root | node_modules |  |
| enquirer | 2.4.1 | MIT | PERMISIF | root | node_modules |  |
| entities | 4.5.0 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| entities | 6.0.1 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| env-paths | 2.2.1 | MIT | PERMISIF | root | node_modules |  |
| error-ex | 1.3.4 | MIT | PERMISIF | root | node_modules |  |
| error-stack-parser | 2.1.4 | MIT | PERMISIF | root | node_modules |  |
| es-abstract | 1.24.0 | MIT | PERMISIF | root | node_modules |  |
| es-define-property | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| es-errors | 1.3.0 | MIT | PERMISIF | root | node_modules |  |
| es-iterator-helpers | 1.2.1 | MIT | PERMISIF | root | node_modules |  |
| es-module-lexer | 1.7.0 | MIT | PERMISIF | root+server | node_modules |  |
| es-object-atoms | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| es-set-tostringtag | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| es-shim-unscopables | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| es-to-primitive | 1.3.0 | MIT | PERMISIF | root | node_modules |  |
| es-toolkit | 1.50.0 | MIT | PERMISIF | root | node_modules |  |
| esbuild | 0.18.20 | MIT | PERMISIF | server | node_modules |  |
| esbuild | 0.25.12 | MIT | PERMISIF | server | node_modules |  |
| esbuild | 0.28.2 | MIT | PERMISIF | root+server | node_modules |  |
| escalade | 3.2.0 | MIT | PERMISIF | root | node_modules |  |
| escape-html | 1.0.3 | MIT | PERMISIF | root | node_modules |  |
| escape-string-regexp | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| escape-string-regexp | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| eslint | 8.57.1 | MIT | PERMISIF | root | node_modules |  |
| eslint-config-next | 15.0.3 | MIT | PERMISIF | root | node_modules |  |
| eslint-import-resolver-node | 0.3.9 | MIT | PERMISIF | root | node_modules |  |
| eslint-import-resolver-typescript | 3.10.1 | ISC | PERMISIF | root | node_modules |  |
| eslint-module-utils | 2.12.1 | MIT | PERMISIF | root | node_modules |  |
| eslint-plugin-import | 2.32.0 | MIT | PERMISIF | root | node_modules |  |
| eslint-plugin-jsx-a11y | 6.10.2 | MIT | PERMISIF | root | node_modules |  |
| eslint-plugin-react | 7.37.5 | MIT | PERMISIF | root | node_modules |  |
| eslint-plugin-react-hooks | 5.2.0 | MIT | PERMISIF | root | node_modules |  |
| eslint-scope | 7.2.2 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| eslint-visitor-keys | 3.4.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| eslint-visitor-keys | 4.2.1 | Apache-2.0 | PERMISIF | root | node_modules |  |
| espree | 9.6.1 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| esprima | 4.0.1 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| esquery | 1.6.0 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| esrecurse | 4.3.0 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| estraverse | 5.3.0 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| estree-util-is-identifier-name | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| estree-walker | 3.0.3 | MIT | PERMISIF | root+server | node_modules |  |
| esutils | 2.0.3 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| etag | 1.8.1 | MIT | PERMISIF | root | node_modules |  |
| event-target-shim | 5.0.1 | MIT | PERMISIF | root | node_modules |  |
| eventemitter3 | 5.0.1 | MIT | PERMISIF | root | node_modules |  |
| eventsource | 3.0.7 | MIT | PERMISIF | root | node_modules |  |
| eventsource-parser | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| execa | 5.1.1 | MIT | PERMISIF | root | node_modules |  |
| execa | 9.6.1 | MIT | PERMISIF | root | node_modules |  |
| expect-type | 1.4.0 | Apache-2.0 | PERMISIF | root+server | node_modules |  |
| express | 5.2.1 | MIT | PERMISIF | root | node_modules |  |
| express-rate-limit | 8.6.0 | MIT | PERMISIF | root | node_modules |  |
| extend | 3.0.2 | MIT | PERMISIF | root | node_modules |  |
| fast-decode-uri-component | 1.0.1 | MIT | PERMISIF | server | node_modules |  |
| fast-deep-equal | 3.1.3 | MIT | PERMISIF | root+server | node_modules |  |
| fast-equals | 5.4.0 | MIT | PERMISIF | root | node_modules |  |
| fast-glob | 3.3.1 | MIT | PERMISIF | root | node_modules |  |
| fast-glob | 3.3.3 | MIT | PERMISIF | root | node_modules |  |
| fast-json-stable-stringify | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| fast-json-stringify | 7.3.6 | MIT | PERMISIF | server | node_modules |  |
| fast-levenshtein | 2.0.6 | MIT | PERMISIF | root | node_modules |  |
| fast-querystring | 1.1.2 | MIT | PERMISIF | server | node_modules |  |
| fast-shallow-equal | 1.0.0 | Unlicense | PERMISIF | root | license-file-text | Teks berkas LICENSE; lihat bagian 5. |
| fast-uri | 3.1.3 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| fast-uri | 3.1.9 | BSD-3-Clause | PERMISIF | server | node_modules |  |
| fast-uri | 4.2.3 | BSD-3-Clause | PERMISIF | server | node_modules |  |
| fastest-stable-stringify | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| fastify | 5.12.8 | MIT | PERMISIF | server | node_modules |  |
| fastq | 1.19.1 | ISC | PERMISIF | root | node_modules |  |
| fastq | 1.20.3 | ISC | PERMISIF | server | node_modules |  |
| fdir | 6.4.6 | MIT | PERMISIF | root | node_modules |  |
| fdir | 6.5.0 | MIT | PERMISIF | root+server | node_modules |  |
| figures | 6.1.0 | MIT | PERMISIF | root | node_modules |  |
| file-entry-cache | 6.0.1 | MIT | PERMISIF | root | node_modules |  |
| fill-range | 7.1.1 | MIT | PERMISIF | root | node_modules |  |
| finalhandler | 2.1.1 | MIT | PERMISIF | root | node_modules |  |
| find-my-way | 9.10.0 | MIT | PERMISIF | server | node_modules |  |
| find-up | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| find-up | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| flat-cache | 3.2.0 | MIT | PERMISIF | root | node_modules |  |
| flatted | 3.3.3 | ISC | PERMISIF | root | node_modules |  |
| flru | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| for-each | 0.3.5 | MIT | PERMISIF | root | node_modules |  |
| form-data | 4.0.4 | MIT | PERMISIF | root | node_modules |  |
| form-data-encoder | 1.7.2 | MIT | PERMISIF | root | node_modules |  |
| formdata-node | 4.4.1 | MIT | PERMISIF | root | node_modules |  |
| forwarded | 0.2.0 | MIT | PERMISIF | root | node_modules |  |
| framer-motion | 12.26.2 | MIT | PERMISIF | root | node_modules |  |
| fresh | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| fs-extra | 11.3.6 | MIT | PERMISIF | root | node_modules |  |
| fs.realpath | 1.0.0 | ISC | PERMISIF | root | node_modules |  |
| fsevents | 2.3.3 | MIT | PERMISIF | root+server | registry |  |
| function-bind | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| function.prototype.name | 1.1.8 | MIT | PERMISIF | root | node_modules |  |
| functions-have-names | 1.2.3 | MIT | PERMISIF | root | node_modules |  |
| fuzzysort | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| gensync | 1.0.0-beta.2 | MIT | PERMISIF | root | node_modules |  |
| get-east-asian-width | 1.6.0 | MIT | PERMISIF | root | node_modules |  |
| get-intrinsic | 1.3.0 | MIT | PERMISIF | root | node_modules |  |
| get-nonce | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| get-own-enumerable-keys | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| get-proto | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| get-stream | 6.0.1 | MIT | PERMISIF | root | node_modules |  |
| get-stream | 9.0.1 | MIT | PERMISIF | root | node_modules |  |
| get-symbol-description | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| get-tsconfig | 4.10.1 | MIT | PERMISIF | root | node_modules |  |
| get-tsconfig | 4.14.3 | MIT | PERMISIF | server | node_modules |  |
| glob | 7.2.3 | ISC | PERMISIF | root | node_modules |  |
| glob-parent | 5.1.2 | ISC | PERMISIF | root | node_modules |  |
| glob-parent | 6.0.2 | ISC | PERMISIF | root | node_modules |  |
| globals | 13.24.0 | MIT | PERMISIF | root | node_modules |  |
| globalthis | 1.0.4 | MIT | PERMISIF | root | node_modules |  |
| globrex | 0.1.2 | MIT | PERMISIF | root | node_modules |  |
| gopd | 1.2.0 | MIT | PERMISIF | root | node_modules |  |
| graceful-fs | 4.2.11 | ISC | PERMISIF | root | node_modules |  |
| graphemer | 1.4.0 | MIT | PERMISIF | root | node_modules |  |
| hachure-fill | 0.5.2 | MIT | PERMISIF | root | node_modules |  |
| has-bigints | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| has-flag | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| has-property-descriptors | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| has-proto | 1.2.0 | MIT | PERMISIF | root | node_modules |  |
| has-symbols | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| has-tostringtag | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| hasown | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| hast-util-from-dom | 5.0.1 | ISC | PERMISIF | root | node_modules |  |
| hast-util-from-html | 2.0.3 | MIT | PERMISIF | root | node_modules |  |
| hast-util-from-html-isomorphic | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| hast-util-from-parse5 | 8.0.3 | MIT | PERMISIF | root | node_modules |  |
| hast-util-is-element | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| hast-util-parse-selector | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| hast-util-raw | 9.1.0 | MIT | PERMISIF | root | node_modules |  |
| hast-util-sanitize | 5.0.2 | MIT | PERMISIF | root | node_modules |  |
| hast-util-to-html | 9.0.5 | MIT | PERMISIF | root | node_modules |  |
| hast-util-to-jsx-runtime | 2.3.6 | MIT | PERMISIF | root | node_modules |  |
| hast-util-to-parse5 | 8.0.1 | MIT | PERMISIF | root | node_modules |  |
| hast-util-to-text | 4.0.2 | MIT | PERMISIF | root | node_modules |  |
| hast-util-whitespace | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| hastscript | 9.0.1 | MIT | PERMISIF | root | node_modules |  |
| highlight.js | 11.11.1 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| hono | 4.12.30 | MIT | PERMISIF | root | node_modules |  |
| hotkeys-js | 3.13.15 | MIT | PERMISIF | root | node_modules |  |
| html-to-image | 1.11.13 | MIT | PERMISIF | root | node_modules |  |
| html-url-attributes | 3.0.1 | MIT | PERMISIF | root | node_modules |  |
| html-void-elements | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| http-errors | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| human-signals | 2.1.0 | Apache-2.0 | PERMISIF | root | node_modules |  |
| human-signals | 8.0.1 | Apache-2.0 | PERMISIF | root | node_modules |  |
| humanize-ms | 1.2.1 | MIT | PERMISIF | root | node_modules |  |
| hyphenate-style-name | 1.1.0 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| iconv-lite | 0.6.3 | MIT | PERMISIF | root | node_modules |  |
| iconv-lite | 0.7.3 | MIT | PERMISIF | root | node_modules |  |
| ignore | 5.3.2 | MIT | PERMISIF | root | node_modules |  |
| ignore | 7.0.5 | MIT | PERMISIF | root | node_modules |  |
| immer | 10.2.0 | MIT | PERMISIF | root | node_modules |  |
| immer | 11.1.15 | MIT | PERMISIF | root | node_modules |  |
| immutable | 5.1.9 | MIT | PERMISIF | root | node_modules |  |
| import-fresh | 3.3.1 | MIT | PERMISIF | root | node_modules |  |
| imurmurhash | 0.1.4 | MIT | PERMISIF | root | node_modules |  |
| inflight | 1.0.6 | ISC | PERMISIF | root | node_modules |  |
| inherits | 2.0.4 | ISC | PERMISIF | root | node_modules |  |
| inline-style-parser | 0.2.7 | MIT | PERMISIF | root | node_modules |  |
| inline-style-prefixer | 7.0.1 | MIT | PERMISIF | root | node_modules |  |
| internal-slot | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| internmap | 1.0.1 | ISC | PERMISIF | root | node_modules |  |
| internmap | 2.0.3 | ISC | PERMISIF | root | node_modules |  |
| intl-messageformat | 10.7.16 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| ip-address | 10.2.0 | MIT | PERMISIF | root | node_modules |  |
| ipaddr.js | 1.9.1 | MIT | PERMISIF | root | node_modules |  |
| ipaddr.js | 2.5.0 | MIT | PERMISIF | server | node_modules |  |
| is-alphabetical | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| is-alphanumerical | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| is-array-buffer | 3.0.5 | MIT | PERMISIF | root | node_modules |  |
| is-arrayish | 0.2.1 | MIT | PERMISIF | root | node_modules |  |
| is-arrayish | 0.3.2 | MIT | PERMISIF | root | node_modules |  |
| is-async-function | 2.1.1 | MIT | PERMISIF | root | node_modules |  |
| is-bigint | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| is-boolean-object | 1.2.2 | MIT | PERMISIF | root | node_modules |  |
| is-bun-module | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| is-callable | 1.2.7 | MIT | PERMISIF | root | node_modules |  |
| is-core-module | 2.16.1 | MIT | PERMISIF | root | node_modules |  |
| is-data-view | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| is-date-object | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| is-decimal | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| is-docker | 2.2.1 | MIT | PERMISIF | root | node_modules |  |
| is-docker | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| is-extglob | 2.1.1 | MIT | PERMISIF | root | node_modules |  |
| is-finalizationregistry | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| is-generator-function | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| is-glob | 4.0.3 | MIT | PERMISIF | root | node_modules |  |
| is-hexadecimal | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| is-in-ssh | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| is-inside-container | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| is-interactive | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| is-map | 2.0.3 | MIT | PERMISIF | root | node_modules |  |
| is-negative-zero | 2.0.3 | MIT | PERMISIF | root | node_modules |  |
| is-number | 7.0.0 | MIT | PERMISIF | root | node_modules |  |
| is-number-object | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| is-obj | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| is-obj | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| is-path-inside | 3.0.3 | MIT | PERMISIF | root | node_modules |  |
| is-plain-obj | 4.1.0 | MIT | PERMISIF | root | node_modules |  |
| is-promise | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| is-regex | 1.2.1 | MIT | PERMISIF | root | node_modules |  |
| is-regexp | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| is-set | 2.0.3 | MIT | PERMISIF | root | node_modules |  |
| is-shared-array-buffer | 1.0.4 | MIT | PERMISIF | root | node_modules |  |
| is-stream | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| is-stream | 4.0.1 | MIT | PERMISIF | root | node_modules |  |
| is-string | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| is-symbol | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| is-typed-array | 1.1.15 | MIT | PERMISIF | root | node_modules |  |
| is-unicode-supported | 1.3.0 | MIT | PERMISIF | root | node_modules |  |
| is-unicode-supported | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| is-weakmap | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| is-weakref | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| is-weakset | 2.0.4 | MIT | PERMISIF | root | node_modules |  |
| is-wsl | 2.2.0 | MIT | PERMISIF | root | node_modules |  |
| is-wsl | 3.1.1 | MIT | PERMISIF | root | node_modules |  |
| isarray | 2.0.5 | MIT | PERMISIF | root | node_modules |  |
| isexe | 2.0.0 | ISC | PERMISIF | root+server | node_modules |  |
| isexe | 3.1.5 | BlueOak-1.0.0 | PERMISIF | root | node_modules |  |
| isomorphic.js | 0.2.5 | MIT | PERMISIF | root | node_modules |  |
| iterator.prototype | 1.1.5 | MIT | PERMISIF | root | node_modules |  |
| jiti | 2.7.0 | MIT | PERMISIF | root | node_modules |  |
| jose | 6.2.3 | MIT | PERMISIF | root | node_modules |  |
| js-cookie | 2.2.1 | MIT | PERMISIF | root | node_modules |  |
| js-tokens | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| js-tokens | 9.0.1 | MIT | PERMISIF | root+server | node_modules |  |
| js-yaml | 4.1.0 | MIT | PERMISIF | root | node_modules |  |
| jsesc | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| json-buffer | 3.0.1 | MIT | PERMISIF | root | node_modules |  |
| json-parse-even-better-errors | 2.3.1 | MIT | PERMISIF | root | node_modules |  |
| json-schema-ref-resolver | 3.0.1 | MIT | PERMISIF | server | node_modules |  |
| json-schema-traverse | 0.4.1 | MIT | PERMISIF | root | node_modules |  |
| json-schema-traverse | 1.0.0 | MIT | PERMISIF | root+server | node_modules |  |
| json-schema-typed | 7.0.3 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| json-schema-typed | 8.0.2 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| json-stable-stringify-without-jsonify | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| json5 | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| json5 | 2.2.3 | MIT | PERMISIF | root | node_modules |  |
| jsonfile | 6.2.1 | MIT | PERMISIF | root | node_modules |  |
| jsx-ast-utils | 3.3.5 | MIT | PERMISIF | root | node_modules |  |
| katex | 0.16.28 | MIT | PERMISIF | root | node_modules |  |
| keyv | 4.5.4 | MIT | PERMISIF | root | node_modules |  |
| khroma | 2.1.0 | MIT | PERMISIF | root | license-file-text | Teks berkas LICENSE; lihat bagian 5. |
| kleur | 3.0.3 | MIT | PERMISIF | root | node_modules |  |
| kleur | 4.1.5 | MIT | PERMISIF | root | node_modules |  |
| langium | 3.3.1 | MIT | PERMISIF | root | node_modules |  |
| language-subtag-registry | 0.3.23 | CC0-1.0 | PERMISIF | root | node_modules |  |
| language-tags | 1.0.9 | MIT | PERMISIF | root | node_modules |  |
| layout-base | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| layout-base | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| levn | 0.4.1 | MIT | PERMISIF | root | node_modules |  |
| lib0 | 0.2.117 | MIT | PERMISIF | root | node_modules |  |
| light-my-request | 6.8.0 | BSD-3-Clause | PERMISIF | server | node_modules |  |
| lightningcss | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | node_modules | MPL, waktu build; lihat 4.2. |
| lightningcss-android-arm64 | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | registry | MPL, biner platform; lihat 4.2. |
| lightningcss-darwin-arm64 | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | registry | MPL, biner platform; lihat 4.2. |
| lightningcss-darwin-x64 | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | registry | MPL, biner platform; lihat 4.2. |
| lightningcss-freebsd-x64 | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | registry | MPL, biner platform; lihat 4.2. |
| lightningcss-linux-arm-gnueabihf | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | registry | MPL, biner platform; lihat 4.2. |
| lightningcss-linux-arm64-gnu | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | registry | MPL, biner platform; lihat 4.2. |
| lightningcss-linux-arm64-musl | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | registry | MPL, biner platform; lihat 4.2. |
| lightningcss-linux-x64-gnu | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | node_modules | MPL, biner platform; lihat 4.2. |
| lightningcss-linux-x64-musl | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | node_modules | MPL, biner platform; lihat 4.2. |
| lightningcss-win32-arm64-msvc | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | registry | MPL, biner platform; lihat 4.2. |
| lightningcss-win32-x64-msvc | 1.32.0 | MPL-2.0 | TINJAU_COPYLEFT_LEMAH | root | registry | MPL, biner platform; lihat 4.2. |
| lines-and-columns | 1.2.4 | MIT | PERMISIF | root | node_modules |  |
| linkify-it | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| linkifyjs | 4.3.2 | MIT | PERMISIF | root | node_modules |  |
| locate-path | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| locate-path | 6.0.0 | MIT | PERMISIF | root | node_modules |  |
| lodash | 4.17.21 | MIT | PERMISIF | root | node_modules |  |
| lodash-es | 4.17.21 | MIT | PERMISIF | root | node_modules |  |
| lodash.debounce | 4.0.8 | MIT | PERMISIF | root | node_modules |  |
| lodash.merge | 4.6.2 | MIT | PERMISIF | root | node_modules |  |
| log-symbols | 6.0.0 | MIT | PERMISIF | root | node_modules |  |
| longest-streak | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| loose-envify | 1.4.0 | MIT | PERMISIF | root | node_modules |  |
| loupe | 3.2.1 | MIT | PERMISIF | root+server | node_modules |  |
| lowlight | 3.3.0 | MIT | PERMISIF | root | node_modules |  |
| lru-cache | 5.1.1 | ISC | PERMISIF | root | node_modules |  |
| lucide-react | 1.25.0 | ISC | PERMISIF | root | node_modules |  |
| magic-string | 0.30.21 | MIT | PERMISIF | root+server | node_modules |  |
| markdown-it | 14.1.0 | MIT | PERMISIF | root | node_modules |  |
| markdown-table | 3.0.4 | MIT | PERMISIF | root | node_modules |  |
| marked | 16.4.2 | MIT | PERMISIF | root | node_modules |  |
| marked | 17.0.1 | MIT | PERMISIF | root | node_modules |  |
| marked-cjk-friendly | 0.1.3 | MIT | PERMISIF | root | node_modules |  |
| math-intrinsics | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-find-and-replace | 3.0.2 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-from-markdown | 2.0.3 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-gfm | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-gfm-footnote | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-gfm-strikethrough | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-gfm-table | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-math | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-mdx-expression | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-mdx-jsx | 3.2.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-mdxjs-esm | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-phrasing | 4.1.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-to-hast | 13.2.1 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-to-markdown | 2.1.2 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-to-markdown-cjk-friendly | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-to-markdown-cjk-friendly-gfm-strikethrough | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| mdast-util-to-string | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| mdn-data | 2.0.14 | CC0-1.0 | PERMISIF | root | node_modules |  |
| mdurl | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| measury | 0.1.4 | MIT | PERMISIF | root | node_modules |  |
| media-typer | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| merge-descriptors | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| merge-stream | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| merge2 | 1.4.1 | MIT | PERMISIF | root | node_modules |  |
| mermaid | 11.12.2 | MIT | PERMISIF | root | node_modules |  |
| micromark | 4.0.2 | MIT | PERMISIF | root | node_modules |  |
| micromark-core-commonmark | 2.0.3 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-cjk-friendly | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-cjk-friendly-gfm-strikethrough | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-cjk-friendly-util | 3.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-gfm | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-gfm-footnote | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-gfm-table | 2.1.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| micromark-extension-math | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| micromark-factory-destination | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-factory-label | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-factory-space | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-factory-title | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-factory-whitespace | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-character | 2.1.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-chunked | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-classify-character | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-combine-extensions | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-decode-string | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-encode | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-html-tag-name | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-normalize-identifier | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-resolve-all | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-sanitize-uri | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-subtokenize | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-symbol | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| micromark-util-types | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| micromatch | 4.0.8 | MIT | PERMISIF | root | node_modules |  |
| mime-db | 1.52.0 | MIT | PERMISIF | root | node_modules |  |
| mime-db | 1.54.0 | MIT | PERMISIF | root | node_modules |  |
| mime-types | 2.1.35 | MIT | PERMISIF | root | node_modules |  |
| mime-types | 3.0.2 | MIT | PERMISIF | root | node_modules |  |
| mimic-fn | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| mimic-fn | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| mimic-function | 5.0.1 | MIT | PERMISIF | root | node_modules |  |
| minimatch | 10.2.5 | BlueOak-1.0.0 | PERMISIF | root | node_modules |  |
| minimatch | 3.1.2 | ISC | PERMISIF | root | node_modules |  |
| minimatch | 9.0.5 | ISC | PERMISIF | root | node_modules |  |
| minimist | 1.2.8 | MIT | PERMISIF | root | node_modules |  |
| mitt | 3.0.1 | MIT | PERMISIF | root | node_modules |  |
| mlly | 1.8.0 | MIT | PERMISIF | root | node_modules |  |
| motion-dom | 12.26.2 | MIT | PERMISIF | root | node_modules |  |
| motion-utils | 12.24.10 | MIT | PERMISIF | root | node_modules |  |
| ms | 2.1.3 | MIT | PERMISIF | root+server | node_modules |  |
| nano-css | 5.6.2 | Unlicense | PERMISIF | root | node_modules |  |
| nanoid | 3.3.11 | MIT | PERMISIF | root | node_modules |  |
| nanoid | 3.3.16 | MIT | PERMISIF | root | node_modules |  |
| nanoid | 3.3.20 | MIT | PERMISIF | server | node_modules |  |
| napi-postinstall | 0.3.0 | MIT | PERMISIF | root | node_modules |  |
| natural-compare | 1.4.0 | MIT | PERMISIF | root | node_modules |  |
| negotiator | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| next | 15.3.2 | MIT | PERMISIF | root | node_modules |  |
| next-intl | 3.26.5 | MIT | PERMISIF | root | node_modules |  |
| next-themes | 0.4.6 | MIT | PERMISIF | root | node_modules |  |
| node-addon-api | 7.1.1 | MIT | PERMISIF | root | node_modules |  |
| node-addon-api | 8.9.2 | MIT | PERMISIF | server | node_modules |  |
| node-domexception | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| node-fetch | 2.7.0 | MIT | PERMISIF | root | node_modules |  |
| node-gyp-build | 4.8.4 | MIT | PERMISIF | server | node_modules |  |
| node-releases | 2.0.51 | MIT | PERMISIF | root | node_modules |  |
| npm-run-path | 4.0.1 | MIT | PERMISIF | root | node_modules |  |
| npm-run-path | 6.0.0 | MIT | PERMISIF | root | node_modules |  |
| object-assign | 4.1.1 | MIT | PERMISIF | root | node_modules |  |
| object-inspect | 1.13.4 | MIT | PERMISIF | root | node_modules |  |
| object-keys | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| object-treeify | 1.1.33 | MIT | PERMISIF | root | node_modules |  |
| object.assign | 4.1.7 | MIT | PERMISIF | root | node_modules |  |
| object.entries | 1.1.9 | MIT | PERMISIF | root | node_modules |  |
| object.fromentries | 2.0.8 | MIT | PERMISIF | root | node_modules |  |
| object.groupby | 1.0.3 | MIT | PERMISIF | root | node_modules |  |
| object.values | 1.2.1 | MIT | PERMISIF | root | node_modules |  |
| on-exit-leak-free | 2.1.2 | MIT | PERMISIF | server | node_modules |  |
| on-finished | 2.4.1 | MIT | PERMISIF | root | node_modules |  |
| once | 1.4.0 | ISC | PERMISIF | root | node_modules |  |
| onetime | 5.1.2 | MIT | PERMISIF | root | node_modules |  |
| onetime | 7.0.0 | MIT | PERMISIF | root | node_modules |  |
| oniguruma-parser | 0.12.2 | MIT | PERMISIF | root | node_modules |  |
| oniguruma-to-es | 4.3.6 | MIT | PERMISIF | root | node_modules |  |
| open | 11.0.0 | MIT | PERMISIF | root | node_modules |  |
| open | 8.4.2 | MIT | PERMISIF | root | node_modules |  |
| openai | 4.104.0 | Apache-2.0 | PERMISIF | root | node_modules |  |
| optionator | 0.9.4 | MIT | PERMISIF | root | node_modules |  |
| ora | 8.2.0 | MIT | PERMISIF | root | node_modules |  |
| orderedmap | 2.1.1 | MIT | PERMISIF | root | node_modules |  |
| own-keys | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| p-limit | 2.3.0 | MIT | PERMISIF | root | node_modules |  |
| p-limit | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| p-locate | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| p-locate | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| p-try | 2.2.0 | MIT | PERMISIF | root | node_modules |  |
| package-manager-detector | 1.6.0 | MIT | PERMISIF | root | node_modules |  |
| parent-module | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| parse-entities | 4.0.2 | MIT | PERMISIF | root | node_modules |  |
| parse-json | 5.2.0 | MIT | PERMISIF | root | node_modules |  |
| parse-ms | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| parse5 | 7.3.0 | MIT | PERMISIF | root | node_modules |  |
| parseurl | 1.3.3 | MIT | PERMISIF | root | node_modules |  |
| path-browserify | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| path-data-parser | 0.1.0 | MIT | PERMISIF | root | node_modules |  |
| path-exists | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| path-exists | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| path-is-absolute | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| path-key | 3.1.1 | MIT | PERMISIF | root+server | node_modules |  |
| path-key | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| path-parse | 1.0.7 | MIT | PERMISIF | root | node_modules |  |
| path-to-regexp | 8.4.2 | MIT | PERMISIF | root | node_modules |  |
| pathe | 2.0.3 | MIT | PERMISIF | root+server | node_modules |  |
| pathval | 2.0.1 | MIT | PERMISIF | root+server | node_modules |  |
| perfect-freehand | 1.2.3 | MIT | PERMISIF | root | node_modules |  |
| pg | 8.23.1 | MIT | PERMISIF | server | node_modules |  |
| pg-cloudflare | 1.4.1 | MIT | PERMISIF | server | node_modules |  |
| pg-connection-string | 2.14.1 | MIT | PERMISIF | server | node_modules |  |
| pg-int8 | 1.0.1 | ISC | PERMISIF | server | node_modules |  |
| pg-pool | 3.14.0 | MIT | PERMISIF | server | node_modules |  |
| pg-protocol | 1.16.1 | MIT | PERMISIF | server | node_modules |  |
| pg-types | 2.2.0 | MIT | PERMISIF | server | node_modules |  |
| pgpass | 1.0.5 | MIT | PERMISIF | server | node_modules |  |
| picocolors | 1.1.1 | ISC | PERMISIF | root+server | node_modules |  |
| picomatch | 2.3.1 | MIT | PERMISIF | root | node_modules |  |
| picomatch | 4.0.3 | MIT | PERMISIF | root | node_modules |  |
| picomatch | 4.0.5 | MIT | PERMISIF | root | node_modules |  |
| picomatch | 4.0.7 | MIT | PERMISIF | server | node_modules |  |
| pino | 10.4.0 | MIT | PERMISIF | server | node_modules |  |
| pino-abstract-transport | 3.0.0 | MIT | PERMISIF | server | node_modules |  |
| pino-std-serializers | 7.1.0 | MIT | PERMISIF | server | node_modules |  |
| pkce-challenge | 5.0.1 | MIT | PERMISIF | root | node_modules |  |
| pkg-types | 1.3.1 | MIT | PERMISIF | root | node_modules |  |
| pkg-up | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| playwright | 1.65.1 | Apache-2.0 | PERMISIF | root | node_modules |  |
| playwright-core | 1.65.1 | Apache-2.0 | PERMISIF | root | node_modules |  |
| points-on-curve | 0.2.0 | MIT | PERMISIF | root | node_modules |  |
| points-on-path | 0.2.1 | MIT | PERMISIF | root | node_modules |  |
| possible-typed-array-names | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| postcss | 8.4.31 | MIT | PERMISIF | root | node_modules |  |
| postcss | 8.5.19 | MIT | PERMISIF | root | node_modules |  |
| postcss | 8.5.33 | MIT | PERMISIF | server | node_modules |  |
| postcss | 8.5.6 | MIT | PERMISIF | root | node_modules |  |
| postcss-selector-parser | 7.1.4 | MIT | PERMISIF | root | node_modules |  |
| postgres | 3.4.9 | Unlicense | PERMISIF | server | node_modules |  |
| postgres-array | 2.0.0 | MIT | PERMISIF | server | node_modules |  |
| postgres-bytea | 1.0.1 | MIT | PERMISIF | server | node_modules |  |
| postgres-date | 1.0.7 | MIT | PERMISIF | server | node_modules |  |
| postgres-interval | 1.2.0 | MIT | PERMISIF | server | node_modules |  |
| powershell-utils | 0.1.0 | MIT | PERMISIF | root | node_modules |  |
| prelude-ls | 1.2.1 | MIT | PERMISIF | root | node_modules |  |
| pretty-ms | 9.3.0 | MIT | PERMISIF | root | node_modules |  |
| process-warning | 5.1.1 | MIT | PERMISIF | server | node_modules |  |
| prompts | 2.4.2 | MIT | PERMISIF | root | node_modules |  |
| prop-types | 15.8.1 | MIT | PERMISIF | root | node_modules |  |
| property-information | 7.2.0 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-changeset | 2.3.1 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-collab | 1.3.1 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-commands | 1.7.1 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-dropcursor | 1.8.2 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-gapcursor | 1.4.0 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-history | 1.5.0 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-inputrules | 1.5.1 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-keymap | 1.2.3 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-markdown | 1.13.4 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-menu | 1.2.5 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-model | 1.25.4 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-schema-basic | 1.2.4 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-schema-list | 1.5.1 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-state | 1.4.4 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-tables | 1.8.5 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-trailing-node | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-transform | 1.11.0 | MIT | PERMISIF | root | node_modules |  |
| prosemirror-view | 1.41.5 | MIT | PERMISIF | root | node_modules |  |
| proxy-addr | 2.0.7 | MIT | PERMISIF | root | node_modules |  |
| punycode | 2.3.1 | MIT | PERMISIF | root | node_modules |  |
| punycode.js | 2.3.1 | MIT | PERMISIF | root | node_modules |  |
| qs | 6.15.3 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| queue-microtask | 1.2.3 | MIT | PERMISIF | root | node_modules |  |
| quick-format-unescaped | 4.0.4 | MIT | PERMISIF | server | node_modules |  |
| quickjs-emscripten-core | 0.32.0 | MIT | PERMISIF | root | node_modules |  |
| radix-ui | 1.6.2 | MIT | PERMISIF | root | node_modules |  |
| range-parser | 1.3.0 | MIT | PERMISIF | root | node_modules |  |
| raw-body | 3.0.2 | MIT | PERMISIF | root | node_modules |  |
| react | 19.2.3 | MIT | PERMISIF | root | node_modules |  |
| react-advanced-cropper | 0.20.1 | MIT | PERMISIF | root | node_modules |  |
| react-day-picker | 10.0.1 | MIT | PERMISIF | root | node_modules |  |
| react-dom | 19.2.3 | MIT | PERMISIF | root | node_modules |  |
| react-hook-form | 7.60.0 | MIT | PERMISIF | root | node_modules |  |
| react-is | 16.13.1 | MIT | PERMISIF | root | node_modules |  |
| react-photo-view | 1.2.7 | Apache-2.0 | PERMISIF | root | node_modules |  |
| react-redux | 9.3.0 | MIT | PERMISIF | root | node_modules |  |
| react-remove-scroll | 2.7.1 | MIT | PERMISIF | root | node_modules |  |
| react-remove-scroll | 2.7.2 | MIT | PERMISIF | root | node_modules |  |
| react-remove-scroll-bar | 2.3.8 | MIT | PERMISIF | root | node_modules |  |
| react-resizable-panels | 4.12.2 | MIT | PERMISIF | root | node_modules |  |
| react-style-singleton | 2.2.3 | MIT | PERMISIF | root | node_modules |  |
| react-universal-interface | 0.6.2 | Unlicense | PERMISIF | root | license-file-text | Teks berkas LICENSE; lihat bagian 5. |
| react-use | 17.6.0 | Unlicense | PERMISIF | root | node_modules |  |
| readdirp | 4.1.2 | MIT | PERMISIF | root | node_modules |  |
| real-require | 1.0.0 | MIT | PERMISIF | server | node_modules |  |
| recast | 0.23.12 | MIT | PERMISIF | root | node_modules |  |
| recharts | 3.8.0 | MIT | PERMISIF | root | node_modules |  |
| redux | 5.0.1 | MIT | PERMISIF | root | node_modules |  |
| redux-thunk | 3.1.0 | MIT | PERMISIF | root | node_modules |  |
| reflect.getprototypeof | 1.0.10 | MIT | PERMISIF | root | node_modules |  |
| regex | 6.1.0 | MIT | PERMISIF | root | node_modules |  |
| regex-recursion | 6.0.2 | MIT | PERMISIF | root | node_modules |  |
| regex-utilities | 2.3.0 | MIT | PERMISIF | root | node_modules |  |
| regexp.prototype.flags | 1.5.4 | MIT | PERMISIF | root | node_modules |  |
| rehype-harden | 1.1.8 | MIT | PERMISIF | root | node_modules |  |
| rehype-katex | 7.0.1 | MIT | PERMISIF | root | node_modules |  |
| rehype-raw | 7.0.0 | MIT | PERMISIF | root | node_modules |  |
| rehype-sanitize | 6.0.0 | MIT | PERMISIF | root | node_modules |  |
| remark-cjk-friendly | 2.3.1 | MIT | PERMISIF | root | node_modules |  |
| remark-cjk-friendly-gfm-strikethrough | 2.3.1 | MIT | PERMISIF | root | node_modules |  |
| remark-gfm | 4.0.1 | MIT | PERMISIF | root | node_modules |  |
| remark-math | 6.0.0 | MIT | PERMISIF | root | node_modules |  |
| remark-parse | 11.0.0 | MIT | PERMISIF | root | node_modules |  |
| remark-rehype | 11.1.2 | MIT | PERMISIF | root | node_modules |  |
| remark-stringify | 11.0.0 | MIT | PERMISIF | root | node_modules |  |
| remend | 1.3.0 | Apache-2.0 | PERMISIF | root | node_modules |  |
| require-from-string | 2.0.2 | MIT | PERMISIF | root+server | node_modules |  |
| reselect | 5.1.1 | MIT | PERMISIF | root | node_modules |  |
| resize-observer-polyfill | 1.5.1 | MIT | PERMISIF | root | node_modules |  |
| resolve | 1.22.10 | MIT | PERMISIF | root | node_modules |  |
| resolve | 2.0.0-next.5 | MIT | PERMISIF | root | node_modules |  |
| resolve-from | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| resolve-pkg-maps | 1.0.0 | MIT | PERMISIF | root+server | node_modules |  |
| restore-cursor | 5.1.0 | MIT | PERMISIF | root | node_modules |  |
| ret | 0.5.1 | MIT | PERMISIF | server | node_modules |  |
| reusify | 1.1.0 | MIT | PERMISIF | root+server | node_modules |  |
| rfdc | 1.4.1 | MIT | PERMISIF | server | node_modules |  |
| rimraf | 3.0.2 | ISC | PERMISIF | root | node_modules |  |
| robust-predicates | 3.0.2 | Unlicense | PERMISIF | root | node_modules |  |
| rollup | 4.68.3 | MIT | PERMISIF | root+server | node_modules |  |
| rope-sequence | 1.3.4 | MIT | PERMISIF | root | node_modules |  |
| roughjs | 4.6.6 | MIT | PERMISIF | root | node_modules |  |
| round-polygon | 0.6.7 | MIT | PERMISIF | root | node_modules |  |
| router | 2.2.0 | MIT | PERMISIF | root | node_modules |  |
| rtl-css-js | 1.16.1 | MIT | PERMISIF | root | node_modules |  |
| run-applescript | 7.1.0 | MIT | PERMISIF | root | node_modules |  |
| run-parallel | 1.2.0 | MIT | PERMISIF | root | node_modules |  |
| rw | 1.3.3 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| safe-array-concat | 1.1.3 | MIT | PERMISIF | root | node_modules |  |
| safe-push-apply | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| safe-regex-test | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| safe-regex2 | 5.1.2 | MIT | PERMISIF | server | node_modules |  |
| safe-stable-stringify | 2.5.0 | MIT | PERMISIF | server | node_modules |  |
| safer-buffer | 2.1.2 | MIT | PERMISIF | root | node_modules |  |
| sass | 1.89.2 | MIT | PERMISIF | root | node_modules |  |
| scheduler | 0.27.0 | MIT | PERMISIF | root | node_modules |  |
| screenfull | 5.2.0 | MIT | PERMISIF | root | node_modules |  |
| secure-json-parse | 4.1.1 | BSD-3-Clause | PERMISIF | server | node_modules |  |
| semver | 6.3.1 | ISC | PERMISIF | root | node_modules |  |
| semver | 7.7.2 | ISC | PERMISIF | root | node_modules |  |
| semver | 7.8.6 | ISC | PERMISIF | server | node_modules |  |
| send | 1.2.1 | MIT | PERMISIF | root | node_modules |  |
| serve-static | 2.2.1 | MIT | PERMISIF | root | node_modules |  |
| set-cookie-parser | 3.2.2 | MIT | PERMISIF | server | node_modules |  |
| set-function-length | 1.2.2 | MIT | PERMISIF | root | node_modules |  |
| set-function-name | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| set-harmonic-interval | 1.0.1 | Unlicense | PERMISIF | root | node_modules |  |
| set-proto | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| setprototypeof | 1.2.0 | ISC | PERMISIF | root | node_modules |  |
| shadcn | 4.13.1 | MIT | PERMISIF | root | node_modules |  |
| sharp | 0.34.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| shebang-command | 2.0.0 | MIT | PERMISIF | root+server | node_modules |  |
| shebang-regex | 3.0.0 | MIT | PERMISIF | root+server | node_modules |  |
| shiki | 3.23.0 | MIT | PERMISIF | root | node_modules |  |
| side-channel | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| side-channel | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| side-channel-list | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| side-channel-list | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| side-channel-map | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| side-channel-weakmap | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| siginfo | 2.0.0 | ISC | PERMISIF | root+server | node_modules |  |
| signal-exit | 3.0.7 | ISC | PERMISIF | root | node_modules |  |
| signal-exit | 4.1.0 | ISC | PERMISIF | root | node_modules |  |
| simple-swizzle | 0.2.2 | MIT | PERMISIF | root | node_modules |  |
| sisteransi | 1.0.5 | MIT | PERMISIF | root | node_modules |  |
| sonic-boom | 4.2.1 | MIT | PERMISIF | server | node_modules |  |
| sonner | 2.0.7 | MIT | PERMISIF | root | node_modules |  |
| source-map | 0.5.6 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| source-map | 0.6.1 | BSD-3-Clause | PERMISIF | root+server | node_modules |  |
| source-map-js | 1.2.1 | BSD-3-Clause | PERMISIF | root | node_modules |  |
| source-map-js | 1.2.2 | BSD-3-Clause | PERMISIF | server | node_modules |  |
| source-map-resolve | 0.6.0 | MIT | PERMISIF | root | node_modules |  |
| source-map-support | 0.5.21 | MIT | PERMISIF | server | node_modules |  |
| space-separated-tokens | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| split2 | 4.2.0 | ISC | PERMISIF | server | node_modules |  |
| stable-hash | 0.0.5 | MIT | PERMISIF | root | node_modules |  |
| stack-generator | 2.0.10 | MIT | PERMISIF | root | node_modules |  |
| stackback | 0.0.2 | MIT | PERMISIF | root+server | node_modules |  |
| stackframe | 1.3.4 | MIT | PERMISIF | root | node_modules |  |
| stacktrace-gps | 3.1.2 | MIT | PERMISIF | root | node_modules |  |
| stacktrace-js | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| statuses | 2.0.2 | MIT | PERMISIF | root | node_modules |  |
| std-env | 3.10.0 | MIT | PERMISIF | root+server | node_modules |  |
| stdin-discarder | 0.2.2 | MIT | PERMISIF | root | node_modules |  |
| stop-iteration-iterator | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| streamdown | 2.5.0 | Apache-2.0 | PERMISIF | root | node_modules |  |
| streamsearch | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| string-width | 7.2.0 | MIT | PERMISIF | root | node_modules |  |
| string.prototype.includes | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| string.prototype.matchall | 4.0.12 | MIT | PERMISIF | root | node_modules |  |
| string.prototype.repeat | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| string.prototype.trim | 1.2.10 | MIT | PERMISIF | root | node_modules |  |
| string.prototype.trimend | 1.0.9 | MIT | PERMISIF | root | node_modules |  |
| string.prototype.trimstart | 1.0.8 | MIT | PERMISIF | root | node_modules |  |
| stringify-entities | 4.0.4 | MIT | PERMISIF | root | node_modules |  |
| stringify-object | 5.0.0 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| strip-ansi | 6.0.1 | MIT | PERMISIF | root | node_modules |  |
| strip-ansi | 7.2.0 | MIT | PERMISIF | root | node_modules |  |
| strip-bom | 3.0.0 | MIT | PERMISIF | root | node_modules |  |
| strip-final-newline | 2.0.0 | MIT | PERMISIF | root | node_modules |  |
| strip-final-newline | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| strip-json-comments | 3.1.1 | MIT | PERMISIF | root | node_modules |  |
| strip-literal | 3.1.0 | MIT | PERMISIF | root+server | node_modules |  |
| style-mod | 4.1.2 | MIT | PERMISIF | root | node_modules |  |
| style-to-js | 1.1.21 | MIT | PERMISIF | root | node_modules |  |
| style-to-object | 1.0.14 | MIT | PERMISIF | root | node_modules |  |
| styled-jsx | 5.1.6 | MIT | PERMISIF | root | node_modules |  |
| stylis | 4.3.6 | MIT | PERMISIF | root | node_modules |  |
| supports-color | 7.2.0 | MIT | PERMISIF | root | node_modules |  |
| supports-preserve-symlinks-flag | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| systeminformation | 5.31.17 | MIT | PERMISIF | root | node_modules |  |
| tailwind-merge | 3.6.0 | MIT | PERMISIF | root | node_modules |  |
| tailwindcss | 4.3.3 | MIT | PERMISIF | root | node_modules |  |
| tapable | 2.3.3 | MIT | PERMISIF | root | node_modules |  |
| tauri-plugin-clipboard-api | 2.1.11 | MIT | PERMISIF | root | node_modules |  |
| text-table | 0.2.0 | MIT | PERMISIF | root | node_modules |  |
| thread-stream | 4.2.1 | MIT | PERMISIF | server | node_modules |  |
| throttle-debounce | 3.0.1 | MIT | PERMISIF | root | node_modules |  |
| tiny-invariant | 1.3.3 | MIT | PERMISIF | root | node_modules |  |
| tinybench | 2.9.0 | MIT | PERMISIF | root+server | node_modules |  |
| tinycolor2 | 1.6.0 | MIT | PERMISIF | root | node_modules |  |
| tinyexec | 0.3.2 | MIT | PERMISIF | root+server | node_modules |  |
| tinyexec | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| tinyglobby | 0.2.14 | MIT | PERMISIF | root | node_modules |  |
| tinyglobby | 0.2.17 | MIT | PERMISIF | root+server | node_modules |  |
| tinypool | 1.1.1 | MIT | PERMISIF | root+server | node_modules |  |
| tinyrainbow | 2.0.0 | MIT | PERMISIF | root+server | node_modules |  |
| tinyspy | 4.0.6 | MIT | PERMISIF | root+server | node_modules |  |
| tippy.js | 6.3.7 | MIT | PERMISIF | root | node_modules |  |
| to-regex-range | 5.0.1 | MIT | PERMISIF | root | node_modules |  |
| toad-cache | 3.7.4 | MIT | PERMISIF | server | node_modules |  |
| toggle-selection | 1.0.6 | MIT | PERMISIF | root | node_modules |  |
| toidentifier | 1.0.1 | MIT | PERMISIF | root | node_modules |  |
| tr46 | 0.0.3 | MIT | PERMISIF | root | node_modules |  |
| trim-lines | 3.0.1 | MIT | PERMISIF | root | node_modules |  |
| trough | 2.2.0 | MIT | PERMISIF | root | node_modules |  |
| ts-api-utils | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| ts-dedent | 2.2.0 | MIT | PERMISIF | root | node_modules |  |
| ts-easing | 0.2.0 | Unlicense | PERMISIF | root | node_modules |  |
| ts-morph | 26.0.0 | MIT | PERMISIF | root | node_modules |  |
| ts-morph | 28.0.0 | MIT | PERMISIF | root | node_modules |  |
| tsconfck | 3.1.6 | MIT | PERMISIF | root | node_modules |  |
| tsconfig-paths | 3.15.0 | MIT | PERMISIF | root | node_modules |  |
| tsconfig-paths | 4.2.0 | MIT | PERMISIF | root | node_modules |  |
| tslib | 2.8.1 | 0BSD | PERMISIF | root | node_modules |  |
| tsx | 4.23.15 | MIT | PERMISIF | server | node_modules |  |
| turndown | 7.2.4 | MIT | PERMISIF | root | node_modules |  |
| tw-animate-css | 1.4.0 | MIT | PERMISIF | root | node_modules |  |
| type-check | 0.4.0 | MIT | PERMISIF | root | node_modules |  |
| type-fest | 0.20.2 | (MIT OR CC0-1.0) | PERMISIF | root | node_modules |  |
| type-is | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| typed-array-buffer | 1.0.3 | MIT | PERMISIF | root | node_modules |  |
| typed-array-byte-length | 1.0.3 | MIT | PERMISIF | root | node_modules |  |
| typed-array-byte-offset | 1.0.4 | MIT | PERMISIF | root | node_modules |  |
| typed-array-length | 1.0.7 | MIT | PERMISIF | root | node_modules |  |
| typescript | 5.8.3 | Apache-2.0 | PERMISIF | root | node_modules |  |
| typescript | 5.9.3 | Apache-2.0 | PERMISIF | server | node_modules |  |
| uc.micro | 2.1.0 | MIT | PERMISIF | root | node_modules |  |
| ufo | 1.6.3 | MIT | PERMISIF | root | node_modules |  |
| unbox-primitive | 1.1.0 | MIT | PERMISIF | root | node_modules |  |
| undici | 7.28.0 | MIT | PERMISIF | root | node_modules |  |
| undici-types | 5.26.5 | MIT | PERMISIF | root | node_modules |  |
| undici-types | 6.21.0 | MIT | PERMISIF | root | node_modules |  |
| undici-types | 7.24.6 | MIT | PERMISIF | server | node_modules |  |
| unicorn-magic | 0.3.0 | MIT | PERMISIF | root | node_modules |  |
| unified | 11.0.5 | MIT | PERMISIF | root | node_modules |  |
| unist-util-find-after | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| unist-util-is | 6.0.1 | MIT | PERMISIF | root | node_modules |  |
| unist-util-position | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| unist-util-remove-position | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| unist-util-stringify-position | 4.0.0 | MIT | PERMISIF | root | node_modules |  |
| unist-util-visit | 5.1.0 | MIT | PERMISIF | root | node_modules |  |
| unist-util-visit-parents | 6.0.2 | MIT | PERMISIF | root | node_modules |  |
| universalify | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| unpipe | 1.0.0 | MIT | PERMISIF | root | node_modules |  |
| unrs-resolver | 1.11.1 | MIT | PERMISIF | root | node_modules |  |
| update-browserslist-db | 1.2.3 | MIT | PERMISIF | root | node_modules |  |
| uri-js | 4.4.1 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| use-callback-ref | 1.3.3 | MIT | PERMISIF | root | node_modules |  |
| use-intl | 3.26.5 | MIT | PERMISIF | root | node_modules |  |
| use-sidecar | 1.1.3 | MIT | PERMISIF | root | node_modules |  |
| use-sync-external-store | 1.5.0 | MIT | PERMISIF | root | node_modules |  |
| usehooks-ts | 3.1.1 | MIT | PERMISIF | root | node_modules |  |
| util-deprecate | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| uuid | 11.1.0 | MIT | PERMISIF | root | node_modules |  |
| valibot | 0.40.0 | MIT | PERMISIF | root | node_modules |  |
| validate-npm-package-name | 7.0.2 | ISC | PERMISIF | root | node_modules |  |
| vary | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| vaul | 1.1.2 | MIT | PERMISIF | root | node_modules |  |
| vfile | 6.0.3 | MIT | PERMISIF | root | node_modules |  |
| vfile-location | 5.0.3 | MIT | PERMISIF | root | node_modules |  |
| vfile-message | 4.0.3 | MIT | PERMISIF | root | node_modules |  |
| victory-vendor | 37.3.6 | MIT AND ISC | PERMISIF | root | node_modules |  |
| vite | 7.3.8 | MIT | PERMISIF | root+server | node_modules |  |
| vite-node | 3.2.4 | MIT | PERMISIF | root+server | node_modules |  |
| vite-tsconfig-paths | 5.1.4 | MIT | PERMISIF | root | node_modules |  |
| vitest | 3.2.7 | MIT | PERMISIF | root+server | node_modules |  |
| vscode-jsonrpc | 8.2.0 | MIT | PERMISIF | root | node_modules |  |
| vscode-languageserver | 9.0.1 | MIT | PERMISIF | root | node_modules |  |
| vscode-languageserver-protocol | 3.17.5 | MIT | PERMISIF | root | node_modules |  |
| vscode-languageserver-textdocument | 1.0.12 | MIT | PERMISIF | root | node_modules |  |
| vscode-languageserver-types | 3.17.5 | MIT | PERMISIF | root | node_modules |  |
| vscode-uri | 3.0.8 | MIT | PERMISIF | root | node_modules |  |
| w3c-keyname | 2.2.8 | MIT | PERMISIF | root | node_modules |  |
| web-namespaces | 2.0.1 | MIT | PERMISIF | root | node_modules |  |
| web-streams-polyfill | 4.0.0-beta.3 | MIT | PERMISIF | root | node_modules |  |
| webidl-conversions | 3.0.1 | BSD-2-Clause | PERMISIF | root | node_modules |  |
| whatwg-url | 5.0.0 | MIT | PERMISIF | root | node_modules |  |
| which | 2.0.2 | ISC | PERMISIF | root+server | node_modules |  |
| which | 4.0.0 | ISC | PERMISIF | root | node_modules |  |
| which-boxed-primitive | 1.1.1 | MIT | PERMISIF | root | node_modules |  |
| which-builtin-type | 1.2.1 | MIT | PERMISIF | root | node_modules |  |
| which-collection | 1.0.2 | MIT | PERMISIF | root | node_modules |  |
| which-typed-array | 1.1.19 | MIT | PERMISIF | root | node_modules |  |
| why-is-node-running | 2.3.0 | MIT | PERMISIF | root+server | node_modules |  |
| word-wrap | 1.2.5 | MIT | PERMISIF | root | node_modules |  |
| wrappy | 1.0.2 | ISC | PERMISIF | root | node_modules |  |
| wsl-utils | 0.3.1 | MIT | PERMISIF | root | node_modules |  |
| xtend | 4.0.2 | MIT | PERMISIF | server | node_modules |  |
| y-protocols | 1.0.7 | MIT | PERMISIF | root | node_modules |  |
| yallist | 3.1.1 | ISC | PERMISIF | root | node_modules |  |
| yaml | 2.8.0 | ISC | PERMISIF | root | node_modules |  |
| yjs | 13.6.31 | MIT | PERMISIF | root | node_modules |  |
| yocto-queue | 0.1.0 | MIT | PERMISIF | root | node_modules |  |
| yocto-spinner | 1.2.2 | MIT | PERMISIF | root | node_modules |  |
| yoctocolors | 2.1.2 | MIT | PERMISIF | root | node_modules |  |
| zod | 3.25.76 | MIT | PERMISIF | root | node_modules |  |
| zod | 4.3.6 | MIT | PERMISIF | root | node_modules |  |
| zod-to-json-schema | 3.25.2 | ISC | PERMISIF | root | node_modules |  |
| zustand | 4.5.7 | MIT | PERMISIF | root | node_modules |  |
| zustand | 5.0.6 | MIT | PERMISIF | root | node_modules |  |
| zwitch | 2.0.4 | MIT | PERMISIF | root | node_modules |  |

## 9. Kadaluwarsa berkas ini

Berkas ini berlaku untuk commit di bagian 1. Setiap perubahan pada
`pnpm-lock.yaml` atau `server/pnpm-lock.yaml` sesudah commit itu membuat
berkas ini basi; inventaris wajib dibuat ulang dari HEAD baru sebelum
rilis publik berikutnya. Jangan mengedit tabel di bagian 8 dengan tangan;
buat ulang dari output skrip inventaris.
