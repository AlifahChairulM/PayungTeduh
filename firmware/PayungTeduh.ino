// Pustaka koneksi Wi-Fi dan komunikasi protokol MQTT
#include <WiFi.h>
#include <PubSubClient.h>

// Pustaka komunikasi I2C dan tampilan layar OLED SSD1306
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// Pustaka kontrol motor servo SG90 pada ESP32
#include <ESP32Servo.h>

// Pustaka komunikasi SPI dan modul pembaca kartu/stiker RFID MFRC522
#include <SPI.h>
#include <MFRC522.h>

// Konfigurasi WiFi dan MQTT
const char *ssid = "";
const char *password = "";
const char *mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;
const char *topicCommand = "umbllocker/command";
const char *topicStatus = "umbllocker/status";

WiFiClient espClient;
PubSubClient client(espClient);

// Konfigurasi pin I2C dan dimensi layar OLED 0.96" SSD1306
#define OLED_SDA 21
#define OLED_SCL 22
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// Konfigurasi pin SPI untuk modul pembaca RFID/NFC MFRC522
#define RST_PIN 4
#define SS_PIN 5
MFRC522 rfid(SS_PIN, RST_PIN);

// Konfigurasi pin Limit Switch pendeteksi pintu tertutup (Slot 1-2: Sewa, Slot 4-5: Titip)
#define LIMIT_SW_1 32
#define LIMIT_SW_2 33
#define LIMIT_SW_4 25
#define LIMIT_SW_5 26

// Konfigurasi pin tombol aktivasi sesi (Push Button) dan indikator suara (Buzzer)
#define BUTTON_PIN 15
#define BUZZER_PIN 2

// Inisialisasi objek dan pin PWM untuk keempat motor servo SG90 pengunci pintu
Servo servo1, servo2, servo4, servo5;
#define SERVO_1_PIN 13
#define SERVO_2_PIN 12
#define SERVO_4_PIN 14
#define SERVO_5_PIN 27

// Konfigurasi pin input sensor inframerah (IR) pendeteksi keberadaan payung
#define IR_1 34
#define IR_2 35
#define IR_4 36
#define IR_5 39

// Variabel status dan batas waktu (60 detik) untuk mode tunggu Tap HP NFC
bool sistemAktifNFC = false;
unsigned long waktuAktifNFC = 0;
const unsigned long TIMEOUT_SESI_NFC = 60000;

// Variabel status dan batas waktu (90 detik) tampilan interaksi web pada layar OLED
bool webInteraksiAktif = false;
unsigned long waktuWebInteraksi = 0;
const unsigned long TIMEOUT_WEB_INTERAKSI = 90000;

// Variabel status pintu loker yang sedang terbuka beserta batas waktu maksimalnya (60 detik)
bool pintuTerbuka = false;
int slotAktif = 0;
String namaSlotAktif = "";
String aksiAktif = ""; // "SEWA", "TITIP", "RETURN", "RETRIEVE"
unsigned long waktuBuka = 0;
const unsigned long TIMEOUT_PINTU = 60000;

// Variabel penanda pintu sudah ditutup dan jeda waktu penguncian otomatis (5 detik)
bool pintuSedangDitutup = false;
unsigned long waktuTutup = 0;
const unsigned long JEDA_KUNCI = 5000;

// Menyimpan status pembacaan sensor IR terakhir agar pengiriman MQTT hanya saat ada perubahan
String lastIRStatus = "";

// Deklarasi prototipe seluruh fungsi yang digunakan dalam program
void callback(char *topic, byte *payload, unsigned int length);
void reconnectMQTT();
void prosesBukaPintu(int slot, String slotName, String actionMode);
void tutupPintuOtomatis();
void kunciPintu(int slot);
void tampilkanIdle();
void tampilkanTungguNFC(unsigned long sisaDetik);
void tampilkanStatusWeb(String judul, String baris1, String baris2);
void tampilkanInstruksiPintu(unsigned long sisaDetik);
void bunyikanBuzzer(int jumlah = 1, int durasi = 150);
void kirimStatusIR();

