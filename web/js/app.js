const API_URL = `${window.location.origin}/api`;

// Kirim status aktivitas ke layar OLED ESP32
function notifyOled(status) {
  fetch(`${API_URL}/oled-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  }).catch(() => {});
}

function renderAvailabilityUI(sewaTersedia, titipKosong) {
  const sewaCountEl = document.getElementById('live-sewa-count');
  const sewaStatusEl = document.getElementById('live-sewa-status');
  const titipCountEl = document.getElementById('live-titip-count');
  const titipStatusEl = document.getElementById('live-titip-status');

  if (sewaCountEl && sewaStatusEl) {
    sewaCountEl.innerText = `${sewaTersedia} / 2`;
    sewaStatusEl.innerText = sewaTersedia > 0 ? 'Tersedia' : 'Habis';
    sewaStatusEl.className = `px-2 py-0.5 rounded-full text-[10px] font-bold ${
      sewaTersedia > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
    }`;
  }

  if (titipCountEl && titipStatusEl) {
    titipCountEl.innerText = `${titipKosong} / 2`;
    titipStatusEl.innerText = titipKosong > 0 ? 'Kosong' : 'Penuh';
    titipStatusEl.className = `px-2 py-0.5 rounded-full text-[10px] font-bold ${
      titipKosong > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
    }`;
  }
}

async function loadAvailability() {
  try {
    const res = await fetch(`${API_URL}/availability`);
    const data = await res.json();
    if (data.success) {
      renderAvailabilityUI(data.sewaTersedia, data.titipKosong);
    }
  } catch (err) {
    console.error('Gagal memuat ketersediaan:', err);
  }
}

// NAVIGASI PILIH PERAN (USER VS ADMIN)
function enterAsUser() {
  document.getElementById('role-select-screen').classList.add('hidden');
  document.getElementById('main-app-content').classList.remove('hidden');
  document.getElementById('status-box').classList.add('hidden');
  updatePricePreview();
  notifyOled('PILIH_SEWA');
}

function backToRoleSelect() {
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
    const res = await fetch(`${API_URL}/admin/dashboard`, {
      headers: { 'x-admin-password': pass }
    });

    if (res.ok) {
      sessionStorage.setItem('payungteduh_admin_pass', pass);
      window.location.href = 'admin.html';
    } else {
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    errorEl.innerText = '❌ Gagal terhubung ke server.';
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Masuk Dashboard Admin →';
  }
}

// FORMAT RUPIAH & PREVIEW HARGA
function formatRupiah(angka) {
  return 'Rp ' + Number(angka).toLocaleString('id-ID');
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
      ? 'w-full py-3 bg-blue-600 text-white font-bold rounded-xl shadow hover:bg-blue-700 transition'
      : 'w-full py-3 bg-green-600 text-white font-bold rounded-xl shadow hover:bg-green-700 transition';
  }

  const mainApp = document.getElementById('main-app-content');
  if (mainApp && !mainApp.classList.contains('hidden')) {
    notifyOled(isSewa ? 'PILIH_SEWA' : 'PILIH_TITIP');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updatePricePreview();
  loadAvailability();
  setInterval(() => {
    const roleScreen = document.getElementById('role-select-screen');
    if (roleScreen && !roleScreen.classList.contains('hidden')) {
      loadAvailability();
    }
  }, 2500);
});

const eventSource = new EventSource(`${API_URL}/events`);
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'IR_UPDATE') {
    renderAvailabilityUI(data.sewaTersedia, data.titipKosong);
  } else if (data.type === 'NFC_UNLOCKED') {
    showStatus(data.message, true);
  } else if (data.type === 'RFID_SUCCESS') {
    enterAsUser();
    showStatus(data.message, true);
    setTimeout(() => {
      switchTab('new');
    }, 4000);
  } else if (data.type === 'RFID_FAILED') {
    showStatus(data.message, false);
  } else if (data.type === 'DOOR_CLOSED' || data.type === 'DOOR_TIMEOUT') {
    closePaymentModal();
    document.getElementById('ret_otp').value = '';
    document.getElementById('retrieve-otp').value = '';
    showStatus(data.message, data.type === 'DOOR_CLOSED');
    setTimeout(() => {
      backToRoleSelect();
    }, 3500);
  }
};

function switchTab(tab) {
  document.getElementById('form-new').classList.add('hidden');
  document.getElementById('form-return').classList.add('hidden');
  document.getElementById('form-retrieve').classList.add('hidden');

  const inactiveClass = 'w-1/3 py-2 text-slate-500 hover:text-blue-600 transition-all';
  document.getElementById('tab-new').className = inactiveClass;
  document.getElementById('tab-return').className = inactiveClass;
  document.getElementById('tab-retrieve').className = inactiveClass;

  const activeClass = 'w-1/3 py-2 border-b-2 border-blue-600 text-blue-600 transition-all';
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

  optionsView.classList.add('hidden');
  if (method === 'rfid') {
    rfidView.classList.remove('hidden');
    emailView.classList.add('hidden');
    showStatus('Menunggu Scan Stiker RFID pada Alat Physical...', true);
    notifyOled('TAB_RETURN');
  } else if (method === 'email') {
    emailView.classList.remove('hidden');
    rfidView.classList.add('hidden');
  }
}

function resetReturnView() {
  document.getElementById('return-options').classList.remove('hidden');
  document.getElementById('return-rfid-view').classList.add('hidden');
  document.getElementById('return-email-view').classList.add('hidden');
}

function showStatus(msg, isSuccess) {
  const box = document.getElementById('status-box');
  box.classList.remove('hidden', 'bg-green-100', 'text-green-700', 'bg-red-100', 'text-red-700');
  box.classList.add(isSuccess ? 'bg-green-100' : 'bg-red-100', isSuccess ? 'text-green-700' : 'text-red-700');
  box.innerText = (isSuccess ? '✅ ' : '❌ ') + msg;
}

function closePaymentModal() {
  const modal = document.getElementById('payment-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function handleNewTransaction(e) {
  e.preventDefault();
  const selectedTypeEl = document.querySelector('input[name="type"]:checked');
  if (!selectedTypeEl) {
    return showStatus('Silakan pilih layanan Sewa Payung atau Titip Payung terlebih dahulu!', false);
  }

  const body = {
    nama: document.getElementById('nama').value.trim(),
    email: document.getElementById('email').value.trim(),
    bank: document.getElementById('bank').value,
    no_rek: document.getElementById('no_rek').value.trim(),
    type: selectedTypeEl.value
  };

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

    const res = await fetch(`${API_URL}/transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();

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
      updatePricePreview();
    } else {
      closePaymentModal();
      showStatus(data.message || 'Transaksi gagal diproses.', false);
    }
  } catch (err) {
    closePaymentModal();
    showStatus('Gagal terhubung ke server backend.', false);
  }
}

