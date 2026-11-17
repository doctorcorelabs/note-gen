# NoteGen Web Fork

Fork web dari NoteGen untuk penggunaan lewat browser, dengan backend HTTP dan Postgres.
Repo ini BUKAN rilis resmi codexu. Rilis resmi tetap berada di repo upstream.

- Repo fork: doctorcorelabs/note-gen
- Repo upstream: codexu/note-gen (https://github.com/codexu/note-gen)
- Lisensi: GNU General Public License v3 (lihat LICENSE)
- Status: Fase 1 (MVP) dalam pengembangan; Fase 0 lulus 14 Nov 2026. Branch web berisi boot web dengan StoreAdapter web (shim Store POC dihapus 17 Nov 2026; shim App sementara tersisa), bahasa default UI Inggris, endpoint health API, dan hygiene repo ini. Target deployment: notegen.synapxs.my.id di muse-2 (belum deploy).

## Basis upstream

Fork ini dibuat dari commit upstream berikut:

- Commit: 4dcaa3f03a661c1259f8dfcdbc4a94c8cba0ffd5 (4dcaa3f)
- Tanggal commit: 11 November 2026
- Branch upstream: dev (branch default upstream)
- Versi aplikasi upstream saat basis: 0.39.2 (src-tauri/tauri.conf.json)

## Notice modifikasi (GPLv3)

Kode di repo ini didasarkan pada codexu/note-gen yang dilisensikan GPLv3, Copyright (C) 2025 codexu.
Fork ini memodifikasi kode upstream untuk mode web. File upstream yang diubah secara substansial
membawa notice modifikasi di header komentarnya, beserta tanggal perubahan. Daftar perubahan
signifikan per rilis fork ada di Changelog di bawah. File LICENSE dipertahankan tanpa perubahan.
Kode baru fork juga dilisensikan GPLv3.

## Cara kerja fork (ringkas)

- Frontend Next.js upstream dipertahankan di root; StoreAdapter web (src/lib/platform/store/store.web.ts) menggantikan shim Store POC yang menyimpan dokumen sebagai plaintext di localStorage. Satu-satunya shim POC yang tersisa adalah poc-app-shim.ts untuk pekerjaan AppAdapter. Rumah kanonis registry shim adalah src/lib/platform/ (keputusan AD-23, Fase 1); src/lib/web/ menampung kode web baru di luar registry shim.
- Backend baru: API Fastify di server/ dengan package.json dan pnpm-lock.yaml terpisah. Endpoint health (live, ready, alias) sudah ada di Fase 0; endpoint data belum ada.
- Penyimpanan server yang direncanakan: Postgres 17. File workspace disimpan di disk server (volume), dengan indeks metadata di Postgres. Uji health Fase 0 memakai Postgres 16.15; uji ulang di Postgres 17 dibutuhkan sebelum deploy.
- Repo note-gen-server TIDAK di-vendor ke fork ini; integrasi sync, bila dibutuhkan, berjalan lewat image publik sebagai layanan terpisah.
- Direktori src-tauri/ dipertahankan pada awal fork; yang dinonaktifkan adalah pipeline rilisnya, bukan kodenya.
- Workflow rilis dan publikasi config upstream dinonaktifkan (file .disabled di .github/workflows/). Penonaktifan ini disengaja, bukan kelalaian.
- Dokumen fork: file ini di root (dengan exception gitignore). Runbook infra direncanakan di infra/docs/ (belum ada di Fase 0). Desain panjang tetap di luar repo.

## Fitur nonaktif di web (G5)

Fitur berikut hanya ada di aplikasi desktop dan nonaktif secara eksplisit
di versi web. Tidak ada yang gagal diam-diam: adapter web menolak dengan
`PlatformCapabilityError` berkode `unsupported`, dan UI menampilkan penanda
nonaktif. Penanda UI membaca flag kapabilitas dari registry
(`capabilities.*`); pemanggil tidak memeriksa mode runtime sendiri.
Di desktop, perilaku mengikuti implementasi Tauri yang diregistrasi;
registrasi implementasi Tauri adalah pekerjaan terpisah dari migrasi
call site G5.

| Fitur | Adapter web | Penanda UI di web |
| --- | --- | --- |
| Shortcut global (di luar aplikasi) | `ShortcutAdapter`: `register`/`unregister` menolak, `isRegistered` mengembalikan false. Flag `globalShortcut`. | Halaman pengaturan shortcut: pemberitahuan bahwa shortcut global hanya ada di desktop, dan input shortcut dinonaktifkan. Shortcut di dalam tab memakai registry shortcut web yang terpisah. |
| Buka lewat shell desktop | `ShellAdapter.open` menolak (tidak ada padanan server, AD-14). | Tidak ada permukaan UI sendiri. Keempat call site yang ada membuka URL http(s) dan dirutekan ke `OpenerAdapter.openUrl`, sehingga tautan tetap terbuka di tab baru. |
| Keluar / jalankan ulang proses | `ProcessAdapter`: `exit`/`relaunch` menolak. | Dialog perilaku tutup hanya terpicu event desktop sehingga tidak muncul di web. Tombol updater dinonaktifkan di web (lihat baris pembaruan). Alur reset database lokal gagal di command `delete_local_database` (DISABLE) sebelum mencapai `relaunch`. |
| Luncur saat startup | `AutostartAdapter`: `isEnabled`/`enable`/`disable` menolak. Flag `autostart`. | Pengaturan perilaku sistem: badge "Desktop only" pada pengaturan luncur saat startup, dan kedua switch dinonaktifkan. Adapter tidak dipanggil di web. |
| Pemeriksa pembaruan aplikasi | `UpdaterAdapter.check` menolak; pembaruan adalah deploy server. Flag `updater`. | Halaman Tentang: pemberitahuan bahwa pembaruan dipasang di server dan tombol pemeriksaan dinonaktifkan. Pemicu pemeriksaan saat boot dijaga agar tidak berjalan di web (AD-42). |
| Tangkap layar desktop dan pin | Rute desktop; flag `screenshot`. Salin gambar memakai `ClipboardAdapter.writeImage` dengan bytes PNG langsung. | Rute `/screenshot` dan `/screenshot-pin` menampilkan pemberitahuan nonaktif di web dan tidak memulai sesi desktop. |
| Eksekusi terminal plugin | Tanpa adapter; dihapus permanen tanpa padanan web (AD-14). Koreksi atas klaim lama bahwa izin `terminal.open` "tidak ada di fork web": klaim itu SALAH pada trunk gelombang 3, karena 11 literal masih ada di `src/` (AD-109). Gelombang 4 (W4-SEC) menghapus ke-11 literal itu: izin dihapus dari skema manifest (manifest yang mendeklarasikannya gagal validasi `InvalidManifest`), modul capability frame menjadi no-op tanpa jalur invoke, dan job grep CI + aturan eslint menegakkan 0 literal di `src/`. Backend Rust `src-tauri/src/plugin_terminal.rs` masih ada di tree tetapi tidak punya jalur invoke dari `src/` dan tidak ikut build web; tidak ada padanan server yang boleh dibuat. | Tidak ada permukaan UI; dialog izin tidak pernah menampilkan izin terminal, dan embedded view plugin hanya tampil tanpa capability. |

## Branch

- dev: cermin pristine upstream. Selalu sama dengan upstream/dev setelah sync. Tidak pernah berisi commit fork.
- web: trunk fork dan branch default repo fork. Pekerjaan mendarat lewat PR atau push langsung ke web (push langsung dipakai selama Fase 0-1; proteksi branch belum diatur lewat web UI).
- web-<topik>: branch fitur berumur pendek dari web, dihapus setelah merge.
- upstream-sync-YYYY-MM-DD: branch kerja temporer tiap sync, dibuat dari web, di-PR ke web, lalu dihapus.

Aturan merge: PR fitur ke web memakai squash merge. PR sync upstream ke web memakai merge commit (bukan squash, bukan rebase). Jangan pernah rebase dev atau web setelah di-push.

## Sync upstream

- Jadwal rutin: seminggu sekali, satu PR sync per jadwal. Jadwal insidental: segera setelah upstream memotong tag rilis baru (note-gen-v*).
- Prosedur ringkas: git fetch upstream, buat branch upstream-sync-YYYY-MM-DD dari web, git merge upstream/dev, selesaikan konflik mengikuti aturan prioritas di bawah, jalankan gate lokal (install, typecheck, lint, build), buka PR sync berisi rentang commit dan daftar konflik, merge setelah CI hijau, majukan dev fork ke upstream/dev, lalu catat di log di bawah.
- Prioritas konflik: Kelas A (file milik fork penuh: server/, infra/, src/lib/web/, src/lib/platform/, .github/workflows/web-ci.yml, FORK.md, .env.example) fork menang. Kelas B (file hotspot bersama, mis. src/app/page.tsx, src/app/core/layout.tsx, src/stores/setting.ts, src/db/index.ts, src/lib/workspace.ts, src/lib/files.ts, src/lib/ai/*, next.config.ts, package.json, pnpm-lock.yaml) tinjau per hunk dan shim web dipertahankan. Kelas C (file milik upstream murni) upstream menang apa adanya.
- Lockfile: jangan menyelesaikan konflik pnpm-lock.yaml dengan edit manual. Ambil versi upstream, jalankan ulang pnpm install, lalu commit hasil regenerate.

## Log sync upstream

| Tanggal | Rentang upstream | Konflik (A/B/C) | PR sync | Catatan |
| --- | --- | --- | --- | --- |
| 2026-11-11 | (basis) 4dcaa3f | - | - | Commit dasar fork, bukan hasil sync. |
| YYYY-MM-DD | <sha lama>..<sha baru> | 0/0/0 | #NNN | Salin baris ini untuk tiap sync baru. |

## Versioning fork

- Tag fork memakai prefix web-v, mis. web-v0.1.0, dibuat dari web setelah tonggak tercapai.
- Tag upstream (note-gen-v*, mis. note-gen-v0.39.2) tidak pernah dibuat ulang, dipindah, atau di-push dari fork.
- Angka versi di src-tauri/tauri.conf.json (0.39.2), package.json (0.1.0), dan Cargo.toml (0.1.0) tidak diubah untuk menandai versi web. Versi web dilacak lewat tag web-v* dan Changelog di bawah.

## Changelog

### web-v0.1.0 (belum dirilis)

- 2026-11-17: kill-switch plugin ditegakkan di kode + penghapusan terminal (W4-SEC): satu konstanta fase plugin `PLUGIN_WEB_PHASE` bernilai `off` (`src/lib/plugins/plugin-web-phase.ts`) dibaca satu modul kill-switch yang meng-gate bridge host (G0), host initialize/activate/reconcile (G1), kepala broker RPC (G2), dan seam backend plugin (G3); flag `plugins` di web-chrome kini diturunkan dari konstanta yang sama. Ke-11 literal terminal pra-ada di `src/` dihapus (skema manifest, urutan tampil izin, view sandbox, modul capability frame yang menjadi no-op); metadata capability tidak lagi mengiklankan terminal; job grep CI `forbidden-strings` + aturan eslint `no-restricted-syntax` menegakkan 0 literal di `src/`; baris terminal pada tabel G5 di atas dikoreksi (klaim lama dinyatakan SALAH oleh AD-109).

- 2026-11-17: shim Store POC dihapus (F1-16/V3-12): berkas src/lib/platform/poc-store-shim.ts dihapus dan entri alias Turbopack @tauri-apps/plugin-store dilepas dari next.config.ts; StoreAdapter web (src/lib/platform/store/store.web.ts) menggantikannya. Alias api/app dan poc-app-shim.ts dipertahankan untuk pekerjaan AppAdapter. Kontrak store F1 seksi 8 (design/01-shim-architecture.md) diganti oleh kontrak store yang berlaku (fase1/kontrak-api-kanonis.md; desain-store-adapter.md seksi 4.7); kedua bentuk kontrak tidak dibangun bersamaan.

- 2026-11-16: codemod G5 dan penanda nonaktif (V3-21): 6 spesifier terakhir (`plugin-global-shortcut`, `plugin-shell`, `plugin-process`, `plugin-autostart`, `plugin-updater`, `api/image`) dimigrasikan ke registry platform; penanda nonaktif untuk shortcut global, autostart, updater, dan rute screenshot; daftar fitur nonaktif di web didokumentasikan di bagian "Fitur nonaktif di web (G5)" di atas; allowlist import Tauri dihapus dan Override 1 ESLint menjadi error.

- 2026-11-14: penamaan branch fitur diperbaiki menjadi `web-<topik>` (AD-24, amandemen atas AD-02; bentuk lama memakai slash dan tidak dapat dipakai berdampingan dengan ref trunk `web`) dan exception `.gitignore` ditambahkan untuk `infra/docs/` agar runbook infra dapat di-commit tanpa `git add -f`.
- 2026-11-14: keputusan gate S2 diformalkan (AD-22): static export + API terpisah dipertahankan; rumah kanonis registry shim ditetapkan di src/lib/platform/ (AD-23); kalimat branch diperbaiki agar konsisten dengan praktik push langsung Fase 0-1.

- 2026-11-14: boot web POC (a397b86, 7e95e0c): alias Turbopack untuk plugin-store dan api/app, shim Store dan App sementara di src/lib/platform/, guard platform dan guard appDataDir. Shim menyimpan dokumen sebagai plaintext di localStorage dan wajib diganti di Fase 1.
- 2026-11-14: bahasa default UI menjadi Inggris, mode zh tetap jalan (623fbb0): DEFAULT_LOCALE en terpisah dari FALLBACK_LOCALE zh, tiga titik default lain berubah ke en. String CJK hardcoded di luar cakupan perubahan ini dan menjadi follow-up Fase 1.
- 2026-11-14: endpoint health API Fastify di server/ (28687d5): GET /api/health/live, GET /api/health/ready, dan alias GET /api/health, dengan lockfile server terpisah. Diuji di Postgres 16.15; uji T16 lewat proksi ditunda ke compose.
- 2026-11-14: hygiene repo dan identitas fork: tambahan .gitignore, file ini, .env.example (root, server, infra), penonaktifan workflow rilis dan publikasi config.
- 2026-11-14: fondasi registry G0 gelombang 2 Fase 1 (branch web-registry-g0): 19 berkas interface adapter type-only di src/lib/platform/ (20 interface untuk 16 butir inventaris), perluasan registry.ts (registrasi bertipe, capability flag, freeze sesudah boot), barrel src/lib/platform/index.ts, aturan ESLint no-restricted-imports untuk impor Tauri di luar platform di .eslintrc.json (peringatan untuk berkas lama, error untuk berkas platform), dan gate grep scripts/platform-guard.sh dengan allowlist. Tidak ada perubahan perilaku; belum ada pemanggil registry.

### Basis upstream

- 2026-11-11: fork dibuat dari upstream commit 4dcaa3f (branch dev).

## Setup lokal (ringkas)

1. Salin .env.example ke .env, server/.env.example ke server/.env, dan infra/.env.example ke infra/.env, lalu isi nilai nyata di file .env tersebut. File .env tidak pernah di-commit.
2. Ikuti README.md untuk langkah build; runbook infra di infra/docs/ menyusul (belum ada di Fase 0).
