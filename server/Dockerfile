# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
# See LICENSE and FORK.md.
#
# Dockerfile API: Fastify + Drizzle + Postgres.
#
# ADOPSI GELOMBANG 5 (slot W5-DOCKER, 18 Nov 2026): berkas ini diadopsi ke
# repo dari draf dep-29 (SMK-DF2, Dockerfile.api; md5 draf
# be497d4536550e6fc26f542d6b74c23a sama dengan Dockerfile.api.frozen
# predeploy). Tahap build dan runtime dipertahankan dari draf yang
# terbukti: build smoke run 2 lulus (tsc + prune) dan image predeploy
# (K7 inspect + boot atas database scratch) lulus. Penempatan: server/
# (di dalam konteks build), mengikuti asumsi DF2 dan padanan F10
# bagian 5 (apps/api/Dockerfile pada tata letak draf; tata letak trunk
# adalah server/). Pasangan: Dockerfile.web di root repo (konteks root)
# dan .dockerignore di root repo. Konteks API dibaca dengan
# server/.dockerignore (berkas terlacak sejak adopsi ini).
#
# DELTA ADOPSI terhadap draf dep-29 (selain kepala berkas ini):
# 1. ENTRYPOINT [] eksplisit sebelum CMD (F-03, AD-131 butir 2):
#    menghapus ENTRYPOINT yang diwarisi dari base image node. Draf
#    menulis "tanpa ENTRYPOINT, disengaja"; pernyataan itu tidak
#    tepat, karena tanpa direktif ENTRYPOINT image mewarisi
#    entrypoint base image. Bentuk CMD exec tidak berubah, dan
#    override command (langkah migrasi manual, service worker masa
#    depan) tetap mungkin. Boot dengan ENTRYPOINT [] dibuktikan pada
#    build adopsi (lihat laporan W5-DOCKER).
# 2. Pin minor base image: node:24.22-bookworm-slim di kedua stage
#    (draf memakai node:24-bookworm-slim). Kedua tag menunjuk
#    manifest yang sama (digest di bawah, diverifikasi 18 Nov 2026),
#    sehingga image tidak berubah.
# 3. Kepala berkas diperbarui: klaim wiring migrasi draf (ditulis saat
#    migrasi belum ter-wiring) diganti fakta kini; perintah build
#    disesuaikan dengan penempatan di repo; digest terverifikasi
#    dicatat (F10 bagian 5.3). Tidak ada perubahan lain pada tahap
#    build atau runtime.
#
# CARA BUILD PERSIS (dari root repo):
#
#   docker build --build-arg IMAGE_REVISION=<sha> --build-arg IMAGE_SOURCE=https://github.com/doctorcorelabs/note-gen -t <nama-image>:<tag> ./server
#
# Konteks build adalah direktori server/ saja; Dockerfile dibaca dari
# dalam konteks (nama default), sehingga tidak perlu flag -f. Bentuk
# compose yang setara: build: { context: ./server } tanpa dockerfile.
# .dockerignore tetap dibaca dari root konteks, yaitu
# server/.dockerignore. Nama image dan tag di perintah build hanya
# untuk smoke lokal; nama image GHCR final dan digest adalah USULAN
# DEP-13 dan keputusan K-15, bukan keputusan berkas ini. Nama image
# DEP-13: ghcr.io/doctorcorelabs/note-gen-api dengan tag
# PLACEHOLDER_TAG.
#
# KEPUTUSAN MIGRASI: migrasi berjalan DI DALAM PROSES STARTUP, bukan
# lewat entrypoint dan bukan langkah terpisah wajib.
#
# Fakta kini (trunk adopsi; klaim draf tentang tidak adanya wiring
# sudah basi): server.ts memanggil runMigrations sebelum server
# menerima trafik bila MIGRATE_ON_START bukan 'false' (default true);
# bila 'false', startup memeriksa drift dan menolak start bila drift.
# Bila DATABASE_URL tidak di-set, migrasi dilewati dan readiness
# melaporkan database tidak terkonfigurasi (perilaku Fase 0). Dockerfile
# ini tidak menambah entrypoint migrasi: wiring sudah ada di kode, dan
# entrypoint migrasi akan mengubah perilaku boot yang sudah diputus
# (server tetap melapor health saat database belum termigrasi pada
# jalur tanpa DATABASE_URL; gagal migrasi menggagalkan startup dengan
# pesan yang menyebut kode/keluarga error, bukan SQL verbatim, F-01).
# Dockerfile ini menjamin berkas migrasi tersedia di image (drizzle/
# di samping dist/, sesuai catatan deployment di migrate.ts: folder
# migrasi diselesaikan relatif terhadap dist/db/migrate.js).
#
# Perintah migrasi manual (di luar band, bila dibutuhkan; otoritasnya
# prosedur PG dep-11/prosedur-smoke-opsi-b.md bagian 3 langkah 4,
# disalin verbatim):
# docker compose -f docker-compose.smoke.yml -p notegen-smoke run --rm api node --input-type=module -e 'import { runMigrations } from "./dist/db/migrate.js"; const r = await runMigrations({ databaseUrl: process.env.DATABASE_URL }); console.log(JSON.stringify({ appliedTags: r.appliedTags, drift: r.drift }));'
# Jangan menjalankan migrasi dari image ini dengan perintah lain atau
# varian karangan; hanya perintah PG di atas yang sah untuk jalur
# manual, dan DATABASE_URL dibaca dari environment service, tidak
# ditulis di perintah.
#
# Keputusan lain yang ditegakkan berkas ini:
# - Multi-stage: stage build (dependensi penuh + tsc) dan stage runtime
#   (node_modules produksi + dist/ + drizzle/ + package.json saja).
#   package.json runtime WAJIB ada: readServerVersion di server.ts membaca
#   ../package.json relatif terhadap dist/server.js.
# - User non-root: user `node` bawaan image. Build adopsi memeriksa
#   `id node` di dalam image (lihat laporan W5-DOCKER).
# - Tanpa secret di image: tidak ada ENV berisi secret, tidak ada berkas
#   .env yang di-COPY. DATABASE_URL dan semua secret hanya lewat env saat
#   run (pola DEP-13: env_file api.env). COPY eksplisit per berkas di bawah
#   berarti isi image tidak bergantung pada .dockerignore; .dockerignore
#   tetap dibutuhkan agar konteks build tidak membawa node_modules,
#   dist/, dan .env dari mesin build.
# - Port: EXPOSE 3001, sesuai DEP-13 (expose 3001, PORT 3001).
# - HEALTHCHECK mengikuti healthcheck service api di compose DEP-13
#   (probe node/fetch ke /api/health/live). Compose meng-override
#   HEALTHCHECK image bila keduanya ada; konflik D-W4 (live vs ready)
#   tetap terbuka dan milik koordinator.
# - ENTRYPOINT [] eksplisit (F-03, AD-131 butir 2): CMD default adalah
#   server, dan override command tetap mungkin (mis. langkah migrasi
#   manual atau service worker masa depan). DEP-13 mencatat worker akan
#   memakai image yang sama dengan command `worker`; perintah itu belum
#   ada di package.json, dan Dockerfile ini tidak mengarangnya.
# - NODE_ENV sengaja TIDAK di-set di image: nilainya milik api.env saat
#   run. config/env.ts menerapkan aturan fail-closed yang lebih ketat
#   pada mode production; image tidak boleh diam-diam memaksakannya.
# - Skrip prosedur M8 (server/scripts/) dan test/ TIDAK masuk image:
#   prosedur M8 berjalan dari checkout repo bila dibutuhkan. Bila
#   koordinator menghendaki skrip itu di image, tambahkan COPY eksplisit
#   dan catat alasannya.
#
# Pin toolchain:
# - Node 24, base image node:24.22-bookworm-slim (pin minor; preseden
#   compose dev infra/docker-compose.dev.yml dan CI web-ci.yml:
#   node-version 24). Varian bookworm (glibc), bukan alpine (musl):
#   binding native argon2 dipakai dengan glibc yang sama seperti dev
#   sampai ada bukti uji alpine. Digest terverifikasi (18 Nov 2026,
#   muse-2, amd64/linux, docker buildx imagetools inspect; sama
#   dengan digest node:24-bookworm-slim smoke):
#   sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
#   Pin digest di FROM (bentuk tag@digest) diputus bersama K-15 saat
#   adopsi CI; sampai saat itu digest tercatat di sini dan di laporan
#   adopsi sebagai identitas audit (F10 bagian 5.3).
# - pnpm 9.15.9 lewat corepack (preseden compose dev; pin laporan
#   toolchain W04). package.json root maupun server/ tidak membawa
#   packageManager pada trunk adopsi, sehingga pin hidup di berkas ini
#   dan di CI.
#
# PEMERIKSAAN ADOPSI (dijalankan pada build adopsi di muse-2; bukti di
# laporan W5-DOCKER, bukan di kepala berkas ini):
# - Build lulus dan `node dist/server.js` boot dengan env scratch,
#   menjawab GET /api/health/live 200.
# - `docker inspect` membuktikan ENTRYPOINT kosong dan CMD exec form.
# - `id node`, kepemilikan /app dan /workspace, dan HEALTHCHECK live.
# - Isi runtime: hanya package.json, node_modules produksi, dist/,
#   drizzle/; tanpa devDependencies, tanpa test/, tanpa .env.
# - Paket build (python3, make, g++): dipertahankan di stage build
#   saja; log smoke run 2 menunjukkan node-gyp-build berjalan untuk
#   argon2, sehingga penghapusan butuh bukti prebuild cukup.
# - Kepemilikan bind mount /workspace di host (K-06 terbuka) tetap
#   tanggung jawab setup; Dockerfile hanya menyiapkan direktori di image.

