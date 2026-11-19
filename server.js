require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);
const mqttClient = mqtt.connect("mqtt://broker.hivemq.com:1883");
const topicCmd = "umbllocker/command";
const topicStatus = "umbllocker/status";

let sseClients = [];
let irState = { ir1: 1, ir2: 1, ir4: 0, ir5: 0 };
let irConnected = false;

let activeNfcSession = {
  unlocked: false,
  uid: null,
  expiresAt: 0,
};

async function calculateLiveAvailability() {
  const irSewa = (irState.ir1 === 1 ? 1 : 0) + (irState.ir2 === 1 ? 1 : 0);
  const irTitip = (irState.ir4 === 0 ? 1 : 0) + (irState.ir5 === 0 ? 1 : 0);

  // Jika ESP32 sudah terhubung dan mengirim data IR, tampilkan kondisi fisik real-time
  if (irConnected) {
    return { sewaTersedia: irSewa, titipKosong: irTitip, irConnected: true };
  }

  // Fallback dari database hanya jika ESP32 belum terhubung
  try {
    const { data: activeTx } = await supabase
      .from("transactions")
      .select("type")
      .eq("status_transaksi", "ACTIVE");

    const activeSewaCount = (activeTx || []).filter((t) => t.type === "SEWA").length;
    const activeTitipCount = (activeTx || []).filter((t) => t.type === "TITIP").length;

    return {
      sewaTersedia: Math.max(0, 2 - activeSewaCount),
      titipKosong: Math.max(0, 2 - activeTitipCount),
      irConnected: false,
    };
  } catch (err) {
    return { sewaTersedia: irSewa, titipKosong: irTitip, irConnected: false };
  }
}

mqttClient.on("connect", () => {
  console.log("✅ Connected to HiveMQ Broker!");
  mqttClient.subscribe(topicStatus);
});

