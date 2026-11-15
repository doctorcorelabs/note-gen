# Generator registrasi rute (AD-61, tingkat rute)

Generator: `scripts/generate-registration.mjs`. Keluaran:
`server/src/routes-generated.ts`. Tanpa dependensi baru, pustaka standar
Node saja (`node:fs`, `node:path`, `node:url`).

## Putusan lokasi (O-GEN-1)

Generator tinggal di `scripts/` pada root repo, mengikuti prototipe rf2
(`web-registration-proto-v3brf2`) dan konvensi repo (runner `.mjs` lain
tinggal di `scripts/`, misalnya `run-adapter-tests.mjs`). `ROOT`
diturunkan dari lokasi berkas skrip, tanpa hardcode path rumah pekerja,
sehingga generator dapat dijalankan CI atas tree sembarang dan menjadi
gate drift.

## Cara jalan

```sh
node scripts/generate-registration.mjs            # tulis routes-generated.ts
node scripts/generate-registration.mjs --check    # gagal bila berkas ter-check-in berbeda
```

Jangan pernah mengedit `routes-generated.ts` secara manual, termasuk
saat menyelesaikan konflik merge: buang isi yang berkonflik, lalu
regenerate. Commit memuat adapter tulisan tangan plus keluaran
tergenerasi dalam commit yang sama, dan `--check` dijalankan sebelum
push sebagai pemeriksaan mandiri.

## Kontrak adapter (masukan)

Satu adapter per kelompok di `server/src/routes/<grup>.registration.ts`,
dengan tiga ekspor wajib yang namanya persis:

```ts
export const REGISTRATION_ID = '<grup>' as const;
export const REGISTRATION_ORDER = <bilangan bulat 1-9999>;
export async function registerGroup(ctx: RegistrationContext): Promise<void> { ... }
```

`REGISTRATION_ID` wajib sama persis dengan stem nama berkas.
`REGISTRATION_ORDER` wajib unik; tabel rank yang berlaku ada di
`fase1/desain-registrasi-programatik.md` seksi 3.3 (rank 10-160
bercelah, health 10 pertama). Adapter dilarang mengimpor adapter lain.
Generator hanya membaca ketiga ekspor itu dengan regex dan tidak pernah
mengeksekusi kode adapter. Generator tidak menyimpulkan deps, kondisi,
atau urutan dari kode registrar: ia hanya merakit adapter berurutan
sesuai rank, dengan `await` sekuensial.

## Gagal keras (fail-closed)

Generator keluar 1 dan tidak menulis apa pun bila: tidak ada adapter;
`REGISTRATION_ID` hilang, bukan string literal `as const`, atau tidak
cocok dengan nama berkas; `REGISTRATION_ORDER` hilang, bukan bilangan
bulat, atau di luar 1-9999; rank duplikat; ID duplikat; `registerGroup`
hilang; adapter mengimpor adapter lain; tabrakan alias impor; direktori
atau berkas masukan tidak dapat dibaca; atau keluaran memuat em dash.
Tidak ada peringatan yang mengizinkan kelanjutan. Pesan kegagalan
menyebut berkas dan alasan, memakai path relatif repo.

## Determinisme

Keluaran byte-identik antar run atas tree yang sama: masukan diurutkan,
adapter diurutkan berdasarkan `(REGISTRATION_ORDER, REGISTRATION_ID)`,
tanpa stempel waktu, tanpa pembacaan env, tanpa urutan filesystem tanpa
pengurutan. Bentuk byte keluaran mengikuti desain seksi 8.2/8.3: header
SPDX + GENERATED, satu impor tipe `RegistrationContext`, satu baris
impor per adapter, satu fungsi `registerRouteGroups`, tepat satu
newline di akhir berkas, LF semata.

## Batas scope increment ini

Skrip ini adalah tingkat rute saja. Tingkat pemindaian handler db
(`handlers.generated.ts`, desain seksi 8.1) adalah increment terpisah
dan sengaja tidak diimplementasikan di sini; skrip ini tidak membaca
berkas handler dan mode `--check`-nya hanya menjaga
`routes-generated.ts`. Duplikat method+path antar kelompok juga bukan
tugas generator ini (desain seksi 2.1): duplikat tingkat adapter
(rank, ID, alias) digagalkan di sini, sedangkan duplikat rute
ditangkap Fastify saat boot dan harness dump ekuivalensi.
