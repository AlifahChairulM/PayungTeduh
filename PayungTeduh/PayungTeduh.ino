#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>
#include <SPI.h>
#include <MFRC522.h>
#include <QRCodeGFX.h>

// --- KONFIGURASI WIFI & MQTT ---
const char* ssid = "Emiliana 4G";         // Pastikan WiFi sama dengan laptop server
const char* password = "dewandaru";
const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;

WiFiClient espClient;
PubSubClient client(espClient);

// Topik MQTT 
const char* topicCommand = "umbllocker/command"; // Menerima perintah dari Backend
const char* topicStatus = "umbllocker/status";   // Mengirim status ke Backend

// --- DEFINISI PIN ---
#define OLED_SDA 21
#define OLED_SCL 22
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

#define RST_PIN 4
#define SS_PIN  5
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

bool pintuTerbuka = false;
int slotAktif = 0;
unsigned long waktuBuka = 0;
const unsigned long TIMEOUT_PINTU = 60000;

// Variabel untuk jeda 5 detik saat pintu ditutup
bool pintuSedangDitutup = false;
unsigned long waktuTutup = 0;
const unsigned long JEDA_KUNCI = 5000; 

// Deklarasi fungsi
void callback(char* topic, byte* payload, unsigned int length);
void reconnectMQTT();
void prosesBukaPintu(int slot);
void tutupPintuOtomatis();
void kunciPintu(int slot);
void tampilkanIdle();
void tampilkanQRDinamis();
void bunyikanBuzzer();

void setup() {
  Serial.begin(115200);
  
  // Inisialisasi OLED
  Wire.begin(OLED_SDA, OLED_SCL);
  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { for(;;); }
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);
  
  // Inisialisasi RFID
  SPI.begin();
  rfid.PCD_Init();
  
  // Inisialisasi Pin
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

  // Inisialisasi Servo
  servo1.attach(SERVO_1_PIN);
  servo2.attach(SERVO_2_PIN);
  servo4.attach(SERVO_4_PIN);
  servo5.attach(SERVO_5_PIN);
  servo1.write(0); servo2.write(0); servo4.write(0); servo5.write(0);

  // Koneksi WiFi
  display.clearDisplay();
  display.setCursor(0, 0);
  display.print("Menghubungkan WiFi...");
  display.display();
  
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("\nWiFi Terhubung!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // Setup MQTT
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
  
  tampilkanIdle();
}

void loop() {
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop(); // Wajib dipanggil agar MQTT berjalan

  // 1. Cek Tombol Push Button (Kirim status ke Web)
  if (digitalRead(BUTTON_PIN) == LOW) {
    delay(50);
    if (digitalRead(BUTTON_PIN) == LOW) {
      bunyikanBuzzer();
      tampilkanQRDinamis();
      
      // Kirim pesan ke MQTT (Web/Backend akan menerima ini)
      client.publish(topicStatus, "SESSION_START");
      Serial.println("Pesan MQTT Terkirim: SESSION_START");
      
      while(digitalRead(BUTTON_PIN) == LOW);
    }
  }

  // 2. Logika Timer Pintu Terbuka (1 Menit)
  if (pintuTerbuka) {
    unsigned long sisaWaktu = TIMEOUT_PINTU - (millis() - waktuBuka);
    
    if (sisaWaktu > 0) {
      display.clearDisplay();
      display.setCursor(0,0);
      display.print("Pintu Terbuka...");
      display.setCursor(0,20);
      display.print("Waktu: "); display.print(sisaWaktu / 1000); display.print("s");
      display.display();
    } else {
      tutupPintuOtomatis();
    }
  }

  // 3. Logika Limit Switch (Pintu Ditutup User) & Jeda 5 Detik
  if (pintuTerbuka) {
    bool sensorTertutup = false;
    if (slotAktif == 1 && digitalRead(LIMIT_SW_1) == LOW) sensorTertutup = true;
    if (slotAktif == 2 && digitalRead(LIMIT_SW_2) == LOW) sensorTertutup = true;
    if (slotAktif == 4 && digitalRead(LIMIT_SW_4) == LOW) sensorTertutup = true;
    if (slotAktif == 5 && digitalRead(LIMIT_SW_5) == LOW) sensorTertutup = true;

    // Jika pintu baru ditutup, mulai jeda 5 detik
    if (sensorTertutup && !pintuSedangDitutup) {
      pintuSedangDitutup = true;
      waktuTutup = millis();
      Serial.println("Pintu Terdeteksi Tertutup. Menunggu 5 detik...");
      
      display.clearDisplay();
      display.setCursor(0,0);
      display.print("Pintu Tertutup.");
      display.setCursor(0,20);
      display.print("Mengunci dalam 5s...");
      display.display();
    }
  }

  // 4. Eksekusi Kunci setelah Jeda 5 Detik
  if (pintuSedangDitutup) {
    if (millis() - waktuTutup >= JEDA_KUNCI) {
      kunciPintu(slotAktif);
      pintuTerbuka = false;
      pintuSedangDitutup = false;
      tampilkanIdle();
      
      // Beritahu Backend bahwa pintu sudah tertutup dan terkunci
      client.publish(topicStatus, "DOOR_CLOSED");
      Serial.println("Pesan MQTT Terkirim: DOOR_CLOSED");
    }
  }

  // 5. Cek RFID (Untuk Pengembalian / Pengambilan)
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      uid += String(rfid.uid.uidByte[i], HEX);
    }
    // Kirim UID ke Backend via MQTT
    String pesan = "RFID_SCAN:" + uid;
    client.publish(topicStatus, pesan.c_str());
    Serial.println("Pesan MQTT Terkirim: " + pesan);
    
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    delay(2000); // Debounce RFID
  }
}

