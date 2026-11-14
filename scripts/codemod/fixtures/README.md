<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Codemod fixtures (DRAF AWAL, V3-16c)

Draf awal. Isi lengkap (pasangan before/after per specifier G1-G5,
kasus tepi, dan manifest.json) menyusul pada commit berikutnya di
branch ini. Fixture ditulis dari rencana gelombang 3 seksi 3C dan
desain registry V1-05 seksi 4; mesin V3-16a belum ter-push saat draf
ini ditulis, sehingga selisih bentuk output mesin dicatat sebagai
utang 3C pada laporan pekerja.

Kontrak ringkas: tiap kasus adalah satu direktori dengan `before.ts`
dan `after.ts`. Mesin codemod dijalankan atas salinan `before.ts`
dan hasilnya dibandingkan dengan `after.ts` secara semantik (AST),
bukan byte-per-byte. Lihat README final pada commit berikutnya.
