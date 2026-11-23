# PayungTeduh — Sistem Loker Payung Otomatis Berbasis IoT

**Tema Proyek:** Smart Locker & Campus Utility Berbasis Internet of Things (IoT)

## Deskripsi Singkat
**PayungTeduh** adalah sistem loker pintar otomatis yang mengintegrasikan perangkat keras berbasis **ESP32** dengan aplikasi web *real-time* untuk menyediakan dua layanan dalam satu perangkat:
1. **Penyewaan Payung (*Umbrella Sharing*):** Meminjam payung siap pakai dari slot loker sewa dengan sistem biaya layanan + deposit jaminan.
2. **Penitipan Payung Pribadi:** Menitipkan payung milik pengguna di slot loker khusus secara aman.

Sistem ini memantau ketersediaan loker secara *real-time* menggunakan sensor inframerah (IR), mengamankan akses menggunakan tombol fisik + tap **NFC/RFID (MFRC522)** serta verifikasi **OTP 4 digit**, dan mengunci pintu loker secara otomatis menggunakan **Motor Servo SG90** dan **Limit Switch**.

---

## Fungsi Sistem & Komponen

### 1. Perangkat Keras (`firmware/PayungTeduh.ino`)
* **Mikrokontroler ESP32:** Mengelola pembacaan seluruh sensor, mengendalikan aktuator, menampilkan antarmuka lokal pada layar OLED, serta berkomunikasi dua arah dengan server melalui Wi-Fi menggunakan protokol **MQTT**.
* **4x Sensor Inframerah (IR):** Mendeteksi keberadaan objek payung di dalam masing-masing slot (`SEWA_1`, `SEWA_2`, `TITIP_1`, `TITIP_2`) dan mengirimkan pembaruan status (`IR_STATE`) secara otomatis ke server dan layar OLED.
* **Modul RFID/NFC (MFRC522) & Push Button:**
  * *Push Button* mengaktifkan mode tunggu tap NFC ponsel selama 60 detik sebelum pengguna mengisi formulir transaksi di web.
  * *Reader RC522* juga membaca UID stiker RFID yang tertempel pada payung sewa untuk proses pengembalian langsung tanpa perlu membuka form web.
* **4x Motor Servo SG90 & 4x Limit Switch:**
  * Servo berputar ke sudut **90°** untuk membuka kunci pintu loker selama maksimal **60 detik**, dan kembali ke **0°** untuk mengunci pintu.
  * *Limit Switch* mendeteksi ketika pintu sudah ditutup kembali oleh pengguna, memicu hitung mundur **5 detik** sebelum servo mengunci pintu secara otomatis.
* **Layar OLED I2C (SSD1306) & Buzzer:** Menampilkan status stok payung sewa, jumlah slot titip kosong, hitung mundur sesi NFC/buka pintu, serta memberikan peringatan suara (*beep*).

### 2. Backend & Database (`server.js` & Supabase)
* **Express.js REST API:** Menangani pembuatan transaksi baru (`POST /api/transaction`), pembuatan dan verifikasi OTP sekali pakai (`POST /api/request-otp`, `POST /api/verify-otp`), serta autentikasi dan operasi CRUD dashboard admin.
* **MQTT Client (`broker.hivemq.com`):** Menerima telemetri perangkat keras pada topik `umbllocker/status` dan mengirimkan perintah aktuasi pintu (`UNLOCK:<SLOT>:<ACTION>`) maupun teks layar OLED pada topik `umbllocker/command`.
* **Server-Sent Events (`GET /api/events`):** Menyiarkan perubahan status sensor IR dan status pintu secara langsung (*real-time*) ke browser pengguna tanpa perlu *refresh* halaman.
* **Database PostgreSQL (Supabase):** Menyimpan data secara relasional ke dalam 4 tabel utama: `users`, `lockers`, `transactions`, dan `otp_codes`.

### 3. Antarmuka Web (`web/`)
* **Halaman Pengguna (`web/index.html` & `web/js/app.js`):** Menampilkan tabel ketersediaan loker *live*, formulir transaksi Sewa/Titip beserta rincian biaya & struk pembayaran, serta menu pengembalian payung (via RFID/OTP) dan pengambilan titipan (via OTP).
* **Dashboard Administrator (`web/admin.html`):** Halaman terproteksi kata sandi untuk memantau kondisi fisik sensor IR tiap loker, mengelola data transaksi aktif maupun riwayat (Edit/Selesaikan/Hapus), serta membuka pintu loker secara darurat (*emergency unlock*).

