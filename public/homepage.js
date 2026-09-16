function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const form = document.getElementById('inquiry-form');
const banner = document.getElementById('inquiry-banner');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const payload = {
    name: data.get('name').trim(),
    phone: data.get('phone').trim(),
    message: data.get('message').trim(),
  };

  try {
    const res = await fetch('/api/inquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || '상담 신청 중 오류가 발생했습니다.');

    banner.innerHTML = `<div class="banner success">상담 신청이 접수되었습니다. 빠르게 연락드리겠습니다.</div>`;
    form.reset();
  } catch (err) {
    banner.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
  }
});

const lookupForm = document.getElementById('case-lookup-form');
const lookupResult = document.getElementById('case-lookup-result');

lookupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(lookupForm);
  const payload = {
    name: data.get('name').trim(),
    phone_last4: data.get('phone_last4').trim(),
  };

  try {
    const res = await fetch('/api/case-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || !result.found) throw new Error(result.error || '조회 중 오류가 발생했습니다.');

    lookupResult.innerHTML = `
      <div class="banner success case-lookup-result-card">
        <div>${esc(result.name)} 님의 사건 진행상황</div>
        <div class="status">${esc(result.progress) || '아직 등록된 진행상황이 없습니다. 곧 업데이트해 드리겠습니다.'}</div>
      </div>`;
  } catch (err) {
    lookupResult.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
  }
});
