require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Inisialisasi Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ ERROR: SUPABASE_URL atau SUPABASE_KEY belum diisi di file .env!');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

// Inisialisasi MQTT Broker (HiveMQ Public)
const mqttClient = mqtt.connect('mqtt://broker.hivemq.com:1883');
const topicCmd = 'umbllocker/command';
const topicStatus = 'umbllocker/status';

mqttClient.on('connect', () => {
  console.log('✅ Connected to HiveMQ Broker!');
  mqttClient.subscribe(topicStatus);
});

// 1. API ENDPOINT TRANSAKSI WEB (SEWA / TITIP)
app.post('/api/transaction', async (req, res) => {
  const { nama, email, bank, no_rek, type } = req.body;

  try {
    // A. Insert User Baru
    const { data: userData, error: userErr } = await supabase
      .from('users')
      .insert([{ 
        nama_lengkap: nama, 
        email: email, 
        bank_wallet: bank, 
        nomor_rekening: no_rek 
      }])
      .select();

    if (userErr) {
      console.error('❌ Error Insert User:', userErr);
      return res.status(400).json({ success: false, message: userErr.message });
    }

    const newUser = userData[0];

    // B. Cari Slot Loker Berdasarkan Logika FIFO
    let selectedLocker = null;

    if (type === 'SEWA') {
      // Cari loker sewa yang TERISI (is_occupied = TRUE) urut dari yang terlama
      const { data: lockers, error: lockErr } = await supabase
        .from('lockers')
        .select('*')
        .eq('category', 'SEWA')
        .eq('is_occupied', true)
        .order('last_status_change', { ascending: true })
        .order('position_order', { ascending: true });

      if (lockErr || !lockers || lockers.length === 0) {
        return res.status(400).json({ success: false, message: 'Maaf, Stok Payung Sewa Habis!' });
      }
      selectedLocker = lockers[0];

    } else if (type === 'TITIP') {
      // Cari loker titip yang KOSONG (is_occupied = FALSE) urut dari yang terlama
      const { data: lockers, error: lockErr } = await supabase
        .from('lockers')
        .select('*')
        .eq('category', 'TITIP')
        .eq('is_occupied', false)
        .order('last_status_change', { ascending: true })
        .order('position_order', { ascending: true });

      if (lockErr || !lockers || lockers.length === 0) {
        return res.status(400).json({ success: false, message: 'Maaf, Loker Titip Sedang Penuh!' });
      }
      selectedLocker = lockers[0];
    }

    // C. Hitung Biaya & Tenggat Waktu (Sewa: 48 Jam, Titip: 72 Jam)
    const jamTenggat = type === 'SEWA' ? 48 : 72;
    const waktuTenggat = new Date(Date.now() + jamTenggat * 60 * 60 * 1000);
    const biayaLayanan = type === 'SEWA' ? 5000 : 3000;
    const deposit = type === 'SEWA' ? 20000 : 3000;

    // D. Insert Transaksi Baru
    const { data: transData, error: transErr } = await supabase
      .from('transactions')
      .insert([{
        user_id: newUser.id,
        locker_id: selectedLocker.id,
        type: type,
        biaya_layanan: biayaLayanan,
        deposit_jaminan: deposit,
        total_bayar: biayaLayanan + deposit,
        waktu_tenggat: waktuTenggat.toISOString(),
        status_transaksi: 'ACTIVE'
      }])
      .select();

    if (transErr) {
      console.error('❌ Error Insert Transaction:', transErr);
      return res.status(400).json({ success: false, message: transErr.message });
    }

    // E. Kirim Perintah Buka Loker ke ESP32 via MQTT
    mqttClient.publish(topicCmd, `UNLOCK_${selectedLocker.slot_name}`);
    console.log(`📡 Perintah Terkirim ke ESP32: UNLOCK_${selectedLocker.slot_name}`);

    return res.json({
      success: true,
      message: `Pembayaran Berhasil! Membuka Pintu ${selectedLocker.slot_name}`,
      locker: selectedLocker.slot_name,
      transaction_id: transData[0].id
    });

  } catch (err) {
    console.error('❌ Server Internal Error:', err);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server backend.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server PayungTeduh Backend Running on Port ${PORT}`);
});