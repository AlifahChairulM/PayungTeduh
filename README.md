# PayungTeduh — Sistem Loker Payung Otomatis Berbasis IoT

**Tema Proyek:** Smart Umbrella Sharing Locker

## Gambaran Umum Proyek

**PayungTeduh** adalah ekosistem loker pintar otomatis berbasis Internet of Things (IoT) yang dirancang untuk menjawab kebutuhan mobilitas di lingkungan kampus maupun ruang publik saat cuaca tidak menentu. Sistem ini mengintegrasikan perangkat keras mikrokontroler **ESP32** dengan aplikasi web *real-time* untuk menghadirkan dua layanan utama dalam satu unit loker terpadu: **penyewaan payung siap pakai (*umbrella sharing*)** dan **penitipan payung pribadi**.

Melalui integrasi sensor fisik dan layanan cloud, pengguna dapat memantau ketersediaan stok payung sewa maupun slot penitipan kosong secara langsung sebelum bertransaksi. Setiap akses pintu loker diamankan melalui kombinasi tombol aktivasi fisik, pemindaian **NFC/RFID (MFRC522)**, serta verifikasi **kode OTP 4 digit** sekali pakai. Setelah pengguna mengambil atau menyimpan payung, sistem secara otomatis mendeteksi penutupan pintu melalui **Limit Switch** dan menguncinya kembali menggunakan **Motor Servo SG90**.

---

## Arsitektur & Cara Kerja Sistem

Sistem **PayungTeduh** dibangun di atas tiga lapisan utama yang saling berkomunikasi secara dua arah dan *real-time*:

### 1. Lapisan Perangkat Keras (`firmware/PayungTeduh.ino`)
Seluruh kendali fisik pada unit loker dijalankan oleh mikrokontroler **ESP32 DevKit V1**. Pada setiap slot loker terpasang satu unit **sensor inframerah (IR)** yang terus memantau keberadaan objek payung di dalam kompartemen dan mengirimkan perubahan statusnya ke server setiap detik. Untuk mencegah akses tanpa izin, pengguna harus menekan **Push Button** fisik terlebih dahulu guna mengaktifkan mode tunggu selama 60 detik, lalu menempelkan ponsel berfitur NFC ke **Reader MFRC522** sebelum melanjutkan transaksi di web.

Selain membaca NFC ponsel, modul MFRC522 juga berfungsi mengenali UID stiker RFID yang tertempel pada payung sewa untuk mempercepat proses pengembalian tanpa perlu membuka formulir web. Ketika perintah buka kunci diterima, **Motor Servo SG90** pada slot terkait akan berputar ke sudut **90°** selama maksimal 60 detik. Begitu pengguna menutup pintu dan menekan **Limit Switch**, layar **OLED 0.96" (SSD1306)** akan menampilkan hitung mundur selama 5 detik disertai indikator suara **Buzzer** sebelum servo kembali ke sudut **0°** untuk mengunci pintu dengan aman.

### 2. Lapisan Backend, Broker MQTT, & Database (`server.js`)
Sisi server dibangun menggunakan **Node.js** dan **Express.js v5** yang bertindak sebagai jembatan antara perangkat keras di lapangan dan antarmuka pengguna di browser. Komunikasi dengan ESP32 berlangsung secara asinkron melalui protokol **MQTT** menggunakan broker publik HiveMQ (`broker.hivemq.com`), di mana server mendengarkan telemetri pada topik `umbllocker/status` dan mengirimkan instruksi aktuasi pintu maupun pembaruan teks layar OLED melalui topik `umbllocker/command`.

Seluruh data pengguna, status slot loker, riwayat transaksi, dan kode OTP disimpan secara relasional di **PostgreSQL (Supabase)**. Untuk memastikan informasi ketersediaan loker dan status pintu pada browser selalu sinkron tanpa perlu memuat ulang halaman (*refresh*), server memanfaatkan teknologi **Server-Sent Events (SSE)** melalui *endpoint* `/api/events`.