void setup()
{
  // Memulai komunikasi serial untuk debugging di Serial Monitor
  Serial.begin(115200);

  // Inisialisasi komunikasi I2C dan layar OLED pada alamat 0x3C
  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C))
  {
    for (;;)
      ;  // Hentikan program jika layar OLED gagal terdeteksi
  }
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);

  // Inisialisasi bus SPI dan modul RFID/NFC RC522
  SPI.begin();
  rfid.PCD_Init();

  // Konfigurasi mode pin input untuk tombol, limit switch, sensor IR, dan output buzzer
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LIMIT_SW_1, INPUT_PULLUP);
  pinMode(LIMIT_SW_2, INPUT_PULLUP);
  pinMode(LIMIT_SW_4, INPUT_PULLUP);
  pinMode(LIMIT_SW_5, INPUT_PULLUP);

  pinMode(IR_1, INPUT);
  pinMode(IR_2, INPUT);
  pinMode(IR_4, INPUT);
  pinMode(IR_5, INPUT);

  // Hubungkan keempat motor servo ke pin GPIO dan posisikan terkunci (0 derajat)
  servo1.attach(SERVO_1_PIN);
  servo2.attach(SERVO_2_PIN);
  servo4.attach(SERVO_4_PIN);
  servo5.attach(SERVO_5_PIN);
  servo1.write(0);
  servo2.write(0);
  servo4.write(0);
  servo5.write(0);

  // Tampilkan status koneksi Wi-Fi pada layar OLED
  display.clearDisplay();
  display.setCursor(0, 20);
  display.print("Menghubungkan WiFi...");
  display.display();

  // Mulai proses koneksi ke jaringan Wi-Fi hingga berhasil terhubung
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
  }

  // Konfigurasi alamat broker MQTT dan fungsi penerima pesan (callback)
  Serial.println("\nWiFi Terhubung!");
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);

  // Tampilkan layar awal (Idle) setelah sistem siap
  tampilkanIdle();
}

