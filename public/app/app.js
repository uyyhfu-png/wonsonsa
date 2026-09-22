const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');

const state = {
  view: 'list',
  companies: [],
  selectedCompanyId: null,
  selectedCustomerId: null,
  customerSearch: '',
};

function formatKRW(value) {
  if (value === null || value === undefined || value === '') return '-';
  return `${Number(value).toLocaleString('ko-KR')}원`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청 처리 중 오류가 발생했습니다.');
  return data;
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  render();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function closeModal() {
  modalRoot.innerHTML = '';
}

function openModal(html) {
  modalRoot.innerHTML = `<div class="overlay" id="overlay"><div class="dialog">${html}</div></div>`;
  document.getElementById('overlay').addEventListener('click', (e) => {
    if (e.target.id === 'overlay') closeModal();
  });
}

function customerFormFields(customer = {}) {
  const companies = (customer.insurance_companies || []).map((c) => c.name).join(', ');
  return `
    <div class="form-grid">
      <label>고객이름 *
        <input type="text" name="name" value="${esc(customer.name)}" required />
      </label>
      <label>소개자
        <input type="text" name="referrer" value="${esc(customer.referrer)}" placeholder="소개해준 사람" />
      </label>
      <label>연락처 *
        <input type="text" name="phone" value="${esc(customer.phone)}" placeholder="010-000-0000" required />
      </label>
      <label>생년월일 *
        <input type="date" name="birth_date" value="${esc(customer.birth_date)}" required />
      </label>
      <label class="full">주소 *
        <input type="text" name="address" value="${esc(customer.address)}" required />
      </label>
      <label class="full">진단명
        <input type="text" name="diagnosis" value="${esc(customer.diagnosis)}" placeholder="예: 고혈압, 당뇨" />
      </label>
      <label class="full">추산금액 (청구 예정 보험담보 추산금액, 원)
        <input type="number" name="estimated_amount" value="${esc(customer.estimated_amount)}" placeholder="예: 3000000" min="0" step="1" />
      </label>
      <label class="full">가입 보험회사 (콤마로 구분, 여러 곳 가능)
        <input type="text" name="insurance_companies" value="${esc(companies)}" placeholder="예: 삼성생명, 교보생명" />
      </label>
    </div>

    <h3 class="form-section-title">사건 관리 정보</h3>
    <div class="form-grid">
      <label>사건종류
        <input type="text" name="case_type" value="${esc(customer.case_type)}" placeholder="예: 보험금청구, 실손청구" />
      </label>
      <label>수임여부
        <select name="retained">
          <option value="수임" ${customer.retained !== '미수임' ? 'selected' : ''}>수임</option>
          <option value="미수임" ${customer.retained === '미수임' ? 'selected' : ''}>미수임</option>
        </select>
      </label>
      <label>접수번호
        <input type="text" name="receipt_number" value="${esc(customer.receipt_number)}" />
      </label>
      <label>성공보수율 (%)
        <input type="number" name="success_fee_rate" value="${esc(customer.success_fee_rate)}" min="0" max="100" step="0.1" />
      </label>
      <label>상태
        <select name="status">
          <option value="진행" ${customer.status !== '종결' ? 'selected' : ''}>진행</option>
          <option value="종결" ${customer.status === '종결' ? 'selected' : ''}>종결</option>
        </select>
      </label>
      <label>담당자
        <input type="text" name="manager" value="${esc(customer.manager)}" />
      </label>
      <label class="full">내용 (사건 요약)
        <input type="text" name="case_title" value="${esc(customer.case_title)}" placeholder="예: 위종환 사건" />
      </label>
    </div>
  `;
}

function openCustomerForm(customer = null, prefill = {}) {
  const autoFillSection = customer
    ? ''
    : `
      <div class="card" style="padding:14px;margin-bottom:16px;background:#f7f9fc;">
        <label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:6px;">
          증권/진단서 파일로 자동 입력 (선택) — 파일을 올리면 이름/연락처/생년월일/주소/진단명을 자동으로 채워줍니다.
        </label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select id="auto-doc-type">
            <option value="증권">증권</option>
            <option value="진단서">진단서</option>
          </select>
          <input type="file" id="auto-file-input" accept=".pdf,.jpg,.jpeg,.png" />
        </div>
        <div id="auto-extract-status" style="margin-top:8px;font-size:13px;"></div>
      </div>
    `;

  openModal(`
    <h2>${customer ? '고객 정보 수정' : '고객 추가'}</h2>
    <div id="form-error"></div>
    ${autoFillSection}
    <form id="customer-form">
      ${customerFormFields(customer || prefill)}
      <div class="actions-row">
        <button type="submit" class="primary">저장</button>
        <button type="button" class="secondary" id="cancel-form">취소</button>
      </div>
    </form>
  `);

  document.getElementById('cancel-form').addEventListener('click', closeModal);

  const fileInput = document.getElementById('auto-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      const status = document.getElementById('auto-extract-status');
      if (!file) {
        status.textContent = '';
        return;
      }
      status.innerHTML = '<span class="muted">파일 분석 중입니다. 이미지 파일은 다소 시간이 걸릴 수 있습니다...</span>';
      const fd = new FormData();
      fd.append('file', file);
      try {
        const result = await api('/api/documents/extract', { method: 'POST', body: fd });
        const f = result.fields || {};
        const form = document.getElementById('customer-form');
        let filledCount = 0;
        const setIfEmpty = (fieldName, value) => {
          if (!value) return;
          const el = form.elements[fieldName];
          if (el && !el.value) {
            el.value = value;
            filledCount++;
          }
        };
        setIfEmpty('name', f.name);
        setIfEmpty('phone', f.phone);
        setIfEmpty('birth_date', f.birth_date);
        setIfEmpty('address', f.address);
        setIfEmpty('diagnosis', f.diagnosis);
        status.innerHTML = filledCount
          ? `<span style="color:#1c7c42;">${filledCount}개 항목을 자동으로 입력했습니다. 내용을 확인한 뒤 저장해주세요.</span>`
          : '<span class="muted">파일에서 인식된 항목이 없습니다. 직접 입력해주세요.</span>';
      } catch (err) {
        status.innerHTML = `<span style="color:var(--danger);">${esc(err.message)}</span>`;
      }
    });
  }

  document.getElementById('customer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const payload = {
      name: form.get('name').trim(),
      referrer: form.get('referrer').trim(),
      phone: form.get('phone').trim(),
      birth_date: form.get('birth_date'),
      address: form.get('address').trim(),
      diagnosis: form.get('diagnosis').trim(),
      estimated_amount: form.get('estimated_amount') ? Number(form.get('estimated_amount')) : null,
      case_type: form.get('case_type').trim(),
      retained: form.get('retained'),
      receipt_number: form.get('receipt_number').trim(),
      success_fee_rate: form.get('success_fee_rate') ? Number(form.get('success_fee_rate')) : null,
      status: form.get('status'),
      manager: form.get('manager').trim(),
      case_title: form.get('case_title').trim(),
      insurance_companies: form.get('insurance_companies')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      let saved;
      if (customer) {
        saved = await api(`/api/customers/${customer.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        saved = await api('/api/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      if (fileInput && fileInput.files[0]) {
        const docFd = new FormData();
        docFd.append('file', fileInput.files[0]);
        docFd.append('doc_type', document.getElementById('auto-doc-type').value);
        try {
          await api(`/api/customers/${saved.id}/documents`, { method: 'POST', body: docFd });
        } catch (docErr) {
          alert(`고객 정보는 저장되었지만 파일 첨부에는 실패했습니다: ${docErr.message}`);
        }
      }

      state.selectedCustomerId = saved.id;
      closeModal();
      await refreshCurrentView();
    } catch (err) {
      document.getElementById('form-error').innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  });
}

async function deleteCustomer(id) {
  if (!confirm('이 고객 정보와 첨부파일을 모두 삭제하시겠습니까?')) return false;
  await api(`/api/customers/${id}`, { method: 'DELETE' });
  return true;
}

// ---- Shared customer detail content (used by modal and by name-tab panel) ----
function customerDetailBody(customer) {
  const docsHtml = customer.documents.length
    ? `<ul class="doc-list">${customer.documents.map((d) => `
        <li>
          <span><span class="tag doc-type">${esc(d.doc_type)}</span>${esc(d.file_name)}
            <span class="muted">(${esc(d.uploaded_at)})</span>
          </span>
          <span>
            <a href="/api/documents/${d.id}/file" class="secondary" style="text-decoration:none;padding:6px 12px;border:1px solid var(--border);border-radius:8px;" target="_blank">열기</a>
            <button class="danger" data-delete-doc="${d.id}">삭제</button>
          </span>
        </li>`).join('')}</ul>`
    : '<p class="muted">등록된 첨부파일이 없습니다.</p>';

  return `
    <div class="detail-actions-row">
      <button type="button" class="secondary" data-action="edit">수정</button>
      <button type="button" class="danger" data-action="delete">삭제</button>
    </div>
    <p><strong>소개자</strong> ${esc(customer.referrer) || '-'}</p>
    <p><strong>연락처</strong> ${esc(customer.phone)} &nbsp; <strong>생년월일</strong> ${esc(customer.birth_date)}</p>
    <p><strong>주소</strong> ${esc(customer.address)}</p>
    <p><strong>진단명</strong> ${esc(customer.diagnosis) || '-'}</p>
    <p><strong>추산금액</strong> ${formatKRW(customer.estimated_amount)}</p>
    <p><strong>가입 보험회사</strong> ${
      customer.insurance_companies.length
        ? customer.insurance_companies.map((c) => `<span class="tag">${esc(c.name)}</span>`).join('')
        : '<span class="muted">없음</span>'
    }</p>

    <h3>진행상황</h3>
    <textarea data-progress-input rows="4" placeholder="예: 2026-09-09 서류 접수 완료, 보험사 심사 진행중">${esc(customer.progress)}</textarea>
    <div class="actions-row" style="margin-top:8px;">
      <button type="button" class="primary" data-action="save-progress">진행상황 저장</button>
    </div>
    <div data-progress-banner></div>

    <h3>증권/진단서 첨부파일</h3>
    ${docsHtml}

    <form data-doc-upload-form style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <select name="doc_type" required>
        <option value="증권">증권</option>
        <option value="진단서">진단서</option>
      </select>
      <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required />
      <button type="submit" class="primary">파일 추가</button>
    </form>
    <div data-doc-error></div>

    <h3>통화내역 <span class="muted" style="font-weight:400;font-size:12px;">(연락처 ${esc(customer.phone)} 기준 자동 조회)</span></h3>
    ${callLogsHtml(customer.call_logs)}

    <form data-call-log-form style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">
      <input type="date" name="call_date" required />
      <input type="text" name="content" placeholder="통화 내용 요약" required style="flex:1;min-width:200px;" />
      <button type="submit" class="primary">통화내역 추가</button>
    </form>
    <div data-call-log-error></div>
  `;
}

function callLogsHtml(callLogs) {
  if (!callLogs || !callLogs.length) {
    return '<p class="muted">등록된 통화내역이 없습니다.</p>';
  }
  return `<ul class="doc-list">${callLogs
    .map(
      (l) => `
    <li>
      <span><strong>${esc(l.call_date)}</strong> ${esc(l.content)}</span>
      <button class="danger" data-delete-call="${l.id}">삭제</button>
    </li>`
    )
    .join('')}</ul>`;
}

function bindCustomerDetailEvents(root, customer, hooks) {
  const id = customer.id;

  root.querySelector('[data-action="edit"]').addEventListener('click', () => openCustomerForm(customer));
  root.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    const deleted = await deleteCustomer(id);
    if (deleted) hooks.onDeleted();
  });

  root.querySelector('[data-action="save-progress"]').addEventListener('click', async () => {
    const value = root.querySelector('[data-progress-input]').value;
    const banner = root.querySelector('[data-progress-banner]');
    try {
      await api(`/api/customers/${id}/progress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress: value }),
      });
      banner.innerHTML = `<div class="banner success">진행상황이 저장되었습니다.</div>`;
    } catch (err) {
      banner.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  });

  root.querySelectorAll('[data-delete-doc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 파일을 삭제하시겠습니까?')) return;
      await api(`/api/documents/${btn.dataset.deleteDoc}`, { method: 'DELETE' });
      hooks.onChanged();
    });
  });

  root.querySelector('[data-doc-upload-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await api(`/api/customers/${id}/documents`, { method: 'POST', body: form });
      hooks.onChanged();
    } catch (err) {
      root.querySelector('[data-doc-error]').innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  });

  root.querySelectorAll('[data-delete-call]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 통화내역을 삭제하시겠습니까?')) return;
      await api(`/api/call-logs/${btn.dataset.deleteCall}`, { method: 'DELETE' });
      hooks.onChanged();
    });
  });

  root.querySelector('[data-call-log-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await api('/api/call-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: customer.phone,
          name: customer.name,
          call_date: form.get('call_date'),
          content: form.get('content').trim(),
        }),
      });
      hooks.onChanged();
    } catch (err) {
      root.querySelector('[data-call-log-error]').innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  });
}