async function requestOTP(e, type, emailInputId) {
  if (e) e.preventDefault();
  const emailElem = document.getElementById(emailInputId);
  if (!emailElem) return showStatus(`Input ID '${emailInputId}' tidak ditemukan.`, false);

  const email = emailElem.value.trim();
  if (!email) return showStatus('Silakan isi email terdaftar terlebih dahulu!', false);

  try {
    showStatus('Meminta kode OTP ke server...', true);
    notifyOled('OTP_REQUEST');
    const res = await fetch(`${API_URL}/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, type })
    });
    const data = await res.json();
    showStatus(data.message, data.success);
  } catch (err) {
    console.error(err);
    showStatus('Gagal terhubung ke server backend.', false);
  }
}

async function verifyOTP(e, type, emailInputId, otpInputId) {
  if (e) e.preventDefault();
  const emailElem = document.getElementById(emailInputId);
  const otpElem = document.getElementById(otpInputId);

  if (!emailElem || !otpElem) return showStatus('Elemen input tidak ditemukan.', false);

  const email = emailElem.value.trim();
  const otp = otpElem.value.trim();
  if (!email || !otp) return showStatus('Silakan isi email dan kode OTP!', false);

  try {
    showStatus('Memverifikasi OTP...', true);
    const res = await fetch(`${API_URL}/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp, type })
    });
    const data = await res.json();

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
    showStatus('Gagal terhubung ke server backend.', false);
  }
}