void loop()
{
  // Pastikan koneksi ke broker MQTT selalu aktif dan periksa pembaruan sensor IR
  if (!client.connected())
  {
    reconnectMQTT();
  }
  client.loop();

  kirimStatusIR();

  // Cek penekanan Push Button untuk mengaktifkan mode tunggu Tap NFC HP
  if (digitalRead(BUTTON_PIN) == LOW && !pintuTerbuka)
  {
    delay(50);
    if (digitalRead(BUTTON_PIN) == LOW)
    {
      bunyikanBuzzer(1, 150);
      sistemAktifNFC = true;
      webInteraksiAktif = false;
      waktuAktifNFC = millis();
      tampilkanTungguNFC(TIMEOUT_SESI_NFC / 1000);
      client.publish(topicStatus, "SYSTEM_ACTIVATED");
      Serial.println("Tombol ditekan: Sistem aktif menunggu Tap NFC HP...");
      while (digitalRead(BUTTON_PIN) == LOW)
        ;
    }
  }

  // Hitung mundur sesi tunggu Tap NFC HP selama 60 detik
  if (sistemAktifNFC && !pintuTerbuka)
  {
    unsigned long elapsed = millis() - waktuAktifNFC;
    if (elapsed < TIMEOUT_SESI_NFC)
    {
      static unsigned long lastOledUpdate = 0;
      if (millis() - lastOledUpdate >= 1000)
      {
        lastOledUpdate = millis();
        tampilkanTungguNFC((TIMEOUT_SESI_NFC - elapsed) / 1000);
      }
    }
    else
    {
      sistemAktifNFC = false;
      tampilkanIdle();
      Serial.println("Waktu tunggu Tap NFC habis, kembali ke Idle.");
    }
  }

  // Kembalikan layar OLED ke tampilan Idle jika interaksi web diam selama 90 detik
  if (webInteraksiAktif && !pintuTerbuka && !sistemAktifNFC)
  {
    if (millis() - waktuWebInteraksi > TIMEOUT_WEB_INTERAKSI)
    {
      webInteraksiAktif = false;
      tampilkanIdle();
    }
  }

  // Tampilkan sisa waktu buka pintu (60 detik) dan kunci otomatis jika melewati batas
  if (pintuTerbuka && !pintuSedangDitutup)
  {
    unsigned long elapsed = millis() - waktuBuka;
    if (elapsed < TIMEOUT_PINTU)
    {
      static unsigned long lastDoorTick = 0;
      if (millis() - lastDoorTick >= 1000)
      {
        lastDoorTick = millis();
        tampilkanInstruksiPintu((TIMEOUT_PINTU - elapsed) / 1000);
      }
    }
    else
    {
      tutupPintuOtomatis();
    }
  }

  // Deteksi penutupan pintu fisik melalui Limit Switch pada slot yang sedang terbuka
  if (pintuTerbuka)
  {
    bool sensorTertutup = false;
    if (slotAktif == 1 && digitalRead(LIMIT_SW_1) == LOW) sensorTertutup = true;
    if (slotAktif == 2 && digitalRead(LIMIT_SW_2) == LOW) sensorTertutup = true;
    if (slotAktif == 4 && digitalRead(LIMIT_SW_4) == LOW) sensorTertutup = true;
    if (slotAktif == 5 && digitalRead(LIMIT_SW_5) == LOW) sensorTertutup = true;

    if (sensorTertutup && !pintuSedangDitutup)
    {
      pintuSedangDitutup = true;
      waktuTutup = millis();
      bunyikanBuzzer(1, 100);
    }
  }

  // Jalankan jeda hitung mundur 5 detik sebelum servo mengunci pintu kembali
  if (pintuSedangDitutup)
  {
    unsigned long elapsedClose = millis() - waktuTutup;
    if (elapsedClose < JEDA_KUNCI)
    {
      static unsigned long lastCloseTick = 0;
      if (millis() - lastCloseTick >= 500)
      {
        lastCloseTick = millis();
        unsigned long sisaKunci = ((JEDA_KUNCI - elapsedClose) / 1000) + 1;
        display.clearDisplay();
        display.setCursor(0, 6);
        display.print("PINTU TERTUTUP!");
        display.drawLine(0, 18, 127, 18, WHITE);
        display.setCursor(0, 28);
        display.print("Mengunci otomatis");
        display.setCursor(0, 42);
        display.print("dalam ");
        display.print(sisaKunci);
        display.print(" detik...");
        display.display();
      }
    }
    else
    {
      kunciPintu(slotAktif);
      pintuTerbuka = false;
      pintuSedangDitutup = false;
      webInteraksiAktif = false;

      display.clearDisplay();
      display.setCursor(0, 15);
      display.print("TERIMA KASIH!");
      display.setCursor(0, 35);
      display.print("Loker ");
      display.print(namaSlotAktif);
      display.setCursor(0, 48);
      display.print("Terkunci Aman.");
      display.display();
      delay(2000);

      tampilkanIdle();
      client.publish(topicStatus, "DOOR_CLOSED");
    }
  }

  // Cek pemindaian kartu/stiker RFID atau Tap NFC HP pada reader RC522
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial())
  {
    // Konversi array byte UID kartu/NFC menjadi string heksadesimal
    String uid = "";
    for (byte i = 0; i < rfid.uid.size; i++)
    {
      if (rfid.uid.uidByte[i] < 0x10)
        uid += "0";
      uid += String(rfid.uid.uidByte[i], HEX);
      if (i < rfid.uid.size - 1)
        uid += " ";
    }
    uid.toUpperCase();

    // Pengembalian langsung jika UID cocok dengan stiker RFID payung sewa
    if (uid == "61 F7 28 B5" || uid == "51 B0 25 B5")
    {
      sistemAktifNFC = false;
      webInteraksiAktif = false;
      bunyikanBuzzer(2, 100);

      display.clearDisplay();
      display.setCursor(0, 10);
      display.print("STIKER RFID VALID!");
      display.setCursor(0, 30);
      display.print("Mengecek slot");
      display.setCursor(0, 42);
      display.print("pengembalian...");
      display.display();

      String pesan = "RFID_VALID:" + uid;
      client.publish(topicStatus, pesan.c_str());

      // Cari slot loker sewa yang kosong (IR == HIGH) untuk menampung payung kembali
      int targetSlot = 0;
      String targetName = "";
      if (digitalRead(IR_1) == HIGH)
      {
        targetSlot = 1;
        targetName = "SEWA_1";
      }
      else if (digitalRead(IR_2) == HIGH)
      {
        targetSlot = 2;
        targetName = "SEWA_2";
      }

      if (targetSlot > 0)
      {
        prosesBukaPintu(targetSlot, targetName, "RETURN");
      }
      else
      {
        display.clearDisplay();
        display.setCursor(0, 10);
        display.print("PENGEMBALIAN GAGAL");
        display.setCursor(0, 30);
        display.print("Semua loker sewa");
        display.setCursor(0, 42);
        display.print("sudah penuh!");
        display.display();
        delay(2500);
        tampilkanIdle();
      }
    }
    // Mulai sesi transaksi web jika HP NFC di-tap setelah tombol ditekan
    else if (sistemAktifNFC)
    {
      sistemAktifNFC = false;
      bunyikanBuzzer(1, 200);

      String pesan = "NFC_SESSION_START:" + uid;
      client.publish(topicStatus, pesan.c_str());
      Serial.println("Tap NFC HP berhasil: " + pesan);

      tampilkanStatusWeb("NFC HP TERDETEKSI", "Web terbuka di HP.", "Pilih layanan Anda.");
    }
    // Tolak pemindaian jika pengguna belum menekan Push Button lebih dulu
    else
    {
      bunyikanBuzzer(2, 100);
      display.clearDisplay();
      display.setCursor(0, 8);
      display.print("TEKAN TOMBOL DULU!");
      display.drawLine(0, 20, 127, 20, WHITE);
      display.setCursor(0, 28);
      display.print("1. Tekan Push Button");
      display.setCursor(0, 42);
      display.print("2. Tap HP ke Reader");
      display.display();

      client.publish(topicStatus, "RFID_INVALID");
      delay(2500);
      tampilkanIdle();
    }

    // Hentikan komunikasi dengan kartu/NFC saat ini agar siap membaca kartu berikutnya
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    delay(800);
  }
}

