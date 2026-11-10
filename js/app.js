// Configuration API Endpoint Backend
const API_URL = 'http://10.200.16.118:3000/api';

const eventSource = new EventSource(`${API_URL}/events`);
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'RFID_SUCCESS') {
    showStatus(`🎉 ${data.message}\n(UID Stiker: ${data.uid})`, true);
    setTimeout(() => {
      switchTab('new');
      showStatus('Sistem Siap Digunakan Kembali.', true);
    }, 4000);
  } else if (data.type === 'RFID_FAILED') {
    showStatus(data.message, false);
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
  } else if (tab === 'return') {
    document.getElementById('form-return').classList.remove('hidden');
    document.getElementById('tab-return').className = activeClass;
    resetReturnView();
  } else if (tab === 'retrieve') {
    document.getElementById('form-retrieve').classList.remove('hidden');
    document.getElementById('tab-retrieve').className = activeClass;
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

// HANDLER REQUEST KODE OTP (Ambil / Kembali)
async function requestOTP(e, type, emailInputId) {
  if (e) e.preventDefault();
  
  const emailElem = document.getElementById(emailInputId);
  if (!emailElem) return showStatus(`Input ID '${emailInputId}' tidak ditemukan.`, false);

  const email = emailElem.value.trim();
  if (!email) return showStatus('Silakan isi email terdaftar terlebih dahulu!', false);

  try {
    showStatus('Meminta kode OTP ke server...', true);
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

// HANDLER VERIFIKASI KODE OTP (Ambil / Kembali)
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
      const fullMessage = `${data.message}\n${data.info_refund || ''}`;
      showStatus(fullMessage, true);
      
      setTimeout(() => {
        switchTab('new');
        showStatus('Sistem Siap Digunakan Kembali.', true);
      }, 4000);
    } else {
      showStatus(data.message, false);
    }
  } catch (err) {
    console.error(err);
    showStatus('Gagal terhubung ke server backend.', false);
  }
}