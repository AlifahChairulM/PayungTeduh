// Configuration API Endpoint Backend
const API_URL = 'http://localhost:3000/api';

// -------------------------------------------------------------
// 1. NAVIGASI TAB UI (Sewa/Titip, Kembalikan, Ambil)
// -------------------------------------------------------------
function switchTab(tab) {
  // Sembunyikan semua form utama
  document.getElementById('form-new').classList.add('hidden');
  document.getElementById('form-return').classList.add('hidden');
  document.getElementById('form-retrieve').classList.add('hidden');

  // Reset kelas CSS tab ke posisi non-aktif
  const inactiveClass = 'w-1/3 py-2 text-slate-500 hover:text-blue-600 transition-all';
  document.getElementById('tab-new').className = inactiveClass;
  document.getElementById('tab-return').className = inactiveClass;
  document.getElementById('tab-retrieve').className = inactiveClass;

  // Aktifkan tab & tampilkan form yang dipilih
  const activeClass = 'w-1/3 py-2 border-b-2 border-blue-600 text-blue-600 transition-all';
  if (tab === 'new') {
    document.getElementById('form-new').classList.remove('hidden');
    document.getElementById('tab-new').className = activeClass;
  } else if (tab === 'return') {
    document.getElementById('form-return').classList.remove('hidden');
    document.getElementById('tab-return').className = activeClass;
    resetReturnView(); // Reset tampilan sub-opsi pengembalian
  } else if (tab === 'retrieve') {
    document.getElementById('form-retrieve').classList.remove('hidden');
    document.getElementById('tab-retrieve').className = activeClass;
  }
}

// -------------------------------------------------------------
// 2. KEMBALIKAN PAYUNG: SWITCH PILIHAN METODE (RFID vs EMAIL)
// -------------------------------------------------------------
function selectReturnMethod(method) {
  const optionsView = document.getElementById('return-options');
  const rfidView = document.getElementById('return-rfid-view');
  const emailView = document.getElementById('return-email-view');

  optionsView.classList.add('hidden');

  if (method === 'rfid') {
    rfidView.classList.remove('hidden');
    emailView.classList.add('hidden');
    showStatus('Silakan periksa loker fisik. Tempelkan stiker RFID payung ke sensor pembaca.', true);
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

// -------------------------------------------------------------
// 3. HELPER UI NOTIFIKASI STATUS
// -------------------------------------------------------------
function showStatus(msg, isSuccess) {
  const box = document.getElementById('status-box');
  box.classList.remove('hidden', 'bg-green-100', 'text-green-700', 'bg-red-100', 'text-red-700');
  box.classList.add(isSuccess ? 'bg-green-100' : 'bg-red-100', isSuccess ? 'text-green-700' : 'text-red-700');
  box.innerText = (isSuccess ? '✅ ' : '❌ ') + msg;
}

// -------------------------------------------------------------
// 4. HANDLER TRANSAKSI BARU (SEWA / TITIP)
// -------------------------------------------------------------
async function handleNewTransaction(e) {
  e.preventDefault();
  const body = {
    nama: document.getElementById('nama').value,
    email: document.getElementById('email').value,
    bank: document.getElementById('bank').value,
    no_rek: document.getElementById('no_rek').value,
    type: document.querySelector('input[name="type"]:checked').value
  };

  try {
    const res = await fetch(`${API_URL}/transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    showStatus(data.message, data.success);
  } catch (err) {
    showStatus('Gagal terhubung ke server backend.', false);
  }
}

// -------------------------------------------------------------
// 5. HANDLER REQUEST KODE OTP
// -------------------------------------------------------------
async function requestOTP(type, emailInputId) {
  const email = document.getElementById(emailInputId).value;
  if (!email) return showStatus('Silakan isi email terlebih dahulu!', false);

  try {
    const res = await fetch(`${API_URL}/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, type })
    });
    const data = await res.json();
    showStatus(data.message, data.success);
  } catch (err) {
    showStatus('Gagal terhubung ke server backend.', false);
  }
}

// -------------------------------------------------------------
// 6. HANDLER VERIFIKASI KODE OTP
// -------------------------------------------------------------
async function verifyOTP(type, emailInputId, otpInputId) {
  const email = document.getElementById(emailInputId).value;
  const otp = document.getElementById(otpInputId).value;
  if (!otp) return showStatus('Silakan isi kode OTP!', false);

  try {
    const res = await fetch(`${API_URL}/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp, type })
    });
    const data = await res.json();
    
    if (data.success) {
      const fullMessage = `${data.message}\n\n${data.info_refund || ''}`;
      showStatus(fullMessage, true);
    } else {
      showStatus(data.message, false);
    }
  } catch (err) {
    showStatus('Gagal terhubung ke server backend.', false);
  }
}