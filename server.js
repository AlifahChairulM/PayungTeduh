require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);
const mqttClient = mqtt.connect("mqtt://broker.hivemq.com:1883");
const topicCmd = "umbllocker/command";
const topicStatus = "umbllocker/status";

mqttClient.on("connect", () => {
  console.log("✅ Connected to HiveMQ Broker!");
  mqttClient.subscribe(topicStatus);
});

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// -------------------------------------------------------------
// 1. ENDPOINT: TRANSAKSI BARU (SEWA / TITIP)
// -------------------------------------------------------------
app.post("/api/transaction", async (req, res) => {
  const { nama, email, bank, no_rek, type } = req.body;
  const cleanEmail = email.trim().toLowerCase(); // Format email diseragamkan

  try {
    // Cek apakah user sudah ada, jika belum buat baru
    let userId;
    const { data: existingUsers } = await supabase
      .from("users")
      .select("id")
      .ilike("email", cleanEmail)
      .limit(1);

    if (existingUsers && existingUsers.length > 0) {
      userId = existingUsers[0].id;
    } else {
      const { data: newUser, error: uErr } = await supabase
        .from("users")
        .insert([
          {
            nama_lengkap: nama,
            email: cleanEmail,
            bank_wallet: bank,
            nomor_rekening: no_rek,
          },
        ])
        .select();

      if (uErr)
        return res.status(400).json({ success: false, message: uErr.message });
      userId = newUser[0].id;
    }

    const isSewa = type === "SEWA";

    // Cari loker yang sesuai
    const { data: lockers } = await supabase
      .from("lockers")
      .select("*")
      .eq("category", type)
      .eq("is_occupied", isSewa)
      .order("position_order", { ascending: true });

    if (!lockers || lockers.length === 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: isSewa ? "Stok Payung Habis!" : "Loker Titip Penuh!",
        });
    }
    const selectedLocker = lockers[0];

    const jamTenggat = isSewa ? 48 : 72;
    const waktuTenggat = new Date(Date.now() + jamTenggat * 60 * 60 * 1000);
    const biaya = isSewa ? 5000 : 3000;
    const deposit = isSewa ? 20000 : 3000;

    // Insert Transaksi Baru
    const { error: tErr } = await supabase.from("transactions").insert([
      {
        user_id: userId,
        locker_id: selectedLocker.id,
        type: type,
        biaya_layanan: biaya,
        deposit_jaminan: deposit,
        total_bayar: biaya + deposit,
        waktu_tenggat: waktuTenggat.toISOString(),
        status_transaksi: "ACTIVE",
      },
    ]);

    if (tErr)
      return res.status(400).json({ success: false, message: tErr.message });

    // Update Status Loker
    await supabase
      .from("lockers")
      .update({ is_occupied: !isSewa, last_status_change: new Date() })
      .eq("id", selectedLocker.id);

    mqttClient.publish(topicCmd, `UNLOCK_${selectedLocker.slot_name}`);
    console.log(`📡 Open Door: UNLOCK_${selectedLocker.slot_name}`);

    return res.json({
      success: true,
      message: `Pembayaran Berhasil! Membuka Pintu ${selectedLocker.slot_name}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------------------------------------------------
// 2. ENDPOINT: REQUEST OTP
// -------------------------------------------------------------
app.post("/api/request-otp", async (req, res) => {
  const { email, type } = req.body;
  if (!email)
    return res
      .status(400)
      .json({ success: false, message: "Email tidak boleh kosong!" });

  const cleanEmail = email.trim().toLowerCase();

  try {
    // 1. Cari semua ID user yang cocok dengan email ini
    const { data: users } = await supabase
      .from("users")
      .select("id")
      .ilike("email", cleanEmail);

    if (!users || users.length === 0) {
      return res
        .status(404)
        .json({
          success: false,
          message: "Data Email tidak ditemukan dalam sistem!",
        });
    }

    const userIds = users.map((u) => u.id);

    // 2. Cari transaksi ACTIVE milik salah satu user_id tersebut
    const { data: trans } = await supabase
      .from("transactions")
      .select("*")
      .in("user_id", userIds)
      .eq("type", type)
      .eq("status_transaksi", "ACTIVE")
      .order("id", { ascending: false })
      .limit(1);

    if (!trans || trans.length === 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: `Tidak ada transaksi ${type} aktif untuk email ini.`,
        });
    }

    // 3. Generate Kode OTP
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await supabase
      .from("otp_codes")
      .insert([
        {
          email: cleanEmail,
          otp_code: otp,
          expires_at: expiresAt.toISOString(),
        },
      ]);

    console.log(
      `📧 [EMAIL OTP] Kode OTP untuk ${cleanEmail} (${type}): ${otp}`,
    );

    return res.json({
      success: true,
      message: `Kode OTP verifikasi telah dikirim ke email. (Cek terminal backend untuk OTP!)`,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan server." });
  }
});

// -------------------------------------------------------------
// 3. ENDPOINT: VERIFIKASI OTP
// -------------------------------------------------------------
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp, type } = req.body;
  if (!email || !otp)
    return res
      .status(400)
      .json({ success: false, message: "Email dan OTP wajib diisi!" });

  const cleanEmail = email.trim().toLowerCase();

  try {
    // 1. Validasi OTP
    const { data: validOtp } = await supabase
      .from("otp_codes")
      .select("*")
      .ilike("email", cleanEmail)
      .eq("otp_code", otp.trim())
      .gt("expires_at", new Date().toISOString())
      .order("id", { ascending: false })
      .limit(1);

    if (!validOtp || validOtp.length === 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Kode OTP Salah atau Sudah Kadaluwarsa!",
        });
    }

    // 2. Cari transaksi aktif
    const { data: users } = await supabase
      .from("users")
      .select("id")
      .ilike("email", cleanEmail);
    const userIds = users.map((u) => u.id);

    const { data: trans } = await supabase
      .from("transactions")
      .select("*, lockers(*)")
      .in("user_id", userIds)
      .eq("type", type)
      .eq("status_transaksi", "ACTIVE")
      .order("id", { ascending: false })
      .limit(1);

    if (!trans || trans.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Transaksi aktif tidak ditemukan." });
    }

    const activeTrans = trans[0];
    const isSewa = type === "SEWA";

    let refundMessage = "";
    let depositKembali = activeTrans.deposit_jaminan;
    let denda = 0;

    // Hitung Keterlambatan khusus untuk SEWA
    if (isSewa) {
      const waktuTenggat = new Date(activeTrans.waktu_tenggat);
      const sekarang = new Date();

      if (sekarang > waktuTenggat) {
        // Hitung berapa jam keterlambatan
        const selisihJam = Math.ceil(
          (sekarang - waktuTenggat) / (1000 * 60 * 60),
        );

        if (selisihJam <= 24) {
          denda = 5000;
        } else if (selisihJam <= 48) {
          denda = 10000;
        } else {
          denda = activeTrans.deposit_jaminan; // Denda maksimal (20.000)
        }

        depositKembali = Math.max(0, activeTrans.deposit_jaminan - denda);

        if (depositKembali > 0) {
          refundMessage = `⚠️ Terlambat ${selisihJam} jam! Terkena denda Rp ${denda.toLocaleString("id-ID")}. Sisa deposit Rp ${depositKembali.toLocaleString("id-ID")} dikembalikan ke rekening/e-wallet Anda.`;
        } else {
          refundMessage = `❌ Terlambat melebihi batas maksimal! Uang deposit Rp ${activeTrans.deposit_jaminan.toLocaleString("id-ID")} HANGUS (tidak dikembalikan).`;
        }
      } else {
        refundMessage = `🎉 Pengembalian Tepat Waktu! Uang jaminan Rp ${depositKembali.toLocaleString("id-ID")} dikembalikan penuh ke rekening/e-wallet Anda.`;
      }
    } else {
      // Untuk TITIP
      refundMessage = `Payung titipan berhasil diambil! Terima kasih telah menggunakan PayungTeduh.`;
    }

    // 3. Update status transaksi & loker di Supabase
    await supabase
      .from("transactions")
      .update({ status_transaksi: "COMPLETED" })
      .eq("id", activeTrans.id);
    await supabase
      .from("lockers")
      .update({ is_occupied: isSewa, last_status_change: new Date() })
      .eq("id", activeTrans.locker_id);

    // 4. Kirim sinyal MQTT ke ESP32
    mqttClient.publish(topicCmd, `UNLOCK_${activeTrans.lockers.slot_name}`);
    console.log(
      `🔓 OTP Terverifikasi! Membuka Pintu ${activeTrans.lockers.slot_name}`,
    );

    return res.json({
      success: true,
      message: `Verifikasi Berhasil! Pintu ${activeTrans.lockers.slot_name} Terbuka.`,
      info_refund: refundMessage,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, message: "Gagal memproses verifikasi." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server PayungTeduh Running on Port ${PORT}`);
});
