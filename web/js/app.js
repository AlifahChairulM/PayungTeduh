const API_URL = `${window.location.origin}/api`;
let stockState = { sewa: 0, titip: 0, loaded: false };
let isSubmittingTx = false;
let isVerifyingOtp = false;
let rfidScanTimer = null;
let doorRedirectTimer = null;
const otpCooldownTimers = {};

function clearRfidTimer() {
  if (rfidScanTimer) {
    clearInterval(rfidScanTimer);
    rfidScanTimer = null;
  }
}

async function safeFetchJSON(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);

    let data = {};
    try {
      data = await res.json();
    } catch {
      throw new Error(`Respons server tidak valid (HTTP ${res.status}).`);
    }

    if (!res.ok) {
      const err = new Error(data.message || `Gangguan server (HTTP ${res.status}).`);
      err.status = res.status;
      throw err;
    }

    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('Koneksi ke server melebihi batas waktu (timeout). Silakan coba lagi.');
    }
    throw err;
  }
}

// Ubah tampilan badge "Real-time IR" saat terhubung / putus
function updateSyncBadge(state) {
  const badge = document.getElementById('live-sync-badge');
  if (!badge) return;

  if (state === 'connected') {
    badge.className = 'inline-flex items-center gap-1 text-[10px] font-bold text-sky-800';
    badge.innerHTML = '<span class="w-1.5 h-1.5 bg-sky-600 rounded-full animate-ping"></span> Real-time IR';
  } else if (state === 'reconnecting') {
    badge.className = 'inline-flex items-center gap-1 text-[10px] font-bold text-amber-700';
    badge.innerHTML = '<span class="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span> Menghubungkan ulang...';
  } else {
    badge.className = 'inline-flex items-center gap-1 text-[10px] font-bold text-rose-600';
    badge.innerHTML = '<span class="w-1.5 h-1.5 bg-rose-600 rounded-full"></span> Terputus';
  }
}

