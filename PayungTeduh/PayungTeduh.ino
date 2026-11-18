#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>
#include <SPI.h>
#include <MFRC522.h>

// --- KONFIGURASI WIFI & MQTT ---
const char *ssid = "Garnish";
const char *password = "belcogemoy";
const char *mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;

WiFiClient espClient;
PubSubClient client(espClient);

const char *topicCommand = "umbllocker/command";
const char *topicStatus = "umbllocker/status";

// --- DEFINISI PIN ---
#define OLED_SDA 21
#define OLED_SCL 22
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

#define RST_PIN 4
#define SS_PIN 5
MFRC522 rfid(SS_PIN, RST_PIN);

#define LIMIT_SW_1 32
#define LIMIT_SW_2 33
#define LIMIT_SW_4 25
#define LIMIT_SW_5 26

#define BUTTON_PIN 15
#define BUZZER_PIN 2

Servo servo1, servo2, servo4, servo5;
#define SERVO_1_PIN 13
#define SERVO_2_PIN 12
#define SERVO_4_PIN 14
#define SERVO_5_PIN 27

#define IR_1 34
#define IR_2 35
#define IR_4 36
#define IR_5 39

// Status Sistem Sesi NFC
bool sistemAktifNFC = false;
unsigned long waktuAktifNFC = 0;
const unsigned long TIMEOUT_SESI_NFC = 60000;

// Status Interaksi Web di OLED
bool webInteraksiAktif = false;
unsigned long waktuWebInteraksi = 0;
const unsigned long TIMEOUT_WEB_INTERAKSI = 90000;

// Status Pintu & Jenis Aksi Aktif
bool pintuTerbuka = false;
int slotAktif = 0;
String namaSlotAktif = "";
String aksiAktif = ""; // "SEWA", "TITIP", "RETURN", "RETRIEVE"
unsigned long waktuBuka = 0;
const unsigned long TIMEOUT_PINTU = 30000;

bool pintuSedangDitutup = false;
unsigned long waktuTutup = 0;
const unsigned long JEDA_KUNCI = 5000;

String lastIRStatus = "";

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
  Serial.begin(115200);

  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C))
  {
    for (;;)
      ;
  }
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);

  SPI.begin();
  rfid.PCD_Init();

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

  servo1.attach(SERVO_1_PIN);
  servo2.attach(SERVO_2_PIN);
  servo4.attach(SERVO_4_PIN);
  servo5.attach(SERVO_5_PIN);
  servo1.write(0);
  servo2.write(0);
  servo4.write(0);
  servo5.write(0);

  display.clearDisplay();
  display.setCursor(0, 20);
  display.print("Menghubungkan WiFi...");
  display.display();

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi Terhubung!");
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);

  tampilkanIdle();
}

void loop()
{
  if (!client.connected())
  {
    reconnectMQTT();
  }
  client.loop();

  kirimStatusIR();

  // 1. Cek Tombol Push Button -> Aktifkan Mode Tunggu Tap HP NFC
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

  // 1B. Hitung Mundur Mode Tunggu Tap HP NFC
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

  // 1C. Timeout Interaksi Web (kembali ke Idle jika 90 detik tanpa aktivitas)
  if (webInteraksiAktif && !pintuTerbuka && !sistemAktifNFC)
  {
    if (millis() - waktuWebInteraksi > TIMEOUT_WEB_INTERAKSI)
    {
      webInteraksiAktif = false;
      tampilkanIdle();
    }
  }

  // 2. Timer & Instruksi Dinamis Saat Pintu Terbuka
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

  // 3. Logika Limit Switch & Jeda 5 Detik Saat Pintu Ditutup
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

  // 4. Hitung Mundur Penguncian 5 Detik & Eksekusi Kunci
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

  // 5. Cek Pembacaan RC522 (Stiker Payung ATAU Tap HP NFC)
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial())
  {
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

    // A. Stiker RFID Payung Sewa (Pengembalian Langsung)
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
    // B. Tap HP NFC Setelah Push Button Ditekan
    else if (sistemAktifNFC)
    {
      sistemAktifNFC = false;
      bunyikanBuzzer(1, 200);

      String pesan = "NFC_SESSION_START:" + uid;
      client.publish(topicStatus, pesan.c_str());
      Serial.println("Tap NFC HP berhasil: " + pesan);

      tampilkanStatusWeb("NFC HP TERDETEKSI", "Web terbuka di HP.", "Pilih layanan Anda.");
    }
    // C. Tap Tanpa Push Button
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

    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    delay(800);
  }
}

void kirimStatusIR()
{
  static unsigned long lastCheck = 0;
  if (millis() - lastCheck > 2000)
  {
    lastCheck = millis();
    int ir1 = (digitalRead(IR_1) == LOW) ? 1 : 0;
    int ir2 = (digitalRead(IR_2) == LOW) ? 1 : 0;
    int ir4 = (digitalRead(IR_4) == LOW) ? 1 : 0;
    int ir5 = (digitalRead(IR_5) == LOW) ? 1 : 0;

    String currentIR = "IR_STATE:" + String(ir1) + "," + String(ir2) + "," + String(ir4) + "," + String(ir5);
    if (currentIR != lastIRStatus)
    {
      lastIRStatus = currentIR;
      client.publish(topicStatus, currentIR.c_str());
      Serial.println("Update IR: " + currentIR);
      if (!pintuTerbuka && !sistemAktifNFC && !webInteraksiAktif)
      {
        tampilkanIdle();
      }
    }
  }
}

void callback(char *topic, byte *payload, unsigned int length)
{
  String pesan = "";
  for (int i = 0; i < length; i++)
  {
    pesan += (char)payload[i];
  }
  Serial.println("Pesan MQTT Diterima: " + pesan);

  // 1. Pesan Status Interaksi Web (OLED:...)
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

  // 2. Perintah Buka Pintu Baru: UNLOCK:<SLOT>:<ACTION>
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

  // 3. Fallback format lama (UNLOCK_SEWA_1, dll.)
  if (pesan == "UNLOCK_SEWA_1") prosesBukaPintu(1, "SEWA_1", "SEWA");
  else if (pesan == "UNLOCK_SEWA_2") prosesBukaPintu(2, "SEWA_2", "SEWA");
  else if (pesan == "UNLOCK_TITIP_1") prosesBukaPintu(4, "TITIP_1", "TITIP");
  else if (pesan == "UNLOCK_TITIP_2") prosesBukaPintu(5, "TITIP_2", "TITIP");
}

void reconnectMQTT()
{
  while (!client.connected())
  {
    String clientId = "ESP32PayungTeduh-";
    clientId += String(random(0xffff), HEX);
    if (client.connect(clientId.c_str()))
    {
      client.subscribe(topicCommand);
      kirimStatusIR();
    }
    else
    {
      delay(3000);
    }
  }
}

void prosesBukaPintu(int slot, String slotName, String actionMode)
{
  bool kondisiFisikOK = false;

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

    // PENGUMUMAN LOKER SEBELUM PINTU TERBUKA (2.5 DETIK)
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

    // BUKA SERVO
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

void kunciPintu(int slot)
{
  if (slot == 1) servo1.write(0);
  if (slot == 2) servo2.write(0);
  if (slot == 4) servo4.write(0);
  if (slot == 5) servo5.write(0);

  delay(500);
  Serial.println("Loker Slot " + String(slot) + " Dikunci ke 0 derajat.");
}

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