# Runbook: keluar dari mode probe-saja watchdog tunnel

Mode probe-saja adalah keadaan watchdog tunnel sesudah `PROBEONLY_AFTER`
upaya restart gagal berturut-turut (default 3). Dalam keadaan ini watchdog
tetap melakukan probe, tetapi menunda restart tunnel sampai satu probe
sehat tercatat atau reset eksplisit dilakukan. Mode ini adalah pengaman
anti-loop restart, bukan kegagalan skrip.

Dokumen ini berlaku untuk `notegen-tunnel-watchdog.sh` sesudah perbaikan
S-P0-10 (semantik AD-170). Skrip compose tidak punya mode probe-saja.

## Berkas state

Direktori default: `$HOME/workspace/notegen-watchdog-logs/state`
(`NOTEGEN_LOG_DIR` mengubah direktori log, dan direktori state mengikuti).

| Berkas | Arti |
|---|---|
| `tunnel-probe-only` | Penanda mode probe-saja aktif. Ada = aktif. |
| `tunnel-count` | Hitung upaya restart gagal berturut-turut (`COUNT=` + `FIRST_FAIL=`). |
| `tunnel-prev` | Verdict run terakhir. Reset TIDAK mengubah berkas ini. |

Bila run memakai `NOTEGEN_LOG_DIR` kustom, pakai nilai yang sama saat
memeriksa atau mereset; memeriksa direktori default saat run memakai
direktori lain hanya memeriksa state yang salah.

## Jalan keluar otomatis (tanpa intervensi)

Mode probe-saja berakhir sendiri lewat kode bila salah satu tercapai:

1. Probe publik valid (ready sehat lewat jalur publik), atau
2. Probe 401 pola origin AD-170 + probe internal sehat (kriteria sukses
   S-P0-10: 401 origin membuktikan tunnel mengantarkan jawaban origin).

Log mencatat `mode probe-saja berakhir` pada run yang keluar dari mode.
Bila tidak satu pun tercapai, mode bertahan sampai reset eksplisit.

## Reset eksplisit (cara yang dianjurkan)

Jalankan di host yang sama dengan tempat run watchdog berjalan, dengan
environment yang sama (terutama `NOTEGEN_LOG_DIR` bila dikustom):

```sh
bash infra/watchdog/notegen-tunnel-watchdog.sh --reset-probe-only
```

Flag ini menghapus penanda, mereset hitung ke 0, mencatat ke log, lalu
keluar dengan exit 0. Flag ini TIDAK melakukan probe apa pun, TIDAK
me-restart tunnel, dan TIDAK mengubah riwayat verdict. Flag ini aman
dijalankan walau mode probe-saja sedang tidak aktif (idempotent).

Verifikasi sesudah reset:

```sh
ls "$HOME/workspace/notegen-watchdog-logs/state/"
grep "reset mode probe-saja" "$HOME/workspace/notegen-watchdog-logs/notegen-tunnel-watchdog-$(TZ=Asia/Jakarta date +%F).log"
```

Penanda `tunnel-probe-only` harus sudah tidak ada, dan berkas
`tunnel-count` harus memuat `COUNT=0`.

## Reset manual (bila skrip tidak dapat dijalankan)

Hanya bila skrip tidak dapat dijalankan sama sekali, dan hanya saat tidak
ada run watchdog yang sedang berjalan:

```sh
rm -f "$HOME/workspace/notegen-watchdog-logs/state/tunnel-probe-only"
rm -f "$HOME/workspace/notegen-watchdog-logs/state/tunnel-count"
```

Menghapus `tunnel-count` setara dengan hitung 0: run berikutnya membaca
hitung 0 bila berkas tidak ada. Jangan mengedit isi berkas state dengan
tangan selain prosedur ini; penulisan state normal memakai tulis atomik
oleh skrip. Catat reset manual di log insiden (waktu, pelaku, alasan),
karena reset manual tidak meninggalkan jejak di log watchdog.

## Kapan reset dilarang atau sia-sia

- Jangan reset untuk menyembunyikan kegagalan berulang. Bila penyebab
  (tunnel mati, origin bermasalah, launcher hilang) belum diperbaiki,
  tiga episode berikutnya akan mengaktifkan lagi mode probe-saja.
- Reset tidak memperbaiki apa pun selain keadaan mode; ia bukan pengganti
  diagnosis. Periksa log run terakhir sebelum reset.
- Reset tidak mengaktifkan cron. Cron watchdog tetap nonaktif sampai
  diputus bersama laporan Fase 1 + keputusan opsi B (AD-201 butir 6);
  run watchdog sampai saat itu tetap manual.