---

## Alur Penggunaan Sistem (Langkah Pengujian)

### A. Menyewa atau Menitipkan Payung
1. **Cek Ketersediaan:** Lihat jumlah stok payung sewa dan slot titip kosong pada layar **OLED** loker atau pada tabel *Ketersediaan Loker Live* di halaman awal web (`http://localhost:3000`).
2. **Aktivasi Sesi NFC:** Tekan **Push Button** fisik pada kotak kontrol loker hingga buzzer berbunyi 1 kali dan layar OLED menampilkan hitung mundur `SISTEM AKTIF! Tempelkan HP NFC` (waktu aktif 60 detik).
3. **Tap HP NFC:** Tempelkan ponsel berfitur NFC ke **Reader RC522** hingga layar OLED menampilkan `NFC HP TERDETEKSI`.
4. **Isi Formulir & Bayar di Web:**
   * Buka web **PayungTeduh** di ponsel/laptop, pilih **Pengguna**.
   * Isi **Nama Lengkap**, **Email Aktif**, **Metode Bayar & Refund**, **No. Rekening/HP**, lalu pilih layanan **Sewa Payung** atau **Titip Payung**.
   * Klik **Bayar & Sewa/Titip Payung** dan tunggu struk pemotongan saldo muncul.
5. **Ambil / Masukkan Payung & Tutup Pintu:**
   * **Servo SG90** pada slot yang terpilih akan otomatis terbuka ke sudut **90°** selama maksimal **60 detik**.
   * Ambil payung (untuk Sewa) atau masukkan payung ke dalam slot (untuk Titip), lalu tutup pintu hingga menekan **Limit Switch**.
   * Layar OLED akan menghitung mundur **5 detik**, lalu servo otomatis mengunci kembali ke sudut **0°**.

### B. Mengembalikan Payung Sewa
Pengembalian payung sewa dapat dilakukan melalui salah satu dari dua metode berikut:
* **Metode 1 — Scan Stiker RFID (Tanpa Buka Form Web):**
  1. Tempelkan **stiker RFID** yang tertempel pada payung sewa langsung ke **Reader RC522**.
  2. Buzzer berbunyi 2 kali, server otomatis menyelesaikan transaksi aktif di database, dan pintu loker sewa yang kosong langsung terbuka.
  3. Masukkan payung ke dalam slot lalu tutup pintu rapat hingga terkunci otomatis setelah 5 detik.
* **Metode 2 — Kode OTP Email:**
  1. Buka tab **Kembalikan Payung** di web → pilih **Kode OTP Email**.
  2. Masukkan email yang digunakan saat menyewa → klik **Kirim Kode OTP Verifikasi** (kode OTP 4 digit dapat dilihat pada log terminal server `node server.js` atau tabel `otp_codes`).
  3. Masukkan 4 digit kode OTP → klik **Verifikasi & Buka Loker**, taruh payung, lalu tutup pintu hingga terkunci otomatis.

### C. Mengambil Payung Titipan
1. Buka tab **Ambil Payung** pada antarmuka web pengguna.
2. Masukkan **Email Terdaftar** saat menitipkan payung, lalu klik **Kirim OTP**.
3. Masukkan 4 digit **Kode OTP Verifikasi**, lalu klik **Verifikasi & Buka Loker**.
4. Pintu slot loker titipan akan terbuka selama 60 detik; ambil payung Anda lalu tutup pintu rapat hingga terkunci otomatis.

### D. Monitoring & Kontrol Admin
1. Buka `http://localhost:3000/admin.html` (atau klik kartu **Admin** di halaman awal) dan masukkan kata sandi sesuai `ADMIN_PASSWORD` di `.env`.
2. Pantau status sensor inframerah (IR) tiap slot secara *real-time*, kelola transaksi aktif maupun riwayat (**Selesai / Edit / Hapus**), atau klik **Buka Pintu Loker** pada kartu slot untuk membuka pintu secara darurat.