async function openCustomerDetail(id) {
  const customer = await api(`/api/customers/${id}`);
  openModal(`
    <h2>${esc(customer.name)} 님 상세정보</h2>
    ${customerDetailBody(customer)}
    <div class="actions-row">
      <button type="button" class="secondary" id="close-detail">닫기</button>
    </div>
  `);
  document.getElementById('close-detail').addEventListener('click', closeModal);
  bindCustomerDetailEvents(modalRoot, customer, {
    onDeleted: () => {
      closeModal();
      refreshCurrentView();
    },
    onChanged: () => openCustomerDetail(id),
  });
}

function customerRow(c) {
  return `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${esc(c.referrer) || '<span class="muted">-</span>'}</td>
      <td>${esc(c.birth_date)}</td>
      <td>${esc(c.phone)}</td>
      <td>${esc(c.address)}</td>
      <td>${esc(c.diagnosis) || '<span class="muted">-</span>'}</td>
      <td>${formatKRW(c.estimated_amount)}</td>
      <td>${c.insurance_companies.map((ic) => `<span class="tag">${esc(ic.name)}</span>`).join('') || '<span class="muted">-</span>'}</td>
      <td>
        <button class="secondary" data-detail="${c.id}">상세</button>
        <button class="secondary" data-edit="${c.id}">수정</button>
        <button class="danger" data-delete="${c.id}">삭제</button>
      </td>
    </tr>`;
}

