# Pin Review: Bundel Template Lokal (AD-15)

Bundel ini adalah satu-satunya sumber template provider dan rekomendasi skill.
Tidak ada fetch runtime ke Config Center. Bundel hanya berubah lewat rilis fork
yang ditinjau. Dokumen ini menggantikan config-manifest.json yang hanya berisi
URL remote dan telah dihapus.

- Tanggal peninjauan: 2026-11-17
- Peninjau: pekerja W4-HARDEN r12 (gelombang 4)
- Komit dasar peninjauan: 18c54f024f7db06e4f4e145f19f738b4757e7f7b
- Hasil: LULUS

## Berkas ter-pin

| Berkas | versionCode asal | versionName asal | Jumlah entri akhir | SHA-256 sesudah peninjauan |
|---|---|---|---|---|
| config/provider-templates.json | 107 | 1.0.7 | 28 | a39d49201b11a497808a054e22588f288fc88da7aafe3a5b2b90fa410eb62aa2 |
| config/provider-templates-cn.json | 107 | 1.0.7-cn | 27 | 9388af108da8f289f0a7af1b662a5814fca4fd9e43cc922d440bff3a967ab7e3 |
| config/recommended-skills.json | 100 | 1.0.0 | 8 | bad12f88808ab02ed8c125f282d287cc97ceaf7b5bd926801883faf0f9970b45 |

## Berkas yang tidak lagi di-pin (dihapus dari bundel)

| Berkas | versionCode asal | versionName asal | Alasan |
|---|---|---|---|
| config/notegen-model-policy.json | 101 | 1.0.1 | Hanya melayani logika batas sponsor; dihapus bersama AD-15. |
| config/notegen-default-models.json | 103 | 1.0.3 | Hanya melayani penyuntikan model default sponsor; dihapus bersama AD-15. |
| config/config-manifest.json | - | - | Hanya berisi URL remote Config Center; diganti dokumen ini. |

## Perubahan peninjauan

URL afiliasi asal tidak dikutip di dokumen ini. Kolom perubahan mencatat
host asal dan URL generik sesudah netralisasi, atau `dihapus` bila tidak ada
URL generik yang jelas. Netralisasi berarti: HTTPS, tanpa userinfo, tanpa
query, tanpa fragmen, hanya origin + path konsol generik.

| Berkas | Kunci provider/skill | Perubahan |
|---|---|---|
| config/provider-templates.json | siliconflow | Hapus sponsored; netralkan apiKeyUrl (host asal cloud.siliconflow.cn, path asal berupa tautan undangan) ke https://cloud.siliconflow.cn/ |
| config/provider-templates.json | aihubmix | Hapus sponsored; netralkan apiKeyUrl (host asal aihubmix.com) ke https://aihubmix.com/ |
| config/provider-templates.json | packycode | Netralkan apiKeyUrl (host asal www.packyapi.ai) ke https://www.packyapi.ai/register |
| config/provider-templates.json | infistar | Netralkan apiKeyUrl (host asal www.infistar.cc) ke https://www.infistar.cc/register |
| config/provider-templates.json | qiuqiutoken | Hapus apiKeyUrl (tautan pendek, tanpa URL generik jelas) |
| config/provider-templates.json | shengsuanyun | Netralkan apiKeyUrl (host asal www.shengsuanyun.com) ke https://www.shengsuanyun.com/ |
| config/provider-templates.json | bailian | Netralkan apiKeyUrl (host asal bailian.console.aliyun.com) ke https://bailian.console.aliyun.com/ |
| config/provider-templates.json | minimax | Netralkan apiKeyUrl (host asal platform.minimaxi.com) ke https://platform.minimaxi.com/subscribe/token-plan |
| config/provider-templates.json | qianfan | Netralkan apiKeyUrl (host asal console.bce.baidu.com) ke https://console.bce.baidu.com/iam/ |
| config/provider-templates.json | huaweicloud | Netralkan apiKeyUrl (host asal console.huaweicloud.com) ke https://console.huaweicloud.com/modelarts/ |
| config/provider-templates.json | qiniu | Hapus apiKeyUrl (tautan pendek, tanpa URL generik jelas) |
| config/provider-templates.json | 302 | Hapus apiKeyUrl (tautan berbagi berkode, tanpa URL generik jelas) |
| config/provider-templates.json | ucloud | Netralkan apiKeyUrl (host asal www.compshare.cn) ke https://www.compshare.cn/coding-plan |
| config/provider-templates-cn.json | siliconflow | Hapus sponsored; netralkan apiKeyUrl (host asal cloud.siliconflow.cn, path asal berupa tautan undangan) ke https://cloud.siliconflow.cn/ |
| config/provider-templates-cn.json | aihubmix | Hapus sponsored; netralkan apiKeyUrl (host asal aihubmix.com) ke https://aihubmix.com/ |
| config/provider-templates-cn.json | packycode | Hapus promotion; netralkan apiKeyUrl (host asal www.packyapi.ai) ke https://www.packyapi.ai/register |
| config/provider-templates-cn.json | infistar | Hapus promotion; netralkan apiKeyUrl (host asal www.infistar.cc) ke https://www.infistar.cc/register |
| config/provider-templates-cn.json | qiuqiutoken | Hapus apiKeyUrl (tautan pendek, tanpa URL generik jelas) |
| config/provider-templates-cn.json | shengsuanyun | Netralkan apiKeyUrl (host asal www.shengsuanyun.com) ke https://www.shengsuanyun.com/ |
| config/provider-templates-cn.json | bailian | Netralkan apiKeyUrl (host asal bailian.console.aliyun.com) ke https://bailian.console.aliyun.com/ |
| config/provider-templates-cn.json | minimax | Netralkan apiKeyUrl (host asal platform.minimaxi.com) ke https://platform.minimaxi.com/subscribe/token-plan |
| config/provider-templates-cn.json | qianfan | Netralkan apiKeyUrl (host asal console.bce.baidu.com) ke https://console.bce.baidu.com/iam/ |
| config/provider-templates-cn.json | huaweicloud | Netralkan apiKeyUrl (host asal console.huaweicloud.com) ke https://console.huaweicloud.com/modelarts/ |
| config/provider-templates-cn.json | qiniu | Hapus apiKeyUrl (tautan pendek, tanpa URL generik jelas) |
| config/provider-templates-cn.json | 302 | Hapus apiKeyUrl (tautan berbagi berkode, tanpa URL generik jelas) |
| config/provider-templates-cn.json | ucloud | Netralkan apiKeyUrl (host asal www.compshare.cn) ke https://www.compshare.cn/coding-plan |
| config/recommended-skills.json | (semua 8 skill) | Tanpa perubahan isi. schemaVersion 1 terverifikasi; seluruh sourceUrl HTTPS tanpa userinfo. |

Entri yang dibuang peninjauan: 0. Seluruh entri dipertahankan; yang berubah
hanya field sponsored/promotion/apiKeyUrl seperti tabel di atas.

## Pemeriksaan

- Field apiKey pada bundel: 0.
- Entri dengan baseURL gateway bersama: 0.
- Entri sponsored atau promotion pada bundel: 0.
- Entri dibuang loader saat verifikasi: 0.
- Pengecualian loopback: ollama localhost:11434 dan lmstudio localhost:1234,
  server-side saja, label UI "lokal di server". Tidak ada pengecualian HTTP lain.
- Keterbatasan tercatat (risiko R7 desain H4-KEY): URL ikon template tetap
  menunjuk host pihak ketiga yang ter-pin dan wajib HTTPS. Migrasi ikon ke
  hosting lokal adalah tindak lanjut terpisah, bukan bagian gelombang 4.
