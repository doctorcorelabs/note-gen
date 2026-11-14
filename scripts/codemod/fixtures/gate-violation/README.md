<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Fixture pelanggaran yang disengaja untuk gate 4 lapis (V3-16b)

Berkas `violation.ts` di direktori ini sengaja melanggar aturan
migrasi. Ia adalah INPUT UJI gate, bukan input mesin codemod dan
bukan kode produksi. Jangan pernah meletakkannya di bawah `src/`
pada tree repo; gate dijalankan atas salinannya pada tree staging.

## Cara pakai (milik V3-16b; fixture ini hanya menyediakan input)

1. Salin `violation.ts` ke bawah `src/` pada tree staging (mis.
   `src/lib/gate-violation-probe.ts`), di luar
   `src/lib/platform/`.
2. Jalankan gate 4 lapis V3-16b atas tree staging itu.
3. Hapus salinan staging sesudah gate berjalan; jangan biarkan
   salinan itu masuk commit manapun.

## Hasil yang diharapkan

- Lapis 1 (grep spesifier): MERAH. Satu baris
  `@tauri-apps/plugin-store` di luar `src/lib/platform/`.
- Lapis 2 (grep pola turunan): MERAH. Satu `Store.load(` mentah
  dan satu `__TAURI_INTERNALS__` di luar `src/lib/platform/`.
- Lapis 3 (lint): bergantung pada bentuk allowlist tree staging;
  V3-16b mencatat ekspektasi lapis 3 atas probe ini di
  dokumentasi gate, bukan di sini.
- Lapis 4 (typecheck + contract + smoke): tidak dinilai atas
  probe ini sendirian; probe ini hanya membuktikan lapis 1 dan
  lapis 2 mendeteksi pelanggaran.

Bila lapis 1 atau lapis 2 HIJAU atas probe ini, gate cacat dan
wajib diperbaiki sebelum dipakai mengunci gelombang. Hasil jalan
gate atas probe ini dicatat di laporan V3-16b, bukan di sini.

## Kebersihan

Berkas ini memakai 0 karakter em dash, membawa header SPDX, dan
tidak memuat secret atau data nyata (`store.json` adalah nama
sintetis).
