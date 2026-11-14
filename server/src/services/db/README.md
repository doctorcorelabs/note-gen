<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!-- This file is part of the NoteGen web fork, licensed under the GNU General Public License v3. See LICENSE and FORK.md. -->
# Db handlers: kelompok B (V3-13c)

Branch `web-db-handlers-b`. Direktori ini berisi 25 handler kind
kelompok B (wiki 17, knowledge 6, vector 2), satu kind per berkas,
satu marker `HANDLER_KIND` per berkas, tanpa barrel dan tanpa impor
antar-handler. Delapan kind tulis W2 adalah stub bertipe yang
menjawab 410 `capability_unavailable` dengan fase Fase 2; kind
`vector.replaceChunks` hanya untuk server dan tidak diekspos lewat
adapter klien. Uji db ada di `server/test/db/` (konformansi dan
validasi tanpa DB, plus uji perilaku atas Postgres 17).

Aturan pengunci AD-42f: catatan pembagian handler per kind
(`fase1/pembagian-handler-kind.md`, satu kind satu handler satu
penulis) wajib ada sebelum push kode handler. Pekerja ini
mengimplementasikan hanya kind kelompok B sesuai catatan itu, dan
tidak mengambil kind kelompok A (V3-13b) atau kind V3-25, dan tidak
mengarang pembagian sendiri.

Pekerja ini juga pemilik uji db (`server/test/db/*.spec.ts`): uji
handler dan transaksi atas Postgres scratch dengan skema 0000.