# ---------------- Stage build ----------------
FROM node:24.22-bookworm-slim AS build

# Perkakas build native untuk dependensi yang mengompilasi binding
# (argon2). Hanya di stage build; tidak masuk image runtime.
# Dipertahankan karena log smoke run 2 menunjukkan node-gyp-build
# berjalan untuk argon2; lihat PEMERIKSAAN ADOPSI di kepala berkas.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# pnpm 9.15.9 lewat corepack (preseden compose dev).
# PERBAIKAN KOORDINATOR #7 (16:51 WIB 16 Nov 2026, temuan build smoke run 1):
# `corepack prepare --activate` saja TIDAK membuat shim pnpm di PATH pada
# image ini (build gagal exit 127 "pnpm: not found" di langkah 6/10);
# `corepack enable` wajib mendahului, sama seperti Dockerfile.web yang jalan.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Lockfile lebih dulu agar layer install ter-cache selama dependensi
# tidak berubah. server/ adalah paket mandiri dengan lockfile sendiri
# (AD-06); tidak ada pnpm-workspace di root repo.
COPY package.json pnpm-lock.yaml ./

# Tanpa --ignore-scripts: install server di CI juga tanpa flag itu,
# sehingga skrip install binding native berjalan.
RUN pnpm install --frozen-lockfile