function bindTableActions(customers) {
  document.querySelectorAll('[data-detail]').forEach((btn) =>
    btn.addEventListener('click', () => openCustomerDetail(btn.dataset.detail))
  );
  document.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const customer = customers.find((c) => String(c.id) === btn.dataset.edit);
      openCustomerForm(customer);
    })
  );
  document.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const deleted = await deleteCustomer(btn.dataset.delete);
      if (deleted) await refreshCurrentView();
    })
  );
}

function managementRow(c) {
  return `
    <tr>
      <td>${c.id}</td>
      <td>${esc((c.created_at || '').slice(0, 10))}</td>
      <td>${esc(c.name)}</td>
      <td>${esc(c.case_type) || '<span class="muted">-</span>'}</td>
      <td><span class="tag ${c.retained === '미수임' ? 'tag-muted' : 'tag-live'}">${esc(c.retained || '수임')}</span></td>
      <td>${c.insurance_companies.map((ic) => `<span class="tag">${esc(ic.name)}</span>`).join('') || '<span class="muted">-</span>'}</td>
      <td>${esc(c.receipt_number) || '<span class="muted">-</span>'}</td>
      <td>${c.success_fee_rate !== null && c.success_fee_rate !== undefined ? `${esc(c.success_fee_rate)}%` : '<span class="muted">-</span>'}</td>
      <td>${esc(c.phone)}</td>
      <td><span class="tag ${c.status === '종결' ? 'tag-done' : 'tag-live'}">${esc(c.status || '진행')}</span></td>
      <td>${esc(c.manager) || '<span class="muted">-</span>'}</td>
      <td>${esc(c.case_title) || '<span class="muted">-</span>'}</td>
      <td>
        <button class="secondary" data-detail="${c.id}">상세</button>
        <button class="secondary" data-edit="${c.id}">수정</button>
        <button class="danger" data-delete="${c.id}">삭제</button>
      </td>
    </tr>`;
}