mqttClient.on("message", async (topic, message) => {
  const msg = message.toString();
  console.log(`📡 MQTT Received [${topic}]: ${msg}`);

  if (msg.startsWith("IR_STATE:")) {
    const parts = msg.replace("IR_STATE:", "").split(",").map(Number);
    irState.ir1 = parts[0];
    irState.ir2 = parts[1];
    irState.ir4 = parts[2];
    irState.ir5 = parts[3];
    irConnected = true;

    const live = await calculateLiveAvailability();
    broadcastSSE({
      type: "IR_UPDATE",
      ...live,
    });
  } else if (msg === "SYSTEM_ACTIVATED") {
    broadcastSSE({
      type: "SYSTEM_ACTIVATED",
      message: "🔘 Tombol ditekan! Silakan tempelkan HP NFC ke reader RC522.",
    });
  } else if (msg.startsWith("NFC_SESSION_START:")) {
    const uid = msg.split(":")[1] || "HP_NFC";
    activeNfcSession = {
      unlocked: true,
      uid,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    broadcastSSE({
      type: "NFC_UNLOCKED",
      uid,
      message: "📱 NFC HP Terdeteksi! Silakan isi keperluan Anda.",
    });
  } else if (msg.startsWith("RFID_VALID:")) {
    const uid = msg.split(":")[1];
    try {
      const { data: activeSewa } = await supabase
        .from("transactions")
        .select("*")
        .eq("type", "SEWA")
        .eq("status_transaksi", "ACTIVE")
        .order("id", { ascending: false })
        .limit(1);

      if (activeSewa && activeSewa.length > 0) {
        const tx = activeSewa[0];
        await supabase
          .from("transactions")
          .update({
            status_transaksi: "COMPLETED",
            waktu_kembali: new Date().toISOString(),
          })
          .eq("id", tx.id);
        await supabase
          .from("lockers")
          .update({ is_occupied: true, last_status_change: new Date() })
          .eq("id", tx.locker_id);
        await supabase.from("otp_codes").delete().eq("user_id", tx.user_id);
        console.log(
          `✅ Transaksi SEWA #${tx.id} ditutup otomatis via RFID (${uid})`,
        );
      }
    } catch (err) {
      console.error("Gagal update transaksi saat RFID_VALID:", err.message);
    }

    const live = await calculateLiveAvailability();
    broadcastSSE({ type: "IR_UPDATE", ...live });

    broadcastSSE({
      type: "RFID_SUCCESS",
      uid: uid,
      message:
        "🎉 Stiker Valid! Pintu Loker Berhasil Dibuka & Transaksi Selesai.",
    });
  } else if (msg === "RFID_INVALID") {
    broadcastSSE({
      type: "RFID_FAILED",
      message: "❌ Tekan tombol push button terlebih dahulu sebelum tap HP.",
    });
  } else if (msg === "DOOR_CLOSED") {
    activeNfcSession = { unlocked: false, uid: null, expiresAt: 0 };
    broadcastSSE({
      type: "DOOR_CLOSED",
      message: "🔒 Pintu loker telah ditutup dan dikunci aman. Terima kasih!",
    });
  } else if (msg === "DOOR_TIMEOUT") {
    activeNfcSession = { unlocked: false, uid: null, expiresAt: 0 };
    broadcastSSE({
      type: "DOOR_TIMEOUT",
      message: "⏱️ Waktu buka pintu habis, loker dikunci otomatis.",
    });
  }
});

app.get("/api/session-status", (req, res) => {
  const isValid =
    activeNfcSession.unlocked && Date.now() < activeNfcSession.expiresAt;
  if (!isValid) activeNfcSession.unlocked = false;
  res.json({ unlocked: isValid, expiresAt: activeNfcSession.expiresAt });
});

app.get("/api/availability", async (req, res) => {
  const live = await calculateLiveAvailability();
  res.json({
    success: true,
    ...live,
  });
});

app.post("/api/session-lock", (req, res) => {
  activeNfcSession = { unlocked: false, uid: null, expiresAt: 0 };
  res.json({ success: true });
});

app.post("/api/oled-status", (req, res) => {
  const { status } = req.body;
  if (status) {
    mqttClient.publish(topicCmd, `OLED:${status}`);
  }
  res.json({ success: true });
});

function broadcastSSE(data) {
  sseClients.forEach((client) =>
    client.res.write(`data: ${JSON.stringify(data)}\n\n`),
  );
}

app.get("/api/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  const live = await calculateLiveAvailability();
  res.write(`data: ${JSON.stringify({ type: "IR_UPDATE", ...live })}\n\n`);

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c.id !== clientId);
  });
});

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// -------------------------------------------------------------
// 1. TRANSAKSI BARU (SEWA / TITIP + DETAIL PEMOTONGAN SALDO)
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
      else
        return res
          .status(400)
          .json({
            success: false,
            message: "Stok Payung Habis! (IR mendeteksi loker sewa kosong)",
          });
    } else {
      if (irState.ir4 === 0) targetSlotName = "TITIP_1";
      else if (irState.ir5 === 0) targetSlotName = "TITIP_2";
      else
        return res
          .status(400)
          .json({
            success: false,
            message: "Loker Titip Penuh! (IR mendeteksi loker titip terisi)",
          });
    }

    const { data: lockers } = await supabase
      .from("lockers")
      .select("*")
      .eq("slot_name", targetSlotName)
      .limit(1);
    if (!lockers || lockers.length === 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: `Loker '${targetSlotName}' tidak ditemukan!`,
        });
    }
    const selectedLocker = lockers[0];

    let userId;
    const { data: existingUsers } = await supabase
      .from("users")
      .select("id")
      .ilike("email", cleanEmail)
      .limit(1);

    if (existingUsers && existingUsers.length > 0) {
      userId = existingUsers[0].id;
      await supabase
        .from("users")
        .update({
          nama_lengkap: nama,
          bank_wallet: bank,
          nomor_rekening: no_rek,
        })
        .eq("id", userId);
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

    const jamTenggat = isSewa ? 48 : 72;
    const waktuTenggat = new Date(Date.now() + jamTenggat * 60 * 60 * 1000);
    const biaya = isSewa ? 5000 : 3000;
    const deposit = isSewa ? 20000 : 3000;
    const totalBayar = biaya + deposit;

    const { error: tErr } = await supabase.from("transactions").insert([
      {
        user_id: userId,
        locker_id: selectedLocker.id,
        type: type,
        biaya_layanan: biaya,
        deposit_jaminan: deposit,
        total_bayar: totalBayar,
        waktu_tenggat: waktuTenggat.toISOString(),
        status_transaksi: "ACTIVE",
      },
    ]);

    if (tErr)
      return res.status(400).json({ success: false, message: tErr.message });

    await supabase
      .from("lockers")
      .update({ is_occupied: !isSewa, last_status_change: new Date() })
      .eq("id", selectedLocker.id);

    const commandPayload = `UNLOCK:${selectedLocker.slot_name}:${type}`;
    mqttClient.publish(topicCmd, commandPayload);
    console.log(
      `📡 Open Door Sent: ${commandPayload} | Total Potong: Rp ${totalBayar} (${bank})`,
    );

    const live = await calculateLiveAvailability();
    broadcastSSE({ type: "IR_UPDATE", ...live });

    return res.json({
      success: true,
      message: `Pembayaran Berhasil! Membuka Pintu ${selectedLocker.slot_name}`,
      receipt: {
        nama,
        type,
        slot_name: selectedLocker.slot_name,
        bank,
        no_rek,
        biaya,
        deposit,
        total_bayar: totalBayar,
        waktu_tenggat: waktuTenggat.toISOString(),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------------------------------------------------
// 2. REQUEST KODE OTP (HAPUS OTP LAMA SEBELUM BUAT BARU)
// -------------------------------------------------------------
app.post("/api/request-otp", async (req, res) => {
  const { email, type } = req.body;
  if (!email)
    return res
      .status(400)
      .json({ success: false, message: "Email wajib diisi!" });
  const cleanEmail = email.trim().toLowerCase();

  try {
    const { data: users } = await supabase
      .from("users")
      .select("id")
      .ilike("email", cleanEmail)
      .order("id", { ascending: false });
    if (!users || users.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Email tidak ditemukan!" });

    const userIds = users.map((u) => u.id);
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
          message: `Tidak ada transaksi ${type} yang aktif untuk email ini.`,
        });
    }

    const activeUserId = trans[0].user_id;
    await supabase.from("otp_codes").delete().in("user_id", userIds);

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const { error: otpErr } = await supabase.from("otp_codes").insert([
      {
        user_id: activeUserId,
        email: cleanEmail,
        otp_code: otp,
        expires_at: expiresAt.toISOString(),
      },
    ]);

    if (otpErr) {
      console.error("Gagal simpan OTP:", otpErr.message);
      return res
        .status(400)
        .json({
          success: false,
          message: "Gagal membuat OTP: " + otpErr.message,
        });
    }

    console.log(
      `📧 [EMAIL OTP] Kode OTP untuk User ID #${activeUserId} (${cleanEmail} - ${type}): ${otp}`,
    );
    return res.json({
      success: true,
      message: `Kode OTP verifikasi terkirim!`,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, message: "Gagal meminta kode OTP." });
  }
});

// -------------------------------------------------------------
// 3. VERIFIKASI KODE OTP (SEKALI PAKAI — LANGSUNG HAPUS OTP)
// -------------------------------------------------------------
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp, type } = req.body;
  if (!email || !otp)
    return res
      .status(400)
      .json({ success: false, message: "Email dan OTP wajib diisi!" });
  const cleanEmail = email.trim().toLowerCase();

  try {
    const { data: users } = await supabase
      .from("users")
      .select("id")
      .ilike("email", cleanEmail);
    if (!users || users.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Email tidak ditemukan!" });
    const userIds = users.map((u) => u.id);

    const { data: validOtp } = await supabase
      .from("otp_codes")
      .select("*")
      .in("user_id", userIds)
      .eq("otp_code", otp.trim())
      .gt("expires_at", new Date().toISOString())
      .order("id", { ascending: false })
      .limit(1);

    if (!validOtp || validOtp.length === 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Kode OTP Salah, Sudah Dipakai, atau Kadaluwarsa!",
        });
    }

    const { data: trans } = await supabase
      .from("transactions")
      .select("*")
      .in("user_id", userIds)
      .eq("type", type)
      .eq("status_transaksi", "ACTIVE")
      .order("id", { ascending: false })
      .limit(1);

    if (!trans || trans.length === 0) {
      await supabase.from("otp_codes").delete().in("user_id", userIds);
      return res
        .status(400)
        .json({
          success: false,
          message: `Tidak ada transaksi ${type} aktif.`,
        });
    }

    const activeTrans = trans[0];
    const { data: lockerData } = await supabase
      .from("lockers")
      .select("*")
      .eq("id", activeTrans.locker_id)
      .limit(1);
    const slotName =
      lockerData && lockerData.length > 0 ? lockerData[0].slot_name : "SEWA_1";

    const isSewa = type === "SEWA";
    let refundMessage = "";
    let depositKembali = activeTrans.deposit_jaminan;

    if (isSewa) {
      const waktuTenggat = new Date(activeTrans.waktu_tenggat);
      const sekarang = new Date();
      if (sekarang > waktuTenggat) {
        const selisihJam = Math.ceil(
          (sekarang - waktuTenggat) / (1000 * 60 * 60),
        );
        const denda =
          selisihJam <= 24
            ? 5000
            : selisihJam <= 48
              ? 10000
              : activeTrans.deposit_jaminan;
        depositKembali = Math.max(0, activeTrans.deposit_jaminan - denda);
        refundMessage =
          depositKembali > 0
            ? `⚠️ Terlambat ${selisihJam} jam! Denda Rp ${denda.toLocaleString("id-ID")}.`
            : `❌ Deposit Hangus!`;
      } else {
        refundMessage = `🎉 Pengembalian Tepat Waktu! Deposit Rp ${depositKembali.toLocaleString("id-ID")} dikembalikan.`;
      }
    } else {
      refundMessage = `Payung titipan berhasil diambil!`;
    }

    await supabase
      .from("transactions")
      .update({
        status_transaksi: "COMPLETED",
        waktu_kembali: new Date().toISOString(),
      })
      .eq("id", activeTrans.id);
    await supabase
      .from("lockers")
      .update({ is_occupied: isSewa, last_status_change: new Date() })
      .eq("id", activeTrans.locker_id);
    await supabase.from("otp_codes").delete().in("user_id", userIds);

    const actionMode = type === "SEWA" ? "RETURN" : "RETRIEVE";
    const commandPayload = `UNLOCK:${slotName}:${actionMode}`;
    mqttClient.publish(topicCmd, commandPayload);
    console.log(
      `🔓 OTP Valid (Hangus Terpakai)! Membuka Pintu ${commandPayload}`,
    );

    const live = await calculateLiveAvailability();
    broadcastSSE({ type: "IR_UPDATE", ...live });

    return res.json({
      success: true,
      message: `Verifikasi Berhasil! Membuka Pintu ${slotName}`,
      info_refund: refundMessage,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, message: "Gagal memproses verifikasi." });
  }
});

