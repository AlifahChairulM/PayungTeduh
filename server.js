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
  process.env.SUPABASE_KEY
);
const mqttClient = mqtt.connect("mqtt://broker.hivemq.com:1883");
const topicCmd = "umbllocker/command";
const topicStatus = "umbllocker/status";

let sseClients = [];
let irState = { ir1: 1, ir2: 1, ir4: 0, ir5: 0 };

mqttClient.on("connect", () => {
  console.log("✅ Connected to HiveMQ Broker!");
  mqttClient.subscribe(topicStatus);
});

mqttClient.on("message", (topic, message) => {
  const msg = message.toString();
  console.log(`📡 MQTT Received [${topic}]: ${msg}`);

  if (msg.startsWith("IR_STATE:")) {
    const parts = msg.replace("IR_STATE:", "").split(",").map(Number);
    irState.ir1 = parts[0];
    irState.ir2 = parts[1];
    irState.ir4 = parts[2];
    irState.ir5 = parts[3];
  } else if (msg.startsWith("RFID_VALID:")) {
    const uid = msg.split(":")[1];
    broadcastSSE({ type: "RFID_SUCCESS", uid: uid, message: "🎉 Stiker Valid! Pintu Loker Berhasil Dibuka." });
  } else if (msg === "RFID_INVALID") {
    broadcastSSE({ type: "RFID_FAILED", message: "❌ Akses Ditolak! Stiker Bukan Milik Persewaan." });
  }
});