// ---- 고객 목록: 이름별 탭 + 상세 패널 ----
async function renderListView() {
  app.innerHTML = `
    <div class="card customer-layout">
      <div class="customer-sidebar">
        <div class="toolbar" style="margin-bottom:12px;">
          <input type="text" id="search-input" placeholder="이름으로 검색" value="${esc(state.customerSearch)}" style="width:100%;" />
        </div>
        <button class="primary" id="add-customer-btn" style="width:100%;margin-bottom:12px;">+ 고객 추가</button>
        <div id="customer-tabs">불러오는 중...</div>
      </div>
      <div id="customer-panel"><div class="empty-state">왼쪽에서 고객을 선택하세요.</div></div>
    </div>
  `;

  document.getElementById('add-customer-btn').addEventListener('click', () => openCustomerForm());
  const searchInput = document.getElementById('search-input');
  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.customerSearch = searchInput.value;
      renderListView();
    }, 300);
  });
  searchInput.focus();
  searchInput.setSelectionRange(state.customerSearch.length, state.customerSearch.length);

  const customers = await api(
    `/api/customers${state.customerSearch ? `?q=${encodeURIComponent(state.customerSearch)}` : ''}`
  );

  if (state.selectedCustomerId && !customers.some((c) => c.id === state.selectedCustomerId)) {
    state.selectedCustomerId = null;
  }
  if (!state.selectedCustomerId && customers.length) {
    state.selectedCustomerId = customers[0].id;
  }

  const tabsContainer = document.getElementById('customer-tabs');
  tabsContainer.innerHTML = customers.length
    ? customers
        .map(
          (c) =>
            `<button class="company-item ${state.selectedCustomerId === c.id ? 'active' : ''}" data-customer="${c.id}">${esc(c.name)}</button>`
        )
        .join('')
    : '<p class="muted">등록된 고객이 없습니다.</p>';

  tabsContainer.querySelectorAll('[data-customer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedCustomerId = Number(btn.dataset.customer);
      renderListView();
    });
  });

  const panel = document.getElementById('customer-panel');
  if (!state.selectedCustomerId) return;

  const customer = await api(`/api/customers/${state.selectedCustomerId}`);
  panel.innerHTML = `
    <h2>${esc(customer.name)} 님</h2>
    ${customerDetailBody(customer)}
  `;
  bindCustomerDetailEvents(panel, customer, {
    onDeleted: () => {
      state.selectedCustomerId = null;
      renderListView();
    },
    onChanged: () => renderListView(),
  });
}