// -------------------------------------------------------------
// 4. ENDPOINT ADMIN DASHBOARD & CRUD (UPDATE + DELETE)
// -------------------------------------------------------------
function verifyAdmin(req, res) {
  const adminPass = req.headers["x-admin-password"];
  const validPass = process.env.ADMIN_PASSWORD || "infonekak";
  if (!adminPass || adminPass !== validPass) {
    res.status(401).json({ success: false, message: "Password Admin Salah!" });
    return false;
  }
  return true;
}

// READ: Ambil semua data dashboard
app.get("/api/admin/dashboard", async (req, res) => {
  if (!verifyAdmin(req, res)) return;

  try {
    const [lockersRes, usersRes, transRes] = await Promise.all([
      supabase.from("lockers").select("*").order("id", { ascending: true }),
      supabase.from("users").select("*"),
      supabase
        .from("transactions")
        .select("*")
        .order("id", { ascending: false })
        .limit(50),
    ]);

    const lockers = lockersRes.data || [];
    const users = usersRes.data || [];
    const rawTransactions = transRes.data || [];

    const userMap = {};
    users.forEach((u) => {
      userMap[u.id] = u;
    });

    const lockerMap = {};
    lockers.forEach((l) => {
      lockerMap[l.id] = l;
    });

    const transactions = rawTransactions.map((t) => ({
      ...t,
      users: userMap[t.user_id] || {
        nama_lengkap: "User #" + t.user_id,
        email: "-",
        bank_wallet: "-",
        nomor_rekening: "-",
      },
      lockers: lockerMap[t.locker_id] || {
        slot_name: "Loker #" + t.locker_id,
        category: t.type,
      },
    }));

    return res.json({
      success: true,
      lockers,
      irState,
      transactions,
    });
  } catch (err) {
    console.error("Admin Dashboard Error:", err);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat data dashboard admin." });
  }
});