// --- FUNGSI MQTT CALLBACK (Menerima perintah dari Backend Node.js) ---
void callback(char* topic, byte* payload, unsigned int length) {
  String pesan = "";
  for (int i = 0; i < length; i++) {
    pesan += (char)payload[i];
  }
  Serial.println("Pesan MQTT Diterima: " + pesan);

  // Format dari Node.js: UNLOCK_SLOT_1, UNLOCK_SLOT_4, dll.
  if (pesan.startsWith("UNLOCK_SLOT_")) {
    // Mengambil angka terakhir dari string (misal "UNLOCK_SLOT_1" -> 1)
    int slotDiminta = pesan.substring(12).toInt(); 
    prosesBukaPintu(slotDiminta);
  }
}

void reconnectMQTT() {
  while (!client.connected()) {
    Serial.print("Mencoba koneksi MQTT...");
    String clientId = "ESP32PayungTeduh-";
    clientId += String(random(0xffff), HEX);
    
    if (client.connect(clientId.c_str())) {
      Serial.println("Terhubung!");
      client.subscribe(topicCommand); // Berlangganan topik perintah
    } else {
      Serial.print("Gagal, rc=");
      Serial.print(client.state());
      Serial.println(" Coba lagi dalam 5 detik");
      delay(5000);
    }
  }
}

// --- FUNGSI BANTU ---
void prosesBukaPintu(int slot) {
  bool kondisiFisikOK = false;
  
  // Validasi Sensor IR
  if (slot == 1 || slot == 2) {
    // Loker Sewa: Harus ada payung (IR mendeteksi objek / LOW)
    if (slot == 1 && digitalRead(IR_1) == LOW) kondisiFisikOK = true;
    if (slot == 2 && digitalRead(IR_2) == LOW) kondisiFisikOK = true;
  } else if (slot == 4 || slot == 5) {
    // Loker Titip: Harus kosong (IR tidak mendeteksi objek / HIGH)
    if (slot == 4 && digitalRead(IR_4) == HIGH) kondisiFisikOK = true;
    if (slot == 5 && digitalRead(IR_5) == HIGH) kondisiFisikOK = true;
  }

  if (kondisiFisikOK) {
    if (slot == 1) servo1.write(90);
    if (slot == 2) servo2.write(90);
    if (slot == 4) servo4.write(90);
    if (slot == 5) servo5.write(90);

    slotAktif = slot;
    pintuTerbuka = true;
    pintuSedangDitutup = false; // Reset status penutupan
    waktuBuka = millis();
    
    bunyikanBuzzer();
    Serial.println("Pintu Berhasil Dibuka untuk Slot: " + String(slot));
  } else {
    // Gagal buka karena kondisi fisik tidak sesuai
    display.clearDisplay();
    display.setCursor(0,0);
    display.print("Gagal Buka Slot ");
    display.print(slot);
    display.setCursor(0,20);
    display.print("Cek Fisik Payung");
    display.display();
    delay(2000);
    tampilkanIdle();
    Serial.println("Gagal membuka pintu. Sensor IR tidak sesuai.");
  }
}

void tutupPintuOtomatis() {
  kunciPintu(slotAktif);
  pintuTerbuka = false;
  pintuSedangDitutup = false;
  tampilkanIdle();
  client.publish(topicStatus, "DOOR_TIMEOUT");
  Serial.println("Pintu dikunci otomatis karena waktu habis.");
}

void kunciPintu(int slot) {
  if (slot == 1) servo1.write(0);
  if (slot == 2) servo2.write(0);
  if (slot == 4) servo4.write(0);
  if (slot == 5) servo5.write(0);
}

void tampilkanIdle() {
  display.clearDisplay();

  display.ssd1306_command(SSD1306_SETCONTRAST);
  display.ssd1306_command(0xCF);

  display.setCursor(0, 10);
  display.print("SMART UMBRELLA");
  display.setCursor(0, 30);
  display.print("Tekan Tombol");
  display.setCursor(0, 40);
  display.print("Untuk Menampilkan");
  display.setCursor(0, 50);
  display.print("QR Code");
  display.display();
}

void tampilkanQRDinamis() {
  display.clearDisplay();
  display.ssd1306_command(SSD1306_SETCONTRAST);
  display.ssd1306_command(0x05);

  QRCodeGFX qrcode(display);
  String qrData = "http://192.168.100.26:3000/?session=" + String(millis());

  qrcode.setScale(2); 
  qrcode.draw(qrData.c_str(), 35, 2);
  
  display.display();
}

void bunyikanBuzzer() {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(200);
  digitalWrite(BUZZER_PIN, LOW);
}