async function renderCompaniesView() {
  const companies = await api('/api/insurance-companies');
  state.companies = companies;

  app.innerHTML = `
    <div class="card company-layout">
      <div class="company-sidebar">
        <button class="company-item ${state.selectedCompanyId === null ? 'active' : ''}" data-company="">전체 (${companies.length}개 보험사)</button>
        ${companies.map((c) => `<button class="company-item ${state.selectedCompanyId === c.id ? 'active' : ''}" data-company="${c.id}">${esc(c.name)}</button>`).join('')}
      </div>
      <div id="company-customers">불러오는 중...</div>
    </div>
  `;

  document.querySelectorAll('[data-company]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedCompanyId = btn.dataset.company ? Number(btn.dataset.company) : null;
      renderCompaniesView();
    });
  });

  const query = state.selectedCompanyId ? `?insurance_company_id=${state.selectedCompanyId}` : '';
  const customers = await api(`/api/customers${query}`);
  const container = document.getElementById('company-customers');
  container.innerHTML = customers.length
    ? `<div class="table-scroll"><table>
        <thead><tr><th>고객이름</th><th>소개자</th><th>생년월일</th><th>연락처</th><th>주소</th><th>진단명</th><th>추산금액</th><th>가입 보험회사</th><th>관리</th></tr></thead>
        <tbody>${customers.map(customerRow).join('')}</tbody>
      </table></div>`
    : '<div class="empty-state">해당 보험회사에 가입한 고객이 없습니다.</div>';
  bindTableActions(customers);
}