// UPDATE: Edit data transaksi/user ATAU selesaikan paksa transaksi aktif
app.put("/api/admin/transactions/:id", async (req, res) => {
  if (!verifyAdmin(req, res)) return;

  const txId = req.params.id;
  const { action, nama_lengkap, email, bank_wallet, nomor_rekening, waktu_tenggat, status_transaksi } = req.body;

  try {
    const { data: txList, error: fetchErr } = await supabase
      .from("transactions")
      .select("*")
      .eq("id", txId)
      .limit(1);

    if (fetchErr) {
      return res.status(400).json({ success: false, message: fetchErr.message });
    }
    if (!txList || txList.length === 0) {
      return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan." });
    }
    const tx = txList[0];

    // Mode 1: Selesaikan paksa transaksi aktif
    if (action === "COMPLETE") {
      const isSewa = tx.type === "SEWA";
      const { data: updatedTx, error: updErr } = await supabase
        .from("transactions")
        .update({
          status_transaksi: "COMPLETED",
          waktu_kembali: new Date().toISOString(),
        })
        .eq("id", txId)
        .select();

      if (updErr) {
        return res.status(400).json({ success: false, message: updErr.message });
      }
      if (!updatedTx || updatedTx.length === 0) {
        return res.status(403).json({
          success: false,
          message: "Update diblokir Supabase RLS! Jalankan DISABLE ROW LEVEL SECURITY di SQL Editor.",
        });
      }

      await supabase
        .from("lockers")
        .update({ is_occupied: isSewa, last_status_change: new Date() })
        .eq("id", tx.locker_id);

      await supabase.from("otp_codes").delete().eq("user_id", tx.user_id);

      const live = await calculateLiveAvailability();
      broadcastSSE({ type: "IR_UPDATE", ...live });

      return res.json({ success: true, message: `Transaksi #${txId} berhasil diselesaikan.` });
    }

    // Mode 2: Update data pengguna & detail transaksi dari modal edit
    if (tx.user_id && (nama_lengkap !== undefined || email !== undefined || bank_wallet !== undefined || nomor_rekening !== undefined)) {
      const userUpdates = {};
      if (nama_lengkap !== undefined) userUpdates.nama_lengkap = nama_lengkap.trim();
      if (email !== undefined) userUpdates.email = email.trim().toLowerCase();
      if (bank_wallet !== undefined) userUpdates.bank_wallet = bank_wallet.trim();
      if (nomor_rekening !== undefined) userUpdates.nomor_rekening = nomor_rekening.trim();

      const { data: updatedUser, error: userErr } = await supabase
        .from("users")
        .update(userUpdates)
        .eq("id", tx.user_id)
        .select();

      if (userErr) {
        return res.status(400).json({ success: false, message: userErr.message });
      }
      if (!updatedUser || updatedUser.length === 0) {
        return res.status(403).json({
          success: false,
          message: "Update user diblokir Supabase RLS! Jalankan DISABLE ROW LEVEL SECURITY di SQL Editor.",
        });
      }
    }

    const txUpdates = {};
    if (waktu_tenggat) {
      const parsedDate = new Date(waktu_tenggat);
      if (!isNaN(parsedDate.getTime())) {
        txUpdates.waktu_tenggat = parsedDate.toISOString();
      }
    }
    if (status_transaksi && status_transaksi !== tx.status_transaksi) {
      txUpdates.status_transaksi = status_transaksi;
      if (status_transaksi === "COMPLETED" && !tx.waktu_kembali) {
        txUpdates.waktu_kembali = new Date().toISOString();
      }
    }

    if (Object.keys(txUpdates).length > 0) {
      const { data: updatedTx, error: txErr } = await supabase
        .from("transactions")
        .update(txUpdates)
        .eq("id", txId)
        .select();

      if (txErr) {
        return res.status(400).json({ success: false, message: txErr.message });
      }
      if (!updatedTx || updatedTx.length === 0) {
        return res.status(403).json({
          success: false,
          message: "Update transaksi diblokir Supabase RLS! Jalankan DISABLE ROW LEVEL SECURITY di SQL Editor.",
        });
      }
    }

    const live = await calculateLiveAvailability();
    broadcastSSE({ type: "IR_UPDATE", ...live });

    return res.json({ success: true, message: `Data transaksi #${txId} berhasil diperbarui.` });
  } catch (err) {
    console.error("Admin Update Error:", err);
    res.status(500).json({ success: false, message: "Gagal memperbarui data transaksi: " + err.message });
  }
});