// Membaca status keempat sensor IR setiap 1 detik dan mengirimkannya ke broker MQTT jika berubah
void kirimStatusIR()
{
  static unsigned long lastCheck = 0;
  if (millis() - lastCheck >= 1000) 
  {
    lastCheck = millis();
    // Sensor IR bersifat Active-LOW: LOW (0) berarti objek payung terdeteksi (nilai 1)
    int ir1 = (digitalRead(IR_1) == LOW) ? 1 : 0;
    int ir2 = (digitalRead(IR_2) == LOW) ? 1 : 0;
    int ir4 = (digitalRead(IR_4) == LOW) ? 1 : 0;
    int ir5 = (digitalRead(IR_5) == LOW) ? 1 : 0;

    // Kirim payload status IR hanya ketika terjadi perubahan kondisi fisik
    String currentIR = "IR_STATE:" + String(ir1) + "," + String(ir2) + "," + String(ir4) + "," + String(ir5);
    if (currentIR != lastIRStatus)
    {
      lastIRStatus = currentIR;
      if (client.connected()) {
        client.publish(topicStatus, currentIR.c_str(), true); 
      }
      Serial.println("Update IR: " + currentIR);

      // Langsung update OLED jika pintu tidak sedang terbuka
      if (!pintuTerbuka && !sistemAktifNFC)
      {
        webInteraksiAktif = false;
        tampilkanIdle();
      }
    }
  }
}