### 3. Lapisan Antarmuka Web & Manajemen Admin (`web/`)
Antarmuka web dirancang ringan dan responsif menggunakan HTML5, Tailwind CSS, dan Vanilla JavaScript. Pada halaman utama (`web/index.html` dan `web/js/app.js`), pengguna disambut oleh tabel *Ketersediaan Loker Live* sebelum masuk ke mode layanan untuk melakukan penyewaan, penitipan, pengembalian payung, maupun pengambilan barang titipan lengkap dengan simulasi pemotongan saldo dan struk digital.

Sementara itu, pengelola sistem dapat mengakses halaman **Dashboard Administrator** (`web/admin.html`) yang dilindungi kata sandi. Melalui panel ini, admin dapat memantau pembacaan sensor IR tiap slot secara langsung, mengelola data penyewa aktif maupun riwayat transaksi (menyelesaikan transaksi secara manual, menyunting data, atau menghapus rekaman), serta melakukan pembukaan pintu loker secara darurat (*emergency unlock*).

---

## Struktur Direktori Proyek

Agar memudahkan navigasi kode sumber, repositori ini diorganisasikan ke dalam struktur direktori sebagai berikut:

```text
payung-teduh/
├── firmware/
│   └── PayungTeduh.ino       # Kode program mikrokontroler ESP32 (sensor, servo, OLED, MQTT)
├── web/
│   ├── css/
│   │   └── style.css         # Stylesheet kustom untuk transisi antarmuka web
│   ├── js/
│   │   └── app.js            # Logika frontend pengguna, listener SSE, & alur transaksi
│   ├── index.html            # Halaman utama pengguna (Sewa, Titip, Kembalikan, Ambil)
│   └── admin.html            # Halaman dashboard monitoring & CRUD administrator
├── .env                      # Konfigurasi kredensial environment (tidak diunggah ke Git)
├── .gitignore                # Daftar berkas/folder yang diabaikan oleh Git
├── package.json              # Definisi proyek Node.js dan daftar dependensi npm
├── package-lock.json         # Pengunci versi dependensi untuk instalasi yang konsisten
├── server.js                 # Server utama Express.js REST API, MQTT Client, & SSE
└── README.md                 # Dokumentasi teknis dan panduan penggunaan proyek
```

---

## Kebutuhan Perangkat & Pemetaan Pinout

### Kebutuhan Perangkat Lunak (*Software*)
Untuk menjalankan sistem ini secara mandiri, pastikan lingkungan pengembangan Anda telah dilengkapi dengan **Node.js** (versi 18 ke atas atau disarankan versi 22+), akun **Supabase** untuk database PostgreSQL, serta **Arduino IDE** dengan paket board `esp32` by Espressif Systems. Pada Arduino IDE, pasang pustaka (*library*) berikut melalui Library Manager: `PubSubClient`, `Adafruit_GFX`, `Adafruit_SSD1306`, `ESP32Servo`, dan `MFRC522`.

### Kebutuhan Perangkat Keras & Pinout ESP32
Unit loker menggunakan mikrokontroler **ESP32 DevKit V1** yang terhubung ke modul layar OLED 0.96" SSD1306 (alamat I2C `0x3C`) pada pin **GPIO 21 (SDA)** dan **GPIO 22 (SCL)**. Pembaca kartu RFID/NFC MFRC522 terhubung melalui antarmuka SPI standar pada pin **GPIO 5 (SDA/SS)**, **GPIO 4 (RST)**, **GPIO 18 (SCK)**, **GPIO 19 (MISO)**, dan **GPIO 23 (MOSI)**. Tombol aktivasi (*Push Button*) dipasang pada **GPIO 15** dengan mode `INPUT_PULLUP`, sedangkan *Active Buzzer* terhubung ke **GPIO 2**.

Adapun keempat kompartemen loker dipetakan ke pin GPIO ESP32 sesuai tabel berikut:

| Nama Slot | Kategori Layanan | Pin Servo SG90 | Pin Limit Switch | Pin Sensor IR |
| :--- | :--- | :--- | :--- | :--- |
| `SEWA_1` | Penyewaan Payung | GPIO 13 | GPIO 32 | GPIO 34 |
| `SEWA_2` | Penyewaan Payung | GPIO 12 | GPIO 33 | GPIO 35 |
| `TITIP_1` | Penitipan Payung | GPIO 14 | GPIO 25 | GPIO 36 (VP) |
| `TITIP_2` | Penitipan Payung | GPIO 27 | GPIO 26 | GPIO 39 (VN) |

---

## Panduan Instalasi & Konfigurasi Mandiri

Ikuti tahapan berurutan di bawah ini untuk menyalin repositori, menyiapkan basis data, menjalankan server backend, hingga mengunggah program ke mikrokontroler ESP32.

### 1. Mengunduh Repositori ke Lokal
Salin proyek ini ke komputer lokal Anda menggunakan perintah Git berikut:

```bash
git clone [https://github.com/username/nama-repositori.git]
cd nama-repositori-anda
```

### 2. Menyiapkan Basis Data di Supabase
Buat proyek baru di [Supabase](https://supabase.com/), kemudian buka menu **SQL Editor** dan jalankan skrip SQL berikut untuk membentuk keempat tabel utama, mengisi data awal 4 slot loker, serta menonaktifkan *Row Level Security* (RLS) agar server Express dapat melakukan operasi pembaruan dan penghapusan data secara penuh:

```sql
-- 1. Tabel Data Pengguna
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  nama_lengkap TEXT NOT NULL,
  email TEXT NOT NULL,
  bank_wallet TEXT NOT NULL,
  nomor_rekening TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabel Master Slot Loker
CREATE TABLE lockers (
  id SERIAL PRIMARY KEY,
  slot_name TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  is_occupied BOOLEAN DEFAULT FALSE,
  last_status_change TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabel Riwayat & Status Transaksi
CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  locker_id INTEGER REFERENCES lockers(id),
  type TEXT NOT NULL,
  biaya_layanan INTEGER NOT NULL,
  deposit_jaminan INTEGER NOT NULL,
  total_bayar INTEGER NOT NULL,
  waktu_tenggat TIMESTAMPTZ NOT NULL,
  waktu_kembali TIMESTAMPTZ,
  status_transaksi TEXT DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Tabel Kode OTP Verifikasi Sekali Pakai
CREATE TABLE otp_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  otp_code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- 5. Inisialisasi Data Awal 4 Slot Loker
INSERT INTO lockers (slot_name, category, is_occupied) VALUES
  ('SEWA_1', 'SEWA', TRUE),
  ('SEWA_2', 'SEWA', TRUE),
  ('TITIP_1', 'TITIP', FALSE),
  ('TITIP_2', 'TITIP', FALSE);

-- 6. Menonaktifkan RLS agar Operasi CRUD Backend Berjalan Lancar
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE lockers DISABLE ROW LEVEL SECURITY;
ALTER TABLE transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes DISABLE ROW LEVEL SECURITY;
```

### 3. Mengonfigurasi Variabel Lingkungan (`.env`)
Karena berkas `.env` dikecualikan dari repositori demi keamanan kredensial, buatlah berkas baru bernama `.env` pada direktori utama proyek dan isi parameter berikut sesuai kredensial proyek Supabase Anda (**Project Settings $\rightarrow$ API**):

```env
SUPABASE_URL=[https://xxxxxxxxxxxx.supabase.co](https://xxxxxxxxxxxx.supabase.co)
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
ADMIN_PASSWORD=infonekak
PORT=3000
```

### 4. Memasang Dependensi & Menjalankan Server Backend
Buka terminal pada direktori utama proyek, lalu pasang seluruh pustaka yang tercantum di `package.json` dan jalankan server:

```bash
npm install
npm start
```

Apabila konfigurasi berhasil, terminal akan menampilkan konfirmasi bahwa server Express telah berjalan dan terhubung ke broker MQTT HiveMQ:

```text
🚀 Server PayungTeduh Running on [http://0.0.0.0:3000](http://0.0.0.0:3000)
✅ Connected to HiveMQ Broker!
```

Setelah pesan tersebut muncul, antarmuka web dapat langsung diakses melalui browser pada alamat `http://localhost:3000`.

### 5. Konfigurasi & Unggah Firmware ESP32
Buka berkas `firmware/PayungTeduh.ino` menggunakan Arduino IDE, lalu sesuaikan kredensial jaringan Wi-Fi lokal Anda pada bagian awal kode:

```cpp
const char *ssid = "NAMA_WIFI_ANDA";
const char *password = "PASSWORD_WIFI_ANDA";
```

Jika Anda menggunakan stiker RFID baru untuk payung sewa, sesuaikan pula nilai UID kartu pada baris pengecekan RFID (`if (uid == "61 F7 28 B5" || uid == "51 B0 25 B5")`). Pilih jenis board **ESP32 Dev Module** beserta port COM yang sesuai, kemudian klik **Upload**.

---

## Skema Tarif, Deposit, & Kebijakan Denda

Sistem menerapkan struktur biaya yang transparan untuk menjaga ketersediaan payung sewa maupun kedisiplinan penggunaan slot penitipan:

| Jenis Layanan | Biaya Layanan | Deposit Jaminan | Total Bayar Awal | Batas Waktu | Ketentuan Pengembalian & Denda |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Sewa Payung** | Rp 5.000 | Rp 20.000 | **Rp 25.000** | 48 Jam | Pengembalian tepat waktu mengembalikan deposit 100%. Keterlambatan $\le 24$ jam dikenakan denda Rp 5.000, keterlambatan $\le 48$ jam didenda Rp 10.000, dan keterlambatan $> 48$ jam menyebabkan deposit hangus. |
| **Titip Payung** | Rp 3.000 | Rp 3.000 | **Rp 6.000** | 72 Jam | Payung diambil kembali menggunakan verifikasi kode OTP 4 digit yang dikirimkan ke email terdaftar. |

---

## Alur Operasional & Panduan Pengujian

### A. Menyewa atau Menitipkan Payung
1. **Memeriksa Ketersediaan Loker:** Pengguna mengecek jumlah stok payung sewa maupun slot titip yang kosong melalui layar OLED pada unit loker atau tabel *Ketersediaan Loker Live* di halaman awal web (`http://localhost:3000`).
2. **Aktivasi Sesi NFC Fisik:** Pengguna menekan **Push Button** pada kotak kontrol loker hingga buzzer berbunyi satu kali dan layar OLED menampilkan hitung mundur `SISTEM AKTIF! Tempelkan HP NFC` selama 60 detik.
3. **Pemindaian NFC Ponsel:** Pengguna menempelkan ponsel berfitur NFC ke **Reader RC522** hingga layar OLED menampilkan konfirmasi `NFC HP TERDETEKSI`.
4. **Pengisian Formulir & Pembayaran:** Pada aplikasi web, pengguna memilih akses **Pengguna**, mengisi nama lengkap, email aktif, metode pembayaran/refund (GoPay, OVO, Dana, ShopeePay, AstraPay, atau transfer bank BCA, BRI, BNI, Mandiri, CIMB), serta nomor rekening/ponsel. Setelah memilih layanan **Sewa Payung** atau **Titip Payung**, rincian biaya akan tampil dan pengguna menekan tombol pembayaran hingga muncul struk digital.
5. **Pengambilan / Penyimpanan Payung:** Servo SG90 pada slot yang dialokasikan otomatis terbuka ke sudut **90°** selama 60 detik. Pengguna mengambil atau memasukkan payung, lalu menutup pintu hingga menekan **Limit Switch** sehingga layar OLED menghitung mundur 5 detik dan servo mengunci kembali ke sudut **0°**.

### B. Mengembalikan Payung Sewa
Pengembalian payung sewa mendukung dua mekanisme fleksibel yang dapat dipilih sesuai kebutuhan pengguna:
* **Scan Langsung Stiker RFID:** Pengguna cukup menempelkan stiker RFID yang tertempel pada payung sewa ke **Reader RC522** tanpa perlu membuka formulir web. Buzzer akan berbunyi dua kali, server secara otomatis menandai transaksi aktif sebagai selesai (`COMPLETED`), dan pintu loker sewa yang kosong langsung terbuka agar payung dapat dimasukkan dan dikunci kembali.
* **Verifikasi Kode OTP Email:** Pengguna membuka tab **Kembalikan Payung** di web, memilih opsi **Kode OTP Email**, lalu memasukkan alamat email yang digunakan saat menyewa untuk meminta kode OTP 4 digit (kode tercatat pada log terminal `node server.js` dan tabel `otp_codes`). Setelah kode dimasukkan dan terverifikasi, pintu loker terbuka dan sistem menghitung pengembalian deposit secara otomatis.

### C. Mengambil Payung Titipan
Untuk mengambil kembali payung yang dititipkan, pengguna membuka tab **Ambil Payung** pada antarmuka web, memasukkan email terdaftar, dan menekan tombol **Kirim OTP**. Setelah memasukkan 4 digit kode OTP yang diterima dan menekan **Verifikasi & Buka Loker**, pintu kompartemen penitipan akan terbuka selama 60 detik untuk pengambilan payung sebelum terkunci otomatis kembali setelah pintu ditutup.

### D. Monitoring & Kontrol Administrator
Administrator dapat masuk ke dashboard melalui tautan `http://localhost:3000/admin.html` atau kartu **Admin** di halaman utama dengan memasukkan kata sandi sesuai variabel `ADMIN_PASSWORD` di `.env`. Dari halaman ini, admin dapat memantau status fisik sensor IR tiap slot, menyelesaikan paksa transaksi aktif, menyunting informasi pengguna maupun tenggat waktu, menghapus riwayat transaksi, serta membuka pintu loker tertentu secara darurat.

---

## Referensi REST API & Topik MQTT

Bagi pengembang yang ingin mengintegrasikan atau menguji layanan backend secara langsung, berikut daftar *endpoint* REST API dan topik MQTT yang tersedia:

### Endpoint REST API (`server.js`)
| Method | Endpoint | Deskripsi Fungsional |
| :--- | :--- | :--- |
| `GET` | `/api/availability` | Mengambil data jumlah stok payung sewa dan slot titip kosong saat ini |
| `GET` | `/api/events` | Membuka aliran Server-Sent Events (SSE) untuk pembaruan sensor IR & pintu |
| `POST` | `/api/transaction` | Memproses transaksi baru (`SEWA` / `TITIP`) dan mengirim perintah buka pintu |
| `POST` | `/api/request-otp` | Menghasilkan kode OTP 4 digit baru (berlaku 5 menit) untuk pengguna aktif |
| `POST` | `/api/verify-otp` | Memvalidasi kode OTP sekali pakai, menghitung denda/refund, dan membuka loker |
| `GET` | `/api/admin/dashboard` | Mengambil seluruh status loker, sensor IR, dan transaksi *(Header: `x-admin-password`)* |
| `PUT` | `/api/admin/transactions/:id` | Memperbarui data pengguna/tenggat waktu atau menyelesaikan transaksi aktif |
| `DELETE` | `/api/admin/transactions/:id` | Menghapus permanen data transaksi dari basis data |
| `POST` | `/api/admin/lockers/:slot_name/unlock` | Mengirim perintah buka pintu darurat ke slot loker spesifik |

### Kanal Komunikasi MQTT (`broker.hivemq.com`)
* **`umbllocker/command`** *(Server $\rightarrow$ ESP32)*: Mengirimkan perintah pembukaan pintu dengan format `UNLOCK:<SLOT>:<ACTION>` (contoh: `UNLOCK:SEWA_1:SEWA`) serta pembaruan tampilan layar OLED melalui payload `OLED:<STATUS>`.
* **`umbllocker/status`** *(ESP32 $\rightarrow$ Server)*: Melaporkan status pembacaan keempat sensor IR (`IR_STATE:1,1,0,0`), aktivasi tombol fisik (`SYSTEM_ACTIVATED`), sesi NFC ponsel (`NFC_SESSION_START:<UID>`), validasi stiker pengembalian (`RFID_VALID:<UID>`), serta status penguncian pintu (`DOOR_CLOSED` dan `DOOR_TIMEOUT`).