// DELETE: Hapus transaksi dari database
app.delete("/api/admin/transactions/:id", async (req, res) => {
  if (!verifyAdmin(req, res)) return;

  const txId = req.params.id;

  try {
    const { data: txList, error: fetchErr } = await supabase
      .from("transactions")
      .select("*")
      .eq("id", txId)
      .limit(1);

    if (fetchErr) {
      return res.status(400).json({ success: false, message: fetchErr.message });
    }
    if (!txList || txList.length === 0) {
      return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan." });
    }
    const tx = txList[0];

    if (tx.status_transaksi === "ACTIVE") {
      const isSewa = tx.type === "SEWA";
      await supabase
        .from("lockers")
        .update({ is_occupied: isSewa, last_status_change: new Date() })
        .eq("id", tx.locker_id);
      await supabase.from("otp_codes").delete().eq("user_id", tx.user_id);
    }

    const { data: deletedRows, error: delErr } = await supabase
      .from("transactions")
      .delete()
      .eq("id", txId)
      .select();

    if (delErr) {
      return res.status(400).json({ success: false, message: delErr.message });
    }
    if (!deletedRows || deletedRows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Hapus diblokir Supabase RLS! Jalankan DISABLE ROW LEVEL SECURITY di SQL Editor.",
      });
    }

    const live = await calculateLiveAvailability();
    broadcastSSE({ type: "IR_UPDATE", ...live });

    return res.json({ success: true, message: `Transaksi #${txId} berhasil dihapus.` });
  } catch (err) {
    console.error("Admin Delete Error:", err);
    res.status(500).json({ success: false, message: "Gagal menghapus transaksi: " + err.message });
  }
});

// ACTION ADMIN: Buka pintu loker darurat via MQTT
app.post("/api/admin/lockers/:slot_name/unlock", async (req, res) => {
  if (!verifyAdmin(req, res)) return;

  const slotName = req.params.slot_name;
  const commandPayload = `UNLOCK:${slotName}:ADMIN`;
  mqttClient.publish(topicCmd, commandPayload);
  console.log(`🔓 Admin Emergency Unlock Sent: ${commandPayload}`);

  return res.json({ success: true, message: `Perintah buka pintu dikirim ke ${slotName}.` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server PayungTeduh Running on http://0.0.0.0:${PORT}`);
});