// Fungsi callback untuk memproses perintah masuk dari server melalui topik MQTT "umbllocker/command"
void callback(char *topic, byte *payload, unsigned int length)
{
  String pesan = "";
  for (int i = 0; i < length; i++)
  {
    pesan += (char)payload[i];
  }
  Serial.println("Pesan MQTT Diterima: " + pesan);

  // Perbarui informasi status layar OLED sesuai aktivitas pengguna di web
  if (pesan.startsWith("OLED:"))
  {
    String st = pesan.substring(5);
    if (st == "FORM_OPEN" || st == "PILIH_SEWA")
    {
      tampilkanStatusWeb("LAYANAN: SEWA PAYUNG", "Isi data di HP &", "selesaikan bayar.");
    }
    else if (st == "PILIH_TITIP")
    {
      tampilkanStatusWeb("LAYANAN: TITIP PAYUNG", "Isi data di HP &", "selesaikan bayar.");
    }
    else if (st == "TAB_RETURN")
    {
      tampilkanStatusWeb("KEMBALIKAN PAYUNG", "Scan RFID payung", "atau pakai OTP HP.");
    }
    else if (st == "TAB_RETRIEVE")
    {
      tampilkanStatusWeb("AMBIL TITIPAN", "Masukkan email &", "kode OTP di HP.");
    }
    else if (st == "PAYING")
    {
      tampilkanStatusWeb("MEMPROSES BAYAR...", "Verifikasi saldo", "mohon tunggu...");
    }
    else if (st == "OTP_REQUEST")
    {
      tampilkanStatusWeb("MENGIRIM OTP...", "Cek kode OTP lalu", "masukkan di HP.");
    }
    return;
  }

  // Parsing perintah buka pintu format "UNLOCK:<NAMA_SLOT>:<MODE_AKSI>"
  if (pesan.startsWith("UNLOCK:"))
  {
    int firstColon = pesan.indexOf(':');
    int secondColon = pesan.indexOf(':', firstColon + 1);
    String slotName = pesan.substring(firstColon + 1, secondColon);
    String actionMode = pesan.substring(secondColon + 1);

    int slotNum = 0;
    if (slotName == "SEWA_1") slotNum = 1;
    else if (slotName == "SEWA_2") slotNum = 2;
    else if (slotName == "TITIP_1") slotNum = 4;
    else if (slotName == "TITIP_2") slotNum = 5;

    if (slotNum > 0)
    {
      prosesBukaPintu(slotNum, slotName, actionMode);
    }
    return;
  }

  // Fallback kompatibilitas format perintah buka pintu versi lama
  if (pesan == "UNLOCK_SEWA_1") prosesBukaPintu(1, "SEWA_1", "SEWA");
  else if (pesan == "UNLOCK_SEWA_2") prosesBukaPintu(2, "SEWA_2", "SEWA");
  else if (pesan == "UNLOCK_TITIP_1") prosesBukaPintu(4, "TITIP_1", "TITIP");
  else if (pesan == "UNLOCK_TITIP_2") prosesBukaPintu(5, "TITIP_2", "TITIP");
}

// Menghubungkan ulang ESP32 ke broker MQTT secara otomatis jika koneksi terputus
void reconnectMQTT()
{
  while (!client.connected())
  {
    // Buat Client ID acak agar tidak bentrok dengan perangkat lain di broker publik
    String clientId = "ESP32PayungTeduh-";
    clientId += String(random(0xffff), HEX);
    if (client.connect(clientId.c_str()))
    {
      client.subscribe(topicCommand);  // Berlangganan topik perintah dari server
      kirimStatusIR();                 // Kirim status sensor IR terbaru segera setelah terhubung
    }
    else
    {
      delay(3000);
    }
  }
}

