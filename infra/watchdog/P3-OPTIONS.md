# P-3: opsi perbaikan struktural watchdog tunnel (TIDAK DIPUTUS)

Status: P-3 TIDAK diputus (AD-201 butir 7). Dokumen ini hanya menyiapkan
opsi + patch siap-pakai. Cabang ini TIDAK mengubah kode watchdog apa pun:
tidak ada perubahan pada `notegen-tunnel-watchdog.sh`,
`notegen-compose-watchdog.sh`, atau `README.md`. Patch per opsi hidup di
luar trunk, di `fase1/r24-patches/wd3d/` pada workspace perencanaan
(note-gen-fork), dan hanya diterapkan sesudah parent memutus satu opsi.

Bacaan: AD-187 butir 1, AD-190 butir 3, AD-195 (F-ABC-A2), AD-201 butir 7,
DA18-K02, DA18-K03, DA18-N06, handoff #23 seksi 6 (P-3).

## 1. Masalah

Skrip tunnel sebagaimana dikodekan pada trunk `afaba68b` membutuhkan
KEDUANYA pada host yang sama:

- berkas service token, dibaca lokal (`NOTEGEN_TOKEN_FILE`, default
  `$HOME/.config/notegen-tunnel/service-token` pada host pelaksana);
- helper `ib.py`, dijalankan lokal lewat `python3` untuk diagnosis
  internal + launcher tunnel (`NOTEGEN_IB_PY`).

Token hanya ada di muse-2; `ib.py` hanya ada di VM operator (helper
konektor; tidak terpasang di muse-2). Tidak ada host yang memiliki
keduanya, sehingga tidak ada host yang dapat menjalankan skrip tunnel
sampai selesai sebagaimana dikodekan (DA18-K03).

Bukti jalan:

- P-1 membuktikan kaki probe dari muse-2 (adaptasi AD-170) dan kaki
  compose dari VM operator, tetapi kaki restart tunnel oleh watchdog
  tetap tidak terbukti (AD-190, AD-196, AD-200 butir 2a).
- F-ABC-A2: watchdog tunnel dari muse-2 tidak dapat menyelesaikan
  diagnosis atas probe luar non-401 (502 saat api mati); exit 1, tanpa
  tindakan, fail-closed (AD-195 butir 5).
- Menyalin service token ke VM Muse DILARANG (AD-187 butir 1). Jalan
  keluar yang memindahkan nilai token ke VM operator bukan opsi yang
  disiapkan di sini (lihat seksi 5, Opsi C).

Sub-butir bersama, bukan opsi tersendiri: F-02. Default trunk
`NOTEGEN_TUNNEL_LAUNCHER` menunjuk
`/data/home/notegen-tunnel/notegen-tunnel.sh`, yang tidak ada; yang
terpasang adalah `/data/home/notegen-tunnel/start-tunnel.sh`
(DA18-K02). Workaround env berdiri. Kedua patch opsi memuat perbaikan
default satu baris yang sama. Perbaikan itu hanya boleh mendarat SATU
kali, bersama opsi yang diputus (atau lewat kendaraan terpisah bila
parent memutus demikian). Kedua patch bersifat alternatif yang saling
meniadakan: JANGAN pernah menerapkan keduanya.

## 2. Opsi A: mode lokal (jalan DI muse-2)

Patch: `p3-option-a-local-mode.patch` (di `fase1/r24-patches/wd3d/`).

Gagasan: skrip berjalan DI muse-2 dengan `NOTEGEN_LOCAL_MODE=1`.
Diagnosis internal + launcher dijalankan lokal lewat `bash`, tanpa
`ib.py`, lewat dispatcher `exec_target` yang memakai `local_exec` pada
mode lokal dan `remote_exec` pada mode default. Default
(`NOTEGEN_LOCAL_MODE=0`) tidak berubah: jalan dari VM operator lewat
`ib.py`.

Yang berubah pada patch:

- Variabel `NOTEGEN_LOCAL_MODE` (default 0) + normalisasi + pencatatan
  `local_mode=` pada baris `run_start`.
- Fungsi `local_exec` (mengisi variabel yang sama dengan `remote_exec`:
  `REMOTE_PAYLOAD`, `REMOTE_PAYLOAD_OK`, `EXEC_CLASS`, `EXEC_EXIT`,
  `REMOTE_STDERR`) + dispatcher `exec_target`.
- Dua titik panggil (`remote_exec` untuk gather dan launcher) beralih
  ke `exec_target`; alur utama lain tidak berubah.
- Pesan `log_exec_failure` mengikuti mode (lokal vs jarak jauh),
  agar log tidak salah label pada mode lokal.
- Default launcher diperbaiki ke `start-tunnel.sh` (F-02, seksi 1).

Yang TIDAK berubah: pembacaan token (lokal, di muse-2, sesuai AD-187),
templat gather/launch, aturan probe-saja, jatah, dan semantik exit.
Kegagalan eksekusi lokal dipetakan ke exit 1 (fail-closed, tanpa
tindakan atas diagnosis yang tidak terbukti), sejajar jalur transient
remote. `local_exec` tidak pernah memakai exit 3 (tidak ada konsep VM
tidak terjangkau dari dalam host itu sendiri); cabang exit 3 pada alur
utama menjadi tidak terjangkau pada mode lokal.

Prasyarat + pertanyaan terbuka:

- Apakah daemon cron (atau timer setara) berjalan di muse-2? DA18-K03
  mencatat pertanyaan ini TERBUKA: dokumen konektor menyatakan muse-2
  tidak punya cron (bagian historis), tetapi WATCHDOG-RO C2 membaca
  crontab muse-2 dengan 2 baris aktif; keberadaan berkas crontab tidak
  membuktikan daemon berjalan. Verifikasi baca-saja oleh operator
  wajib sebelum aktivasi mode lokal. Tanpa daemon cron, mode lokal
  butuh penjadwal lain yang diputus terpisah.
- Penempatan berkas di muse-2: salinan skrip, direktori log/state
  (`$HOME/workspace/notegen-watchdog-logs` pada muse-2, sesuai lokasi
  log P-1 yang diterima F-04), dan berkas `MAINTENANCE` hidup di
  muse-2 untuk watchdog tunnel, sementara watchdog compose tetap di VM
  operator. Fragmentasi state/log/MAINTENANCE antar-host (DA18-N12)
  tetap berlaku: prosedur pemeliharaan wajib mencakup KEDUA host.
- Mode lokal yang keliru dijalankan di VM operator akan memprobe
  loopback host yang salah dan gagal fail-closed (exit 1); tidak ada
  tindakan berbahaya, tetapi run-nya sia-sia. Prosedur instalasi wajib
  menyatakan host pelaksana secara eksplisit per watchdog.