// Kirim status aktivitas ke layar OLED ESP32
function notifyOled(status) {
  fetch(`${API_URL}/oled-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  }).catch(() => {});
}

function renderAvailabilityUI(sewaTersedia, titipKosong) {
  const sewaCount = Number(sewaTersedia) || 0;
  const titipCount = Number(titipKosong) || 0;
  stockState = { sewa: sewaCount, titip: titipCount, loaded: true };

  const sewaCountEl = document.getElementById('live-sewa-count');
  const sewaStatusEl = document.getElementById('live-sewa-status');
  const titipCountEl = document.getElementById('live-titip-count');
  const titipStatusEl = document.getElementById('live-titip-status');

  if (sewaCountEl && sewaStatusEl) {
    sewaCountEl.innerText = `${sewaTersedia} / 2`;
    sewaStatusEl.innerText = sewaTersedia > 0 ? 'Tersedia' : 'Habis';
    sewaStatusEl.className = `px-2 py-0.5 rounded-full text-[10px] font-bold ${
      sewaCount > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
    }`;
  }

  if (titipCountEl && titipStatusEl) {
    titipCountEl.innerText = `${titipKosong} / 2`;
    titipStatusEl.innerText = titipKosong > 0 ? 'Kosong' : 'Penuh';
    titipStatusEl.className = `px-2 py-0.5 rounded-full text-[10px] font-bold ${
      titipCount > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
    }`;
  }

  const labelSewa = document.getElementById('label-sewa');
  const radioSewa = document.getElementById('radio-sewa');
  const subtextSewa = document.getElementById('subtext-sewa');

  if (labelSewa && radioSewa && subtextSewa) {
    if (sewaCount <= 0) {
      const wasChecked = radioSewa.checked;
      radioSewa.checked = false;
      radioSewa.disabled = true;
      labelSewa.className = 'border-2 border-slate-200 bg-slate-100/80 p-3 rounded-xl flex flex-col items-center opacity-60 cursor-not-allowed transition';
      subtextSewa.innerText = 'Stok Habis (0/2)';
      subtextSewa.className = 'text-[11px] font-semibold text-rose-600';
      if (wasChecked) {
        updatePricePreview();
        showStatus('Stok payung sewa baru saja habis (0/2).', false);
      }
    } else {
      radioSewa.disabled = false;
      labelSewa.className = 'border-2 border-sky-300/80 bg-sky-50/70 p-3 rounded-xl flex flex-col items-center cursor-pointer hover:border-sky-700 transition';
      subtextSewa.innerText = 'Rp 5.000 + Deposit';
      subtextSewa.className = 'text-[11px] text-slate-500';
    }
  }

  const labelTitip = document.getElementById('label-titip');
  const radioTitip = document.getElementById('radio-titip');
  const subtextTitip = document.getElementById('subtext-titip');

  if (labelTitip && radioTitip && subtextTitip) {
    if (titipCount <= 0) {
      const wasChecked = radioTitip.checked;
      radioTitip.checked = false;
      radioTitip.disabled = true;
      labelTitip.className = 'border-2 border-slate-200 bg-slate-100/80 p-3 rounded-xl flex flex-col items-center opacity-60 cursor-not-allowed transition';
      subtextTitip.innerText = 'Slot Penuh (0/2)';
      subtextTitip.className = 'text-[11px] font-semibold text-rose-600';
      if (wasChecked) {
        updatePricePreview();
        showStatus('Slot penitipan payung baru saja penuh (0/2).', false);
      }
    } else {
      radioTitip.disabled = false;
      labelTitip.className = 'border-2 border-teal-300/80 bg-teal-50/70 p-3 rounded-xl flex flex-col items-center cursor-pointer hover:border-teal-700 transition';
      subtextTitip.innerText = 'Rp 3.000 + Deposit';
      subtextTitip.className = 'text-[11px] text-slate-500';
    }
  }
}

function renderAvailabilityOffline() {
  const sewaStatusEl = document.getElementById('live-sewa-status');
  const titipStatusEl = document.getElementById('live-titip-status');

  if (sewaStatusEl) {
    sewaStatusEl.innerText = 'Offline';
    sewaStatusEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-200 text-slate-600';
  }
  if (titipStatusEl) {
    titipStatusEl.innerText = 'Offline';
    titipStatusEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-200 text-slate-600';
  }
  updateSyncBadge('offline');
}

async function loadAvailability() {
  try {
    const data = await safeFetchJSON(`${API_URL}/availability`, {}, 5000);
    if (data.success) {
      renderAvailabilityUI(data.sewaTersedia, data.titipKosong);
      updateSyncBadge('connected');
    }
  } catch (err) {
    console.error('Gagal memuat ketersediaan:', err);
    renderAvailabilityOffline();
  }
}

async function enterAsUser(skipRemoteCheck = false) {
  if (!skipRemoteCheck) {
    try {
      const session = await safeFetchJSON(`${API_URL}/session-status`, {}, 4000);
      if (!session.unlocked) {
        showStatus(
          '🔒 Akses Terkunci: Silakan tekan tombol Push Button pada loker lalu tempelkan HP NFC ke reader terlebih dahulu.',
          false
        );
        return;
      }
    } catch (err) {
      showStatus('Gagal memeriksa status sesi loker. Pastikan server aktif.', false);
      return;
    }
  }

  document.getElementById('role-select-screen').classList.add('hidden');
  document.getElementById('main-app-content').classList.remove('hidden');
  document.getElementById('status-box').classList.add('hidden');
  updatePricePreview();
  notifyOled('PILIH_SEWA');
}

function backToRoleSelect() {
  clearRfidTimer();
  document.getElementById('main-app-content').classList.add('hidden');
  document.getElementById('role-select-screen').classList.remove('hidden');
  document.getElementById('status-box').classList.add('hidden');
  loadAvailability();
}

function showAdminLoginBox() {
  document.getElementById('inline-admin-login').classList.remove('hidden');
  document.getElementById('inline-admin-error').classList.add('hidden');
  document.getElementById('inline-admin-pass').focus();
}

function hideAdminLoginBox() {
  document.getElementById('inline-admin-login').classList.add('hidden');
  document.getElementById('inline-admin-pass').value = '';
}

async function handleInlineAdminLogin(e) {
  e.preventDefault();
  const pass = document.getElementById('inline-admin-pass').value.trim();
  const errorEl = document.getElementById('inline-admin-error');
  const btn = document.getElementById('btn-inline-admin');

  errorEl.classList.add('hidden');
  btn.disabled = true;
  btn.innerText = 'Memverifikasi...';

  try {
    await safeFetchJSON(
      `${API_URL}/admin/dashboard`,
      { headers: { 'x-admin-password': pass } },
      8000
    );
    sessionStorage.setItem('payungteduh_admin_pass', pass);
    window.location.href = 'admin.html';
  } catch (err) {
    errorEl.innerText = err.status === 401
      ? '❌ Password admin salah!'
      : `❌ ${err.message}`;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Masuk Dashboard Admin →';
  }
}

function formatRupiah(angka) {
  return 'Rp ' + Number(angka).toLocaleString('id-ID');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function isValidAccountNumber(noRek) {
  return /^\d{8,20}$/.test(noRek);
}

function bindNumericSanitizer() {
  ['no_rek', 'ret_otp', 'retrieve-otp'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '');
    });
  });
}

function updatePricePreview() {
  const typeEl = document.querySelector('input[name="type"]:checked');
  const bankEl = document.getElementById('bank');
  const checkoutSection = document.getElementById('service-checkout-section');
  const submitBtn = document.getElementById('btn-submit-tx');

  if (!typeEl) {
    if (checkoutSection) checkoutSection.classList.add('hidden');
    return;
  }

  // Cegah pemilihan layanan jika stok kosong/penuh
  if (typeEl.value === 'SEWA' && stockState.loaded && stockState.sewa <= 0) {
    typeEl.checked = false;
    if (checkoutSection) checkoutSection.classList.add('hidden');
    return showStatus('Maaf, stok payung sewa saat ini sedang habis (0/2).', false);
  }
  if (typeEl.value === 'TITIP' && stockState.loaded && stockState.titip <= 0) {
    typeEl.checked = false;
    if (checkoutSection) checkoutSection.classList.add('hidden');
    return showStatus('Maaf, slot penitipan payung saat ini penuh (0/2).', false);
  }

  if (checkoutSection) checkoutSection.classList.remove('hidden');

  const isSewa = typeEl.value === 'SEWA';
  const method = bankEl ? bankEl.value : 'GoPay';

  const biaya = isSewa ? 5000 : 3000;
  const deposit = isSewa ? 20000 : 3000;
  const total = biaya + deposit;

  document.getElementById('preview-method-badge').innerText = `Saldo ${method}`;
  document.getElementById('preview-service-label').innerText = isSewa
    ? 'Biaya Sewa (Maks. 48 Jam)'
    : 'Biaya Penitipan (Maks. 72 Jam)';
  document.getElementById('preview-biaya').innerText = formatRupiah(biaya);
  document.getElementById('preview-deposit').innerText = formatRupiah(deposit);
  document.getElementById('preview-total').innerText = formatRupiah(total);

  if (submitBtn) {
    submitBtn.innerText = isSewa
      ? '💳 Bayar & Sewa Payung'
      : '💳 Bayar & Titip Payung';
    submitBtn.className = isSewa
      ? 'w-full py-3 bg-sky-800 text-white font-bold rounded-xl shadow hover:bg-sky-900 transition'
      : 'w-full py-3 bg-teal-700 text-white font-bold rounded-xl shadow hover:bg-teal-800 transition';
  }

  const mainApp = document.getElementById('main-app-content');
  if (mainApp && !mainApp.classList.contains('hidden')) {
    notifyOled(isSewa ? 'PILIH_SEWA' : 'PILIH_TITIP');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bindNumericSanitizer();
  updatePricePreview();
  loadAvailability();
  setInterval(() => {
    const roleScreen = document.getElementById('role-select-screen');
    if (roleScreen && !roleScreen.classList.contains('hidden')) {
      loadAvailability();
    }
  }, 2500);

  // Jika HP membuka halaman tepat setelah tap NFC di loker, otomatis buka akses pengguna
  safeFetchJSON(`${API_URL}/session-status`, {}, 4000)
    .then((session) => {
      if (session && session.unlocked) {
        enterAsUser(true);
        showStatus('📱 Sesi NFC Aktif! Silakan pilih layanan yang Anda inginkan.', true);
      }
    })
    .catch(() => {});
});

const eventSource = new EventSource(`${API_URL}/events`);

eventSource.onopen = () => {
  updateSyncBadge('connected');
};

eventSource.onerror = () => {
  updateSyncBadge('reconnecting');
};

eventSource.onmessage = (event) => {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (err) {
    console.error('Data SSE tidak valid:', err);
    return;
  }

  updateSyncBadge('connected');

  if (data.type === 'IR_UPDATE') {
    renderAvailabilityUI(data.sewaTersedia, data.titipKosong);
  } else if (data.type === 'SYSTEM_ACTIVATED') {
    showStatus(data.message, true);
  } else if (data.type === 'NFC_UNLOCKED') {
    enterAsUser(true);
    showStatus(data.message, true);
  } else if (data.type === 'RFID_SUCCESS') {
    clearRfidTimer();
    showStatus(data.message, true);
  } else if (data.type === 'RFID_FAILED') {
    clearRfidTimer();
    showStatus(data.message, false);
  } else if (data.type === 'DOOR_TAMPER') {
    showStatus(data.message, false);
  } else if (data.type === 'DOOR_TIMEOUT') {
    closePaymentModal();
    showStatus(
      '⚠️ PERINGATAN KEAMANAN: Batas waktu habis! Segera tutup pintu loker hingga rapat.',
      false
    );
  } else if (data.type === 'DOOR_CLOSED') {
    clearRfidTimer();
    if (doorRedirectTimer) clearTimeout(doorRedirectTimer);
    closePaymentModal();
    document.getElementById('ret_otp').value = '';
    document.getElementById('retrieve-otp').value = '';
    showStatus(data.message, true);
    doorRedirectTimer = setTimeout(() => {
      backToRoleSelect();
    }, 3500);
  }
};

function switchTab(tab) {
  document.getElementById('form-new').classList.add('hidden');
  document.getElementById('form-return').classList.add('hidden');
  document.getElementById('form-retrieve').classList.add('hidden');

  const inactiveClass = 'w-1/3 py-2 text-slate-500 hover:text-sky-800 transition-all';
  document.getElementById('tab-new').className = inactiveClass;
  document.getElementById('tab-return').className = inactiveClass;
  document.getElementById('tab-retrieve').className = inactiveClass;

  const activeClass = 'w-1/3 py-2 border-b-2 border-sky-700 text-sky-800 font-bold transition-all';
  if (tab === 'new') {
    document.getElementById('form-new').classList.remove('hidden');
    document.getElementById('tab-new').className = activeClass;
    updatePricePreview();
  } else if (tab === 'return') {
    document.getElementById('form-return').classList.remove('hidden');
    document.getElementById('tab-return').className = activeClass;
    resetReturnView();
    notifyOled('TAB_RETURN');
  } else if (tab === 'retrieve') {
    document.getElementById('form-retrieve').classList.remove('hidden');
    document.getElementById('tab-retrieve').className = activeClass;
    notifyOled('TAB_RETRIEVE');
  }
}

function selectReturnMethod(method) {
  const optionsView = document.getElementById('return-options');
  const rfidView = document.getElementById('return-rfid-view');
  const emailView = document.getElementById('return-email-view');
  const countdownEl = document.getElementById('rfid-countdown-text');

  clearRfidTimer();
  optionsView.classList.add('hidden');

  if (method === 'rfid') {
    rfidView.classList.remove('hidden');
    emailView.classList.add('hidden');
    showStatus('Menunggu Scan Stiker RFID pada Alat Physical...', true);
    notifyOled('TAB_RETURN');

    let remaining = 45;
    if (countdownEl) {
      countdownEl.className = 'text-xs font-bold text-sky-800 bg-sky-100/80 py-1.5 px-3 rounded-lg inline-block';
      countdownEl.innerText = `⏳ Menunggu pemindaian (${remaining} detik)...`;
    }

    rfidScanTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearRfidTimer();
        notifyOled('CANCEL_RFID_RETURN');
        if (countdownEl) {
          countdownEl.className = 'text-xs font-bold text-rose-700 bg-rose-100 py-1.5 px-3 rounded-lg inline-block';
          countdownEl.innerText = '⏱️ Waktu scan habis (45 detik). Kartu belum terbaca.';
        }
        showStatus(
          'Stiker RFID belum terbaca dalam 45 detik. Silakan klik tombol "Pakai Kode OTP Email" di atas.',
          false
        );
      } else if (countdownEl) {
        countdownEl.innerText = `⏳ Menunggu pemindaian (${remaining} detik)...`;
      }
    }, 1000);
  } else if (method === 'email') {
    notifyOled('CANCEL_RFID_RETURN');
    emailView.classList.remove('hidden');
    rfidView.classList.add('hidden');
  }
}

function resetReturnView() {
  clearRfidTimer();
  notifyOled('CANCEL_RFID_RETURN');
  document.getElementById('return-options').classList.remove('hidden');
  document.getElementById('return-rfid-view').classList.add('hidden');
  document.getElementById('return-email-view').classList.add('hidden');
}

function showStatus(msg, isSuccess) {
  const box = document.getElementById('status-box');
  if (!box) return;
  box.classList.remove(
    'hidden', 'bg-teal-50', 'text-teal-800', 'border-teal-200',
    'bg-rose-50', 'text-rose-700', 'border-rose-200'
  );
  box.classList.add(
    'border', isSuccess ? 'bg-teal-50' : 'bg-rose-50', 
    isSuccess ? 'text-teal-800' : 'text-rose-700', 
    isSuccess ? 'border-teal-200' : 'border-rose-200'
  );
  box.innerText = (isSuccess ? '✅ ' : '❌ ') + msg;
}

function closePaymentModal() {
  const modal = document.getElementById('payment-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function startOtpCooldown(btnEl, defaultLabel, seconds = 30) {
  if (!btnEl) return;
  const key = btnEl.id || defaultLabel;

  if (otpCooldownTimers[key]) {
    clearInterval(otpCooldownTimers[key]);
  }

  let remaining = seconds;
  btnEl.disabled = true;
  btnEl.classList.add('opacity-60', 'cursor-not-allowed');
  btnEl.innerText = `⏳ Tunggu ${remaining}d...`;

  otpCooldownTimers[key] = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(otpCooldownTimers[key]);
      delete otpCooldownTimers[key];
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-60', 'cursor-not-allowed');
      btnEl.innerText = defaultLabel;
    } else {
      btnEl.innerText = `⏳ Tunggu ${remaining}d...`;
    }
  }, 1000);
}

async function handleNewTransaction(e) {
  e.preventDefault();
  if (isSubmittingTx) return;

  const selectedTypeEl = document.querySelector('input[name="type"]:checked');
  if (!selectedTypeEl) {
    return showStatus('Silakan pilih layanan Sewa Payung atau Titip Payung terlebih dahulu!', false);
  }

  const nama = document.getElementById('nama').value.trim();
  const email = document.getElementById('email').value.trim();
  const bank = document.getElementById('bank').value;
  const noRek = document.getElementById('no_rek').value.replace(/\D/g, '');
  const type = selectedTypeEl.value;

  if (nama.length < 2) {
    return showStatus('Nama lengkap minimal terdiri dari 2 karakter.', false);
  }
  if (!isValidEmail(email)) {
    return showStatus('Format email tidak valid (contoh: nama@email.com).', false);
  }
  if (!isValidAccountNumber(noRek)) {
    return showStatus('Nomor rekening/HP harus berupa angka 8–20 digit.', false);
  }
  if (type === 'SEWA' && stockState.loaded && stockState.sewa <= 0) {
    return showStatus('Maaf, stok payung sewa saat ini sudah habis (0/2).', false);
  }
  if (type === 'TITIP' && stockState.loaded && stockState.titip <= 0) {
    return showStatus('Maaf, slot penitipan payung saat ini penuh (0/2).', false);
  }

  const submitBtn = document.getElementById('btn-submit-tx');
  isSubmittingTx = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-60', 'cursor-not-allowed');
    submitBtn.innerText = '⏳ Memproses Pembayaran...';
  }

  const body = { nama, email, bank, no_rek: noRek, type };
  const modal = document.getElementById('payment-modal');
  const loadingView = document.getElementById('payment-loading');
  const receiptView = document.getElementById('payment-receipt');

  document.getElementById('payment-loading-desc').innerText =
    `Memverifikasi akun ${body.bank} (${body.no_rek}) & memotong saldo...`;
  loadingView.classList.remove('hidden');
  receiptView.classList.add('hidden');
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  try {
    notifyOled('PAYING');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const data = await safeFetchJSON(
      `${API_URL}/transaction`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      12000
    );

    if (data.success && data.receipt) {
      const r = data.receipt;
      document.getElementById('receipt-slot-info').innerText = `🔓 Pintu Loker ${r.slot_name} Berhasil Terbuka`;
      document.getElementById('rec-nama').innerText = r.nama;
      document.getElementById('rec-method').innerText = `${r.bank} (${r.no_rek})`;
      document.getElementById('rec-biaya').innerText = formatRupiah(r.biaya);
      document.getElementById('rec-deposit').innerText = formatRupiah(r.deposit);
      document.getElementById('rec-total').innerText = `- ${formatRupiah(r.total_bayar)}`;

      loadingView.classList.add('hidden');
      receiptView.classList.remove('hidden');

      showStatus(`${data.message} | Saldo ${r.bank} terpotong ${formatRupiah(r.total_bayar)}.`, true);
      document.getElementById('form-new').reset();
    } else {
      closePaymentModal();
      showStatus(data.message || 'Transaksi gagal diproses.', false);
    }
  } catch (err) {
    closePaymentModal();
    showStatus(err.message || 'Gagal terhubung ke server backend.', false);
  } finally {
    isSubmittingTx = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('opacity-60', 'cursor-not-allowed');
    }
    updatePricePreview();
  }
}

async function requestOTP(e, type, emailInputId) {
  if (e) e.preventDefault();
  const btnEl = (e && e.currentTarget) || document.getElementById(type === 'SEWA' ? 'btn-otp-sewa' : 'btn-otp-titip');
  if (btnEl && btnEl.disabled) return;

  const emailElem = document.getElementById(emailInputId);
  if (!emailElem) return showStatus(`Input ID '${emailInputId}' tidak ditemukan.`, false);

  const email = emailElem.value.trim();
  if (!email) return showStatus('Silakan isi email terdaftar terlebih dahulu!', false);
  if (!isValidEmail(email)) return showStatus('Format email tidak valid (contoh: nama@email.com).', false);

  const defaultLabel = btnEl ? (btnEl.dataset.defaultLabel || btnEl.innerText.trim()) : 'Kirim OTP';
  if (btnEl) {
    btnEl.dataset.defaultLabel = defaultLabel;
    btnEl.disabled = true;
    btnEl.classList.add('opacity-60', 'cursor-not-allowed');
    btnEl.innerText = '⏳ Mengirim...';
  }

  try {
    showStatus('Meminta kode OTP ke server...', true);
    notifyOled('OTP_REQUEST');
    const data = await safeFetchJSON(
      `${API_URL}/request-otp`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, type })
      },
      10000
    );
    showStatus(data.message, data.success);

    if (data.success) {
      startOtpCooldown(btnEl, defaultLabel, 30);
    } else if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-60', 'cursor-not-allowed');
      btnEl.innerText = defaultLabel;
    }
  } catch (err) {
    console.error(err);
    showStatus(err.message || 'Gagal terhubung ke server backend.', false);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-60', 'cursor-not-allowed');
      btnEl.innerText = defaultLabel;
    }
  }
}

async function verifyOTP(e, type, emailInputId, otpInputId) {
  if (e) e.preventDefault();
  if (isVerifyingOtp) return;

  const emailElem = document.getElementById(emailInputId);
  const otpElem = document.getElementById(otpInputId);

  if (!emailElem || !otpElem) return showStatus('Elemen input tidak ditemukan.', false);

  const email = emailElem.value.trim();
  const otp = otpElem.value.replace(/\D/g, '');
  otpElem.value = otp;

  if (!email) return showStatus('Silakan isi email terdaftar terlebih dahulu!', false);
  if (!isValidEmail(email)) return showStatus('Format email tidak valid (contoh: nama@email.com).', false);
  if (!/^\d{4}$/.test(otp)) return showStatus('Kode OTP harus terdiri dari 4 digit angka!', false);

  const btnEl = (e && e.currentTarget) || document.getElementById(type === 'SEWA' ? 'btn-verify-sewa' : 'btn-verify-titip');
  const defaultLabel = btnEl ? btnEl.innerText.trim() : 'Verifikasi & Buka Loker';
  isVerifyingOtp = true;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.classList.add('opacity-60', 'cursor-not-allowed');
    btnEl.innerText = '⏳ Memverifikasi...';
  }

  try {
    showStatus('Memverifikasi OTP...', true);
    const data = await safeFetchJSON(`${API_URL}/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp, type })
    },
    10000
  );
    
    if (data.success) {
      otpElem.value = '';
      emailElem.value = '';
      const fullMessage = `${data.message}\n${data.info_refund || ''}`;
      showStatus(fullMessage, true);
    } else {
      showStatus(data.message, false);
    }
  } catch (err) {
    console.error(err);
    showStatus(err.message || 'Gagal terhubung ke server backend.', false);
  } finally {
    isVerifyingOtp = false;
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-60', 'cursor-not-allowed');
      btnEl.innerText = defaultLabel;
    }
  }
}