// Memvalidasi kesesuaian sensor IR fisik sebelum menggerakkan servo untuk membuka pintu loker
void prosesBukaPintu(int slot, String slotName, String actionMode)
{
  bool kondisiFisikOK = false;

  // Pastikan kondisi fisik slot sesuai: SEWA/RETRIEVE wajib ada payung (LOW), RETURN/TITIP wajib kosong (HIGH)
  if (actionMode == "SEWA")
  {
    if (slot == 1 && digitalRead(IR_1) == LOW) kondisiFisikOK = true;
    if (slot == 2 && digitalRead(IR_2) == LOW) kondisiFisikOK = true;
  }
  else if (actionMode == "RETURN")
  {
    if (slot == 1 && digitalRead(IR_1) == HIGH) kondisiFisikOK = true;
    if (slot == 2 && digitalRead(IR_2) == HIGH) kondisiFisikOK = true;
  }
  else if (actionMode == "TITIP")
  {
    if (slot == 4 && digitalRead(IR_4) == HIGH) kondisiFisikOK = true;
    if (slot == 5 && digitalRead(IR_5) == HIGH) kondisiFisikOK = true;
  }
  else if (actionMode == "RETRIEVE")
  {
    if (slot == 4 && digitalRead(IR_4) == LOW) kondisiFisikOK = true;
    if (slot == 5 && digitalRead(IR_5) == LOW) kondisiFisikOK = true;
  }

  if (kondisiFisikOK)
  {
    sistemAktifNFC = false;
    webInteraksiAktif = false;
    slotAktif = slot;
    namaSlotAktif = slotName;
    aksiAktif = actionMode;

    // Tampilkan notifikasi nomor loker yang terbuka selama 2,5 detik di layar OLED
    bunyikanBuzzer(2, 120);
    display.clearDisplay();
    display.setCursor(0, 4);
    display.print(actionMode == "SEWA" || actionMode == "TITIP" ? "PEMBAYARAN SUKSES!" : "VERIFIKASI SUKSES!");
    display.drawLine(0, 16, 127, 16, WHITE);
    display.setCursor(0, 24);
    display.print("LOKER TERBUKA:");
    display.setTextSize(2);
    display.setCursor(0, 38);
    display.print(slotName);
    display.setTextSize(1);
    display.display();
    delay(2500);

    // Putar servo slot terkait ke sudut 90 derajat untuk membuka kunci pintu
    if (slot == 1) servo1.write(90);
    if (slot == 2) servo2.write(90);
    if (slot == 4) servo4.write(90);
    if (slot == 5) servo5.write(90);

    pintuTerbuka = true;
    pintuSedangDitutup = false;
    waktuBuka = millis();
    tampilkanInstruksiPintu(TIMEOUT_PINTU / 1000);

    Serial.println("Pintu Berhasil Dibuka: " + slotName + " (" + actionMode + ")");
  }
  else
  {
    // Batalkan pembukaan pintu dan bunyikan alarm jika status fisik sensor IR tidak cocok
    bunyikanBuzzer(3, 100);
    display.clearDisplay();
    display.setCursor(0, 8);
    display.print("GAGAL BUKA ");
    display.print(slotName);
    display.drawLine(0, 20, 127, 20, WHITE);
    display.setCursor(0, 30);
    display.print("Kondisi sensor IR");
    display.setCursor(0, 42);
    display.print("tidak sesuai!");
    display.display();
    delay(2500);
    tampilkanIdle();
  }
}

// Menutup dan mengunci pintu secara otomatis ketika batas waktu 60 detik terlewati
void tutupPintuOtomatis()
{
  kunciPintu(slotAktif);
  pintuTerbuka = false;
  pintuSedangDitutup = false;
  webInteraksiAktif = false;

  display.clearDisplay();
  display.setCursor(0, 15);
  display.print("WAKTU HABIS!");
  display.setCursor(0, 35);
  display.print("Loker ");
  display.print(namaSlotAktif);
  display.setCursor(0, 48);
  display.print("Dikunci Otomatis.");
  display.display();
  delay(2000);

  tampilkanIdle();
  client.publish(topicStatus, "DOOR_TIMEOUT");
}

// Mengembalikan sudut motor servo slot terkait ke 0 derajat untuk mengunci pintu loker
void kunciPintu(int slot)
{
  if (slot == 1) servo1.write(0);
  if (slot == 2) servo2.write(0);
  if (slot == 4) servo4.write(0);
  if (slot == 5) servo5.write(0);

  delay(500);
  Serial.println("Loker Slot " + String(slot) + " Dikunci ke 0 derajat.");
}