Verifikasi sesudah putusan (belum dijalankan): `git apply --check`,
`bash -n`, `test-token-format.sh` dari checkout, jalan manual P-1
tanpa override env launcher, lalu Uji C penuh atau scoped sesuai
putusan (handoff #23, P-5).

## 3. Opsi B: probe publik jarak jauh (jalan di VM operator)

Patch: `p3-option-b-remote-probe.patch` (di `fase1/r24-patches/wd3d/`).

Gagasan: skrip tetap berjalan di VM operator dengan
`NOTEGEN_REMOTE_PROBE=1`. Probe publik dijalankan DI muse-2 lewat
`ib.py`: token dibaca dari berkas di muse-2 dan nilainya TIDAK PERNAH
kembali ke VM operator (hanya kode HTTP + body yang kembali lewat
payload berpenanda). Diagnosis + launcher tetap lewat `ib.py` seperti
biasa. Default (`NOTEGEN_REMOTE_PROBE=0`) tidak berubah: token dibaca
lokal dan probe dijalankan lokal.

Yang berubah pada patch:

- Variabel `NOTEGEN_REMOTE_PROBE` (default 0) +
  `NOTEGEN_REMOTE_TOKEN_FILE` (default
  `/data/home/.config/notegen-tunnel/service-token`) + validasi jalur
  absolut pada mode remote + pencatatan `remote_probe=` pada baris
  `run_start`.
- Templat probe jarak jauh (POSIX sh): baca berkas token di muse-2,
  validasi bentuk cermin `token_line_rejected` (dengan pengencangan
  yang disengaja: CR di tengah baris ditolak; jalur lokal tidak
  menolaknya), lalu `curl` di sana.
- `probe_public_remote` + `parse_probe_payload`: kegagalan eksekusi
  probe jarak jauh atau payload tidak dikenal dipetakan ke kode 000
  dan alur lanjut ke diagnosis internal (sejajar kegagalan `curl`
  lokal); token jarak jauh yang buruk dipetakan ke exit 2 (kredensial,
  tanpa probe), sejajar `load_token` lokal.
- Cabang kredensial pada alur utama hanya berlaku pada mode remote;
  jalur lokal (`REMOTE_PROBE=0`) memanggil `probe_public` persis
  seperti trunk, tanpa cabang baru.
- Default launcher diperbaiki ke `start-tunnel.sh` (F-02, seksi 1).

Yang TIDAK berubah: token tidak pernah masuk perintah jarak jauh
(dibaca dari berkas di sisi jauh) dan tidak pernah masuk keluaran;
templat gather/launch, aturan probe-saja, jatah, dan semantik exit
lain tidak berubah.

Prasyarat + pertanyaan terbuka:

- Default `NOTEGEN_REMOTE_TOKEN_FILE` mengasumsikan `HOME=/data/home`
  di muse-2 (konsisten dengan `NOTEGEN_PROJECT_DIR` dan lokasi log
  P-1, tetapi asumsi ini wajib dikonfirmasi operator sebelum pakai;
  override lewat env bila berbeda). Jalur wajib absolut; jalur
  relatif ditolak pada validasi konfigurasi.
- Setiap run memakai satu `remote_exec` tambahan untuk probe (timeout
  probe + 15 detik). Bila `ib.py` gagal, probe jarak jauh dan diagnosis
  gagal pada akar penyebab yang sama; klasifikasi kegagalan eksekusi
  probe ditelan ke kode 000 dan klasifikasi definitif datang dari
  diagnosis. Perilaku ini disengaja dan dicatat di sini, bukan
  kegagalan diam-diam: log mencatat peringatan probe jarak jauh.
- Body probe jarak jauh dilipat ke satu baris (`tr -d`), sementara
  jalur lokal mempertahankan baris baru. Validator JSON tidak peka
  pada perbedaan ini; perbedaan dicatat sebagai divergensi jinak.
- Mode remote tetap membutuhkan `ib.py` di VM operator dengan mode
  executable yang benar (F-01, DA18-K04: mode 760 yang disyaratkan).

Verifikasi sesudah putusan (belum dijalankan): `git apply --check`,
`bash -n`, `test-token-format.sh` dari checkout (jalur lokal), jalan
manual P-1 tanpa override env launcher, jalan manual mode remote
dengan berkas token jarak jauh yang dikonfirmasi, lalu Uji C penuh
atau scoped sesuai putusan (handoff #23, P-5).

## 4. Perbandingan

| Aspek | Opsi A (mode lokal) | Opsi B (probe jarak jauh) |
|---|---|---|
| Host jalan skrip | muse-2 | VM operator |
| Token dibaca di | muse-2 (lokal) | muse-2 (lewat ib.py) |
| Nilai token ke operator | tidak ada | tidak ada |
| Diagnosis + launcher | lokal (bash) | lewat ib.py |
| Butuh ib.py | tidak (mode lokal) | ya |
| Butuh daemon cron di muse-2 | ya (belum terverifikasi) | tidak |
| State/log tunnel | di muse-2 | di VM operator |
| Exit 3 (VM tak terjangkau) | tidak terjangkau | berlaku seperti trunk |
| Titik kegagalan baru | penjadwalan di muse-2 | satu remote_exec probe per run |

Kedua opsi mempertahankan larangan salin token (AD-187), mempertahankan
fail-closed, dan mempertahankan default trunk bila variabel barunya
tidak diset.

## 5. Opsi C: cabut larangan salin (DICATAT, TIDAK DIUSULKAN)

DA18-N06 mencatat jalan keluar ketiga: mencabut larangan salin dengan
kontrol kompensasi. Jalan ini adalah putusan keamanan user, BUKAN
rekomendasi DA-18, dan TIDAK disiapkan patch-nya di sini. Bila parent
membuka kembali jalan ini, putusannya wajib terpisah, eksplisit, dan
didahului penilaian keamanan; tidak ada pekerjaan ronde ini yang
bergantung padanya.

## 6. Pertanyaan putusan untuk parent

1. Opsi A atau Opsi B (atau Opsi C lewat jalur putusan keamanan
   terpisah)? Putusan memengaruhi penerimaan watchdog tunnel +
   penjadwalan Uji C (handoff #23, P-3/P-5).
2. Untuk Opsi A: apakah daemon cron di muse-2 terverifikasi berjalan
   (baca-saja, oleh operator)? Bila tidak, penjadwal apa yang dipakai?
3. Untuk Opsi B: apakah asumsi `HOME=/data/home` untuk berkas token
   jarak jauh dikonfirmasi? Bila tidak, jalur kanonisnya apa?
4. Apakah perbaikan default launcher F-02 mendarat bersama opsi yang
   diputus, atau lewat kendaraan terpisah? (Hanya satu kali.)
5. Bagaimana interaksi putusan ini dengan semantik exit 2 di bawah
   AD-170 (DA18-N01: exit 2 menjadi keadaan tunak; kontrak pelaporan
   cron)? Putusan semantik itu terpisah dan tetap terbuka.
6. Bagaimana prosedur MAINTENANCE/state dua-host (DA18-N12) ditulis
   untuk penempatan yang diputus, sebelum aktivasi cron apa pun?
   Aktivasi cron sendiri tetap dilarang sampai putusan bersama laporan
   Fase 1 + keputusan opsi B (AD-201 butir 6).

## 7. Cara menerapkan patch yang diputus (sesudah putusan)

1. Dari trunk `afaba68b` (atau trunk yang dinyatakan setara oleh
   koordinator; patch dibuat terhadap blob `0e1ab0a`):
   `git apply --check fase1/r24-patches/wd3d/p3-option-<a|b>-*.patch`.
2. Terapkan SATU patch saja. Jangan pernah menerapkan keduanya.
3. `bash -n infra/watchdog/notegen-tunnel-watchdog.sh` wajib lulus.
4. Jalankan `test-token-format.sh` dari checkout.
5. Jalan manual P-1 tanpa override env launcher; catat identitas
   salinan + lokasi log seperti protokol P-1.
6. Uji C (penuh atau scoped) sesuai putusan P-3 + go segar + baseline
   segar (handoff #23, P-5). Leg restart dilaporkan apa adanya.

Riwayat patch: kedua patch berasal dari salvage 2 patch WD3 di
`fase1/r24-patches/wd3/`, diperbaiki oleh pekerja WD3D (penangkapan
stderr lokal + label log mengikuti mode pada Opsi A; pelingkupan
cabang kredensial ke mode remote pada Opsi B; klarifikasi komentar
pada keduanya). Alasan per patch dicatat penuh pada
`fase1/laporan-r24-wd3d.md`. Versi di `fase1/r24-patches/wd3d/`
menggantikan versi di `fase1/r24-patches/wd3/`; versi lama tidak boleh
dipakai lagi.