function renderUploadView() {
  app.innerHTML = `
    <div class="card" style="max-width:560px;">
      <h2>증권 / 진단서 파일 등록</h2>
      <p class="muted">파일을 업로드하고 아래 정보를 입력하면 일치하는 고객에게 자동으로 연결됩니다.
      고객이름, 전화번호, 주소, 생년월일이 모두 기존에 등록된 고객 정보와 일치해야 합니다.</p>
      <div id="upload-banner"></div>
      <form id="match-upload-form">
        <div class="form-grid">
          <label>파일 종류 *
            <select name="doc_type" required>
              <option value="증권">증권</option>
              <option value="진단서">진단서</option>
            </select>
          </label>
          <label>첨부파일 *
            <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required />
          </label>
          <label class="full">고객이름 *
            <input type="text" name="name" required />
          </label>
          <label>연락처 *
            <input type="text" name="phone" placeholder="010-000-0000" required />
          </label>
          <label>생년월일 *
            <input type="date" name="birth_date" required />
          </label>
          <label class="full">주소 *
            <input type="text" name="address" required />
          </label>
        </div>
        <div class="actions-row">
          <button type="submit" class="primary">등록</button>
        </div>
      </form>
    </div>
  `;

  document.getElementById('match-upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const banner = document.getElementById('upload-banner');
    try {
      const result = await api('/api/documents/match', { method: 'POST', body: form });
      banner.innerHTML = `<div class="banner success">${esc(result.customer.name)} 님에게 ${esc(result.document.doc_type)} 파일이 등록되었습니다.</div>`;
      e.target.reset();
    } catch (err) {
      banner.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  });
}