// Menampilkan layar utama (Idle) berisi stok payung sewa, slot titip kosong, dan panduan aktivasi
void tampilkanIdle()
{
  int stokSewa = (digitalRead(IR_1) == LOW ? 1 : 0) + (digitalRead(IR_2) == LOW ? 1 : 0);
  int slotTitipKosong = (digitalRead(IR_4) == HIGH ? 1 : 0) + (digitalRead(IR_5) == HIGH ? 1 : 0);

  display.clearDisplay();
  display.ssd1306_command(SSD1306_SETCONTRAST);
  display.ssd1306_command(0xCF);
  display.setCursor(0, 0);
  display.print("PAYUNG TEDUH");
  display.drawLine(0, 11, 127, 11, WHITE);

  display.setCursor(0, 16);
  display.print("Sewa:");
  display.print(stokSewa);
  display.print("/2 | Titip:");
  display.print(slotTitipKosong);
  display.print("/2");

  display.setCursor(0, 34);
  display.print("1. Tekan Push Button");
  display.setCursor(0, 48);
  display.print("2. Tap HP ke Reader");
  display.display();
}

// Menampilkan layar hitung mundur saat sistem aktif menunggu pengguna menempelkan HP NFC
void tampilkanTungguNFC(unsigned long sisaDetik)
{
  display.clearDisplay();
  display.setCursor(0, 4);
  display.print("SISTEM AKTIF!");
  display.drawLine(0, 16, 127, 16, WHITE);
  display.setCursor(0, 24);
  display.print("Tempelkan HP NFC");
  display.setCursor(0, 36);
  display.print("ke Reader RC522...");
  display.setCursor(0, 52);
  display.print("Sisa waktu: ");
  display.print(sisaDetik);
  display.print(" dtk");
  display.display();
}

// Menampilkan informasi status aktivitas pengguna yang sedang berlangsung di aplikasi web
void tampilkanStatusWeb(String judul, String baris1, String baris2)
{
  webInteraksiAktif = true;
  waktuWebInteraksi = millis();

  display.clearDisplay();
  display.setCursor(0, 4);
  display.print(judul);
  display.drawLine(0, 16, 127, 16, WHITE);
  display.setCursor(0, 25);
  display.print(baris1);
  display.setCursor(0, 38);
  display.print(baris2);
  display.setCursor(0, 53);
  display.print("Lanjutkan di HP...");
  display.display();
}

// Menampilkan instruksi aksi (ambil/taruh payung) beserta sisa waktu pintu terbuka pada OLED
void tampilkanInstruksiPintu(unsigned long sisaDetik)
{
  String instruksi1 = "";
  String instruksi2 = "Lalu tutup pintu!";

  if (aksiAktif == "SEWA")
  {
    instruksi1 = "Silakan AMBIL payung";
  }
  else if (aksiAktif == "TITIP")
  {
    instruksi1 = "MASUKKAN payung Anda";
  }
  else if (aksiAktif == "RETURN")
  {
    instruksi1 = "TARUH payung kembali";
  }
  else if (aksiAktif == "RETRIEVE")
  {
    instruksi1 = "AMBIL payung titipan";
  }

  display.clearDisplay();
  display.setCursor(0, 2);
  display.print("TERBUKA: ");
  display.print(namaSlotAktif);
  display.drawLine(0, 14, 127, 14, WHITE);

  display.setCursor(0, 21);
  display.print(instruksi1);
  display.setCursor(0, 34);
  display.print(instruksi2);

  display.setCursor(0, 52);
  display.print("Batas waktu: ");
  display.print(sisaDetik);
  display.print(" dtk");
  display.display();
}

// Membunyikan active buzzer sebanyak jumlah dan durasi milidetik yang ditentukan
void bunyikanBuzzer(int jumlah, int durasi)
{
  for (int i = 0; i < jumlah; i++)
  {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(durasi);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < jumlah - 1) delay(80);
  }
}
