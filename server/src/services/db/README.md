<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!-- This file is part of the NoteGen web fork, licensed under the GNU General Public License v3. See LICENSE and FORK.md. -->
# Db handlers: kelompok B (V3-13c)

Kerangka branch `web-db-handlers-b`. Berkas ini hanya penanda
kepemilikan direktori; belum ada kode handler di branch ini.

Aturan pengunci AD-42f: catatan pembagian handler per kind
(`fase1/pembagian-handler-kind.md`, satu kind satu handler satu
penulis) wajib ada sebelum push kode handler. Pekerja ini
mengimplementasikan hanya kind kelompok B sesuai catatan itu, dan
tidak mengambil kind kelompok A (V3-13b) atau kind V3-25, dan tidak
mengarang pembagian sendiri.

Pekerja ini juga pemilik uji db (`server/test/db*.spec.ts`): uji
handler dan transaksi atas Postgres scratch dengan skema 0000.