async function renderInquiriesView() {
  app.innerHTML = `<div class="card"><h2>홈페이지 상담문의</h2><div id="inquiries-body">불러오는 중...</div></div>`;

  const inquiries = await api('/api/inquiries');
  const body = document.getElementById('inquiries-body');
  body.innerHTML = inquiries.length
    ? `<div class="table-scroll"><table>
        <thead><tr><th>이름</th><th>연락처</th><th>문의내용</th><th>신청일시</th><th>관리</th></tr></thead>
        <tbody>${inquiries
          .map(
            (q) => `
          <tr>
            <td>${esc(q.name)}</td>
            <td>${esc(q.phone)}</td>
            <td>${esc(q.message) || '<span class="muted">-</span>'}</td>
            <td>${esc(q.created_at)}</td>
            <td>
              <button class="secondary" data-to-customer="${q.id}">고객 추가로 전환</button>
              <button class="danger" data-delete-inquiry="${q.id}">삭제</button>
            </td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`
    : '<div class="empty-state">아직 접수된 상담문의가 없습니다.</div>';

  body.querySelectorAll('[data-to-customer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inquiry = inquiries.find((q) => String(q.id) === btn.dataset.toCustomer);
      openCustomerForm(null, { name: inquiry.name, phone: inquiry.phone });
    });
  });

  body.querySelectorAll('[data-delete-inquiry]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 문의를 삭제하시겠습니까?')) return;
      await api(`/api/inquiries/${btn.dataset.deleteInquiry}`, { method: 'DELETE' });
      renderInquiriesView();
    });
  });
}

async function loadWorkLogs() {
  const list = document.getElementById('worklog-list');
  const logs = await api('/api/work-logs?limit=10');
  list.innerHTML = logs.length
    ? `<ul class="worklog-list">${logs
        .map(
          (l) => `
      <li class="worklog-item">
        <span class="tag">${esc(l.log_type)}</span>
        ${l.related_name ? `<strong>${esc(l.related_name)}</strong>` : ''}
        <div class="worklog-meta">
          <span>${esc(l.manager) || '담당자 미기재'}</span>
          <span>·</span>
          <span>${esc(l.created_at)}</span>
          <button class="danger" data-delete-log="${l.id}" style="margin-left:auto;">삭제</button>
        </div>
        <div class="worklog-content">${esc(l.content)}</div>
      </li>`
        )
        .join('')}</ul>`
    : '<p class="muted">등록된 업무일지가 없습니다.</p>';

  list.querySelectorAll('[data-delete-log]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 업무일지를 삭제하시겠습니까?')) return;
      await api(`/api/work-logs/${btn.dataset.deleteLog}`, { method: 'DELETE' });
      await loadWorkLogs();
    });
  });
}

// ---- 고객관리: 최근 업무일지 + 사건 목록 표 ----
async function renderManagementView(query = '') {
  app.innerHTML = `
    <div class="card">
      <h2>최근 업무일지</h2>
      <div id="worklog-list">불러오는 중...</div>
      <form id="worklog-form" style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">
        <select name="log_type" required style="min-width:110px;">
          <option value="고객통화">고객통화</option>
          <option value="서류접수">서류접수</option>
          <option value="보험사협의">보험사협의</option>
          <option value="기타업무">기타업무</option>
        </select>
        <input type="text" name="related_name" placeholder="관련 고객/사건명 (선택)" style="min-width:160px;" />
        <input type="text" name="manager" placeholder="담당자" style="min-width:100px;" />
        <input type="text" name="content" placeholder="업무 내용" required style="flex:1;min-width:200px;" />
        <button type="submit" class="primary">기록 추가</button>
      </form>
      <div id="worklog-error"></div>
    </div>

    <div class="card">
      <div class="toolbar">
        <input type="text" id="mgmt-search-input" placeholder="고객명, 연락처 등으로 검색" value="${esc(query)}" style="flex:1;min-width:200px;" />
        <select id="mgmt-retained-filter">
          <option value="">수임여부 전체</option>
          <option value="수임">수임</option>
          <option value="미수임">미수임</option>
        </select>
        <select id="mgmt-status-filter">
          <option value="">상태 전체</option>
          <option value="진행">진행</option>
          <option value="종결">종결</option>
        </select>
        <button class="primary" id="mgmt-add-btn">+ 고객 추가</button>
      </div>
      <div id="mgmt-body">불러오는 중...</div>
    </div>
  `;

  await loadWorkLogs();

  document.getElementById('worklog-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await api('/api/work-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          log_type: form.get('log_type'),
          related_name: form.get('related_name').trim(),
          manager: form.get('manager').trim(),
          content: form.get('content').trim(),
        }),
      });
      e.target.reset();
      await loadWorkLogs();
    } catch (err) {
      document.getElementById('worklog-error').innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  });

  document.getElementById('mgmt-add-btn').addEventListener('click', () => openCustomerForm());

  const searchInput = document.getElementById('mgmt-search-input');
  const retainedFilter = document.getElementById('mgmt-retained-filter');
  const statusFilter = document.getElementById('mgmt-status-filter');
  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => renderManagementView(searchInput.value), 300);
  });
  searchInput.focus();
  searchInput.setSelectionRange(query.length, query.length);
  retainedFilter.addEventListener('change', loadManagementTable);
  statusFilter.addEventListener('change', loadManagementTable);

  async function loadManagementTable() {
    const body = document.getElementById('mgmt-body');
    body.innerHTML = '불러오는 중...';
    let customers = await api(`/api/customers${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    if (retainedFilter.value) customers = customers.filter((c) => (c.retained || '수임') === retainedFilter.value);
    if (statusFilter.value) customers = customers.filter((c) => (c.status || '진행') === statusFilter.value);
    body.innerHTML = customers.length
      ? `<div class="table-scroll"><table>
          <thead><tr><th>사건번호</th><th>등록일</th><th>고객명</th><th>사건종류</th><th>수임여부</th><th>보험사</th><th>접수번호</th><th>성공보수율</th><th>전화번호</th><th>상태</th><th>담당자</th><th>내용</th><th>작업</th></tr></thead>
          <tbody>${customers.map(managementRow).join('')}</tbody>
        </table></div>`
      : '<div class="empty-state">등록된 사건이 없습니다.</div>';
    bindTableActions(customers);
  }

  await loadManagementTable();
}

// ---- 통화내역 (전화번호를 고객 분류번호로 사용) ----
async function renderCallLogsView(phoneFilter = '') {
  app.innerHTML = `
    <div class="card">
      <h2>통화내역 등록</h2>
      <p class="muted">전화번호를 고객 분류번호로 사용합니다. 같은 번호로 여러 날짜의 통화를 이어서 등록할 수 있습니다.</p>
      <form id="call-log-form" class="form-grid">
        <label>전화번호 *
          <input type="text" name="phone" placeholder="010-000-0000" required />
        </label>
        <label>이름
          <input type="text" name="name" placeholder="고객 이름" />
        </label>
        <label>통화일자 *
          <input type="date" name="call_date" required />
        </label>
        <label class="full">업무내용 (통화 요약) *
          <textarea name="content" rows="3" placeholder="통화 내용을 요약해서 적어주세요" required></textarea>
        </label>
        <div class="actions-row full">
          <button type="submit" class="primary">통화내역 추가</button>
        </div>
      </form>
      <div id="call-log-error"></div>
    </div>

    <div class="card">
      <div class="toolbar">
        <input type="text" id="call-log-search" placeholder="전화번호로 조회 (예: 010-8732-8681)" value="${esc(phoneFilter)}" style="flex:1;min-width:200px;" />
      </div>
      <div id="call-log-body">불러오는 중...</div>
    </div>
  `;

  const form = document.getElementById('call-log-form');
  const phoneInput = form.elements.phone;
  const nameInput = form.elements.name;
  if (phoneFilter) phoneInput.value = phoneFilter;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    try {
      await api('/api/call-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: data.get('phone').trim(),
          name: data.get('name').trim(),
          call_date: data.get('call_date'),
          content: data.get('content').trim(),
        }),
      });
      const keepPhone = phoneInput.value;
      const keepName = nameInput.value;
      form.reset();
      phoneInput.value = keepPhone;
      nameInput.value = keepName;
      form.elements.call_date.focus();
      await loadCallLogs(keepPhone);
      document.getElementById('call-log-search').value = keepPhone;
    } catch (err) {
      document.getElementById('call-log-error').innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  });

  const searchInput = document.getElementById('call-log-search');
  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => loadCallLogs(searchInput.value.trim()), 300);
  });

  async function loadCallLogs(phone) {
    const body = document.getElementById('call-log-body');
    body.innerHTML = '불러오는 중...';
    const logs = await api(`/api/call-logs${phone ? `?phone=${encodeURIComponent(phone)}` : ''}`);
    body.innerHTML = logs.length
      ? `<div class="table-scroll"><table>
          <thead><tr><th>통화일자</th><th>전화번호</th><th>이름</th><th>업무내용</th><th>관리</th></tr></thead>
          <tbody>${logs
            .map(
              (l) => `
            <tr>
              <td>${esc(l.call_date)}</td>
              <td>${esc(l.phone)}</td>
              <td>${esc(l.name) || '<span class="muted">-</span>'}</td>
              <td>${esc(l.content)}</td>
              <td><button class="danger" data-delete-call="${l.id}">삭제</button></td>
            </tr>`
            )
            .join('')}</tbody>
        </table></div>`
      : '<div class="empty-state">등록된 통화내역이 없습니다.</div>';

    body.querySelectorAll('[data-delete-call]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('이 통화내역을 삭제하시겠습니까?')) return;
        await api(`/api/call-logs/${btn.dataset.deleteCall}`, { method: 'DELETE' });
        await loadCallLogs(searchInput.value.trim());
      });
    });
  }

  await loadCallLogs(phoneFilter);
}

async function refreshCurrentView() {
  render();
}

function render() {
  if (state.view === 'list') renderListView();
  else if (state.view === 'management') renderManagementView();
  else if (state.view === 'companies') renderCompaniesView();
  else if (state.view === 'upload') renderUploadView();
  else if (state.view === 'inquiries') renderInquiriesView();
  else if (state.view === 'calls') renderCallLogsView();
}

render();
