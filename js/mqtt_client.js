// Broker WebSocket HiveMQ (Port 8000 untuk koneksi Browser HTML)
const broker = 'wss://broker.hivemq.com:8000/mqtt';
const topicCmd = 'umbllocker/command';
const topicStatus = 'umbllocker/status';

const client = mqtt.connect(broker);

const statusEl = document.getElementById('slot-status');
const cardEl = document.getElementById('slot-card');
const logEl = document.getElementById('system-log');

client.on('connect', () => {
  logEl.innerText = 'Terhubung ke HiveMQ Broker (PayungTeduh Active)';
  console.log('MQTT Connected via Browser');
  client.subscribe(topicStatus);
});

client.on('message', (topic, message) => {
  const msg = message.toString();
  logEl.innerText = `[Received]: ${msg}`;
  console.log(`Topic: ${topic} | Message: ${msg}`);

  // Logika Pembaruan Tampilan Berdasarkan Status dari ESP32
  if (msg === 'UNLOCKED_SLOT_1') {
    logEl.innerText = 'Loker 1 Berhasil Dibuka!';
  } else if (msg === 'SLOT_FILLED') {
    statusEl.innerText = 'ADA PAYUNG (TERISI)';
    cardEl.className = 'border-2 border-emerald-500 bg-emerald-50 rounded-xl p-5 mb-6';
    statusEl.className = 'text-xl font-black text-emerald-700 mt-1';
  } else if (msg === 'SLOT_EMPTY') {
    statusEl.innerText = 'KOSONG (DIPINJAM)';
    cardEl.className = 'border-2 border-amber-500 bg-amber-50 rounded-xl p-5 mb-6';
    statusEl.className = 'text-xl font-black text-amber-700 mt-1';
  } else if (msg.startsWith('RFID_TAP:')) {
    const uid = msg.split(':')[1];
    logEl.innerText = `Pengembalian RFID Tag Terbaca: ${uid}`;
  }
});

function unlockLocker() {
  logEl.innerText = 'Mengirim perintah buka loker ke ESP32...';
  client.publish(topicCmd, 'UNLOCK_SLOT_1');
}