# Berkas build TypeScript. drizzle.config.ts tidak dibutuhkan build
# (hanya untuk drizzle-kit generate) dan tidak di-COPY.
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

# Build: tsc -p tsconfig.build.json, output ke dist/ (script build di
# server/package.json). Entry runtime: dist/server.js.
RUN pnpm build

# Pangkas devDependencies (typescript, drizzle-kit, vitest, @types)
# sehingga node_modules yang disalin ke runtime hanya produksi.
RUN pnpm prune --prod

# ---------------- Stage runtime ----------------
FROM node:24.22-bookworm-slim AS runtime

# Provenans image (VRF-10, AD-84): nilai diteruskan compose smoke
# lewat args IMAGE_REVISION/IMAGE_SOURCE. Bukan secret; default
# kosong aman bila arg tidak diteruskan (label terisi string kosong).
ARG IMAGE_REVISION=""
ARG IMAGE_SOURCE=""

LABEL org.opencontainers.image.title="notegen-api" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}"

# Direktori kerja dan workspace disiapkan sebagai root, dimiliki user
# non-root sebelum USER dialihkan. /workspace adalah titik mount
# WORKSPACE_ROOT (DEP-13); bind mount host menutupinya saat compose
# berjalan, dan kepemilikan sisi host tetap urusan setup (K-06).
RUN mkdir -p /app /workspace && chown node:node /app /workspace

WORKDIR /app

# package.json WAJIB ada di runtime: readServerVersion (server.ts)
# membacanya dari ../package.json relatif terhadap dist/server.js.
# node_modules produksi dan dist/ berasal dari stage build.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# Berkas migrasi SQL berversi + jurnal, disalin utuh dari konteks
# build (tidak diubah oleh build). migrate.ts menyelesaikan folder
# migrasi relatif terhadap dist/db/migrate.js, sehingga drizzle/
# WAJIB duduk di samping dist/ (catatan deployment di migrate.ts).
COPY --chown=node:node drizzle/ ./drizzle/

# Nilai default non-secret, sama dengan yang dipaksa compose DEP-13
# lewat environment (environment compose menang atas ENV image).
# DATABASE_URL dan semua secret TIDAK ada di sini; hanya via env
# saat run (env_file api.env di DEP-13).
ENV HOST="0.0.0.0" \
    PORT="3001" \
    WORKSPACE_ROOT="/workspace"

EXPOSE 3001

# Probe liveness, disalin dari healthcheck service api compose DEP-13.
# Bentuk node/fetch dipakai karena image runner Node tidak dijamin
# menyediakan curl/wget (alasan DEP-13/V1-07). D-W4 tetap terbuka.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health/live').then(function (r) { process.exit(r.ok ? 0 : 1); }).catch(function () { process.exit(1); });"

USER node

# ENTRYPOINT [] eksplisit (F-03, AD-131 butir 2): menghapus ENTRYPOINT
# yang diwarisi dari base image node, sehingga proses container persis
# CMD di bawah tanpa pembungkus entrypoint. Bentuk exec agar SIGTERM/
# SIGINT sampai ke proses node (server.ts menangani keduanya untuk
# shutdown bersih). Sama dengan script start di server/package.json:
# node dist/server.js. Command default adalah server (F10 bagian 5.2,
# DEP-13); override command tetap mungkin.
ENTRYPOINT []

CMD ["node", "dist/server.js"]