function broadcastSSE(data) {
  sseClients.forEach((client) => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c.id !== clientId);
  });
});

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// -------------------------------------------------------------
// 1. TRANSAKSI BARU (SEWA / TITIP)
// -------------------------------------------------------------
app.post("/api/transaction", async (req, res) => {
  const { nama, email, bank, no_rek, type } = req.body;
  const cleanEmail = email.trim().toLowerCase();

  try {
    const isSewa = type === "SEWA";
    let targetSlotName = null;

    if (isSewa) {
      if (irState.ir1 === 1) targetSlotName = "SEWA_1";
      else if (irState.ir2 === 1) targetSlotName = "SEWA_2";
      else return res.status(400).json({ success: false, message: "Stok Payung Habis! (IR mendeteksi sewa kosong)" });
    } else {
      if (irState.ir4 === 0) targetSlotName = "TITIP_1";
      else if (irState.ir5 === 0) targetSlotName = "TITIP_2";
      else return res.status(400).json({ success: false, message: "Loker Titip Penuh! (IR mendeteksi titip terisi)" });
    }

    const { data: lockers } = await supabase.from("lockers").select("*").eq("slot_name", targetSlotName).limit(1);
    if (!lockers || lockers.length === 0) {
      return res.status(400).json({ success: false, message: `Loker '${targetSlotName}' tidak ditemukan!` });
    }
    const selectedLocker = lockers[0];

    let userId;
    const { data: existingUsers } = await supabase.from("users").select("id").ilike("email", cleanEmail).limit(1);

    if (existingUsers && existingUsers.length > 0) {
      userId = existingUsers[0].id;
    } else {
      const { data: newUser, error: uErr } = await supabase
        .from("users")
        .insert([{ nama_lengkap: nama, email: cleanEmail, bank_wallet: bank, nomor_rekening: no_rek }])
        .select();

      if (uErr) return res.status(400).json({ success: false, message: uErr.message });
      userId = newUser[0].id;
    }

    const jamTenggat = isSewa ? 48 : 72;
    const waktuTenggat = new Date(Date.now() + jamTenggat * 60 * 60 * 1000);
    const biaya = isSewa ? 5000 : 3000;
    const deposit = isSewa ? 20000 : 3000;

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

    if (tErr) return res.status(400).json({ success: false, message: tErr.message });

    await supabase.from("lockers").update({ is_occupied: !isSewa, last_status_change: new Date() }).eq("id", selectedLocker.id);

    mqttClient.publish(topicCmd, `UNLOCK_${selectedLocker.slot_name}`);
    console.log(`📡 Open Door Sent: UNLOCK_${selectedLocker.slot_name}`);

    return res.json({ success: true, message: `Pembayaran Berhasil! Membuka Pintu ${selectedLocker.slot_name}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------------------------------------------------
// 2. REQUEST KODE OTP (EMAIL)
// -------------------------------------------------------------
app.post("/api/request-otp", async (req, res) => {
  const { email, type } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email wajib diisi!" });
  const cleanEmail = email.trim().toLowerCase();

  try {
    const { data: users } = await supabase.from("users").select("id").ilike("email", cleanEmail);
    if (!users || users.length === 0) return res.status(404).json({ success: false, message: "Email tidak ditemukan!" });

    const userIds = users.map((u) => u.id);
    const { data: trans } = await supabase
      .from("transactions")
      .select("*")
      .in("user_id", userIds)
      .eq("type", type)
      .eq("status_transaksi", "ACTIVE")
      .order("id", { ascending: false })
      .limit(1);

    if (!trans || trans.length === 0) return res.status(400).json({ success: false, message: `Tidak ada transaksi ${type} yang aktif untuk email ini.` });

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await supabase.from("otp_codes").insert([{ email: cleanEmail, otp_code: otp, expires_at: expiresAt.toISOString() }]);

    console.log(`📧 [EMAIL OTP] Kode OTP untuk ${cleanEmail} (${type}): ${otp}`);
    return res.json({ success: true, message: `Kode OTP verifikasi terkirim!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Gagal meminta kode OTP." });
  }
});

// -------------------------------------------------------------
// 3. VERIFIKASI KODE OTP
// -------------------------------------------------------------
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp, type } = req.body;
  if (!email || !otp) return res.status(400).json({ success: false, message: "Email dan OTP wajib diisi!" });
  const cleanEmail = email.trim().toLowerCase();

  try {
    const { data: validOtp } = await supabase
      .from("otp_codes")
      .select("*")
      .ilike("email", cleanEmail)
      .eq("otp_code", otp.trim())
      .gt("expires_at", new Date().toISOString())
      .order("id", { ascending: false })
      .limit(1);

    if (!validOtp || validOtp.length === 0) {
      return res.status(400).json({ success: false, message: "Kode OTP Salah atau Kadaluwarsa!" });
    }

    const { data: users } = await supabase.from("users").select("id").ilike("email", cleanEmail);
    if (!users || users.length === 0) return res.status(404).json({ success: false, message: "Email tidak ditemukan!" });
    const userIds = users.map((u) => u.id);

    const { data: trans } = await supabase
      .from("transactions")
      .select("*, lockers(*)")
      .in("user_id", userIds)
      .eq("type", type)
      .eq("status_transaksi", "ACTIVE")
      .order("id", { ascending: false })
      .limit(1);

    if (!trans || trans.length === 0) return res.status(400).json({ success: false, message: `Tidak ada transaksi ${type} aktif.` });

    const activeTrans = trans[0];
    const isSewa = type === "SEWA";
    let refundMessage = "";
    let depositKembali = activeTrans.deposit_jaminan;

    if (isSewa) {
      const waktuTenggat = new Date(activeTrans.waktu_tenggat);
      const sekarang = new Date();
      if (sekarang > waktuTenggat) {
        const selisihJam = Math.ceil((sekarang - waktuTenggat) / (1000 * 60 * 60));
        const denda = selisihJam <= 24 ? 5000 : selisihJam <= 48 ? 10000 : activeTrans.deposit_jaminan;
        depositKembali = Math.max(0, activeTrans.deposit_jaminan - denda);
        refundMessage = depositKembali > 0 ? `⚠️ Terlambat ${selisihJam} jam! Denda Rp ${denda.toLocaleString("id-ID")}.` : `❌ Deposit Hangus!`;
      } else {
        refundMessage = `🎉 Pengembalian Tepat Waktu! Deposit Rp ${depositKembali.toLocaleString("id-ID")} dikembalikan.`;
      }
    } else {
      refundMessage = `Payung titipan berhasil diambil!`;
    }

    await supabase.from("transactions").update({ status_transaksi: "COMPLETED" }).eq("id", activeTrans.id);
    await supabase.from("lockers").update({ is_occupied: isSewa, last_status_change: new Date() }).eq("id", activeTrans.locker_id);

    const commandPayload = `UNLOCK_${activeTrans.lockers.slot_name}`;
    mqttClient.publish(topicCmd, commandPayload);
    console.log(`🔓 OTP Valid! Membuka Pintu ${commandPayload}`);

    return res.json({
      success: true,
      message: `Verifikasi Berhasil! Membuka Pintu ${activeTrans.lockers.slot_name}`,
      info_refund: refundMessage
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Gagal memproses verifikasi." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server PayungTeduh Running on Port ${PORT}`);
});