const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');

const state = {
  view: 'list',
  companies: [],
  selectedCompanyId: null,
  selectedCustomerId: null,
  customerSearch: '',
  mgmtSearch: '',
  openDocGroups: new Set(),
  hospitalSlots: {},
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

// folderHtml이 있으면 신규 등록 화면: 이름·연락처·소개자만 직접 입력하고 나머지는 서류에서 자동 입력
function customerFormFields(customer = {}, folderHtml = null) {
  const isAdd = folderHtml !== null;
  const companies = (customer.insurance_companies || []).map((c) => c.name).join(', ');

  const detailFields = `
      <label>생년월일
        <input type="date" name="birth_date" value="${esc(customer.birth_date)}" />
      </label>
      <label>사고종류
        <input type="text" name="case_type" value="${esc(customer.case_type)}" placeholder="예: 교통사고, 암진단, 허리디스크" />
      </label>
      <label class="full">주소
        <input type="text" name="address" value="${esc(customer.address)}" />
      </label>
      <label class="full">진단명
        <input type="text" name="diagnosis" value="${esc(customer.diagnosis)}" placeholder="예: 고혈압, 당뇨" />
      </label>
      <label class="full">청구내용 (요약)
        <input type="text" name="case_title" value="${esc(customer.case_title)}" placeholder="예: 대장 용종 제거 후 고등급 선종 진단, 유사암진단비 청구" />
      </label>
      <label class="full">가입 보험회사 (콤마로 구분, 여러 곳 가능)
        <input type="text" name="insurance_companies" value="${esc(companies)}" placeholder="예: 삼성생명, 교보생명" />
      </label>
      <label class="full">추산금액 (청구 예정 보험담보 추산금액, 원)
        <input type="number" name="estimated_amount" value="${esc(customer.estimated_amount)}" placeholder="예: 3000000" min="0" step="1" />
      </label>`;

  if (isAdd) {
    return `
    <div class="form-grid">
      <label>고객이름 *
        <input type="text" name="name" value="${esc(customer.name)}" required />
      </label>
      <label>연락처 *
        <input type="text" name="phone" value="${esc(customer.phone)}" placeholder="010-000-0000" required />
      </label>
      <label class="full">소개자
        <input type="text" name="referrer" value="${esc(customer.referrer)}" placeholder="소개해준 사람" />
      </label>
    </div>

    ${folderHtml}

    <details class="auto-fields" open>
      <summary>서류에서 자동 입력되는 항목 (직접 입력하지 않아도 됩니다 · 확인·수정 가능)</summary>
      <div class="form-grid">${detailFields}
      </div>
    </details>
  `;
  }

  return `
    <div class="form-grid">
      <label>고객이름 *
        <input type="text" name="name" value="${esc(customer.name)}" required />
      </label>
      <label>소개자
        <input type="text" name="referrer" value="${esc(customer.referrer)}" placeholder="소개해준 사람" />
      </label>
      <label class="full">연락처 *
        <input type="text" name="phone" value="${esc(customer.phone)}" placeholder="010-000-0000" required />
      </label>${detailFields}
    </div>

    <h3 class="form-section-title">사건 관리 정보</h3>
    <div class="form-grid">
      <label>수임여부
        <select name="retained">
          <option value="수임" ${customer.retained !== '미수임' ? 'selected' : ''}>수임</option>
          <option value="미수임" ${customer.retained === '미수임' ? 'selected' : ''}>미수임</option>
        </select>
      </label>
      <label>상태
        <select name="status">
          <option value="진행" ${customer.status !== '종결' ? 'selected' : ''}>진행</option>
          <option value="종결" ${customer.status === '종결' ? 'selected' : ''}>종결</option>
        </select>
      </label>
      <label>접수번호
        <input type="text" name="receipt_number" value="${esc(customer.receipt_number)}" />
      </label>
      <label>성공보수율 (%)
        <input type="number" name="success_fee_rate" value="${esc(customer.success_fee_rate)}" min="0" max="100" step="0.1" />
      </label>
      <label class="full">담당자
        <input type="text" name="manager" value="${esc(customer.manager)}" />
      </label>
    </div>
  `;
}

// ---- 폴더로 고객 등록: 파일 분류 도우미 ----
const IGNORED_FILE_NAMES = /^(thumbs\.db|\.ds_store|desktop\.ini|~\$.*)$/i;
const OCR_FILE_EXT = /\.(pdf|jpe?g|png)$/i;
// 서류로 등록할 수 있는 형식 / 영상(DICOM) 폴더는 제외 / 내용 확인(OCR)이 필요 없는 서류 이름
const DOCUMENT_EXT = /\.(pdf|jpe?g|png|gif|bmp|tiff?|hwpx?|docx?|xlsx?|pptx?|txt|zip)$/i;
const SKIP_FOLDER = /영상|dicom|dcm/i;
const NON_MEDICAL_NAME = /약관|지급결의서|사정서|동의서|지연|안내문|결의서|청구서|영수증|계약|증권/;
const HOSPITAL_KEYWORDS = /진단서|소견서|병원|의무기록|진료|입퇴원|수술|처방|검사결과|영상/;

function folderCustomerName(folderName) {
  const matches = folderName.match(/[가-힣]{2,4}/g);
  return matches ? matches[matches.length - 1] : '';
}

// 파일명에서 병원명을 추정 (예: "보라매 소견서" -> "보라매"). 고객 이름이 들어 있으면 제외
function guessHospitalName(baseName, customerName) {
  let text = baseName;
  if (customerName) text = text.split(customerName).join(' ');
  const m = text.match(/^(.*?)[\s_\-]*(?:진단서|소견서|의무기록|진료기록|입퇴원확인서|수술기록|병원서류|서류)/);
  return (m ? m[1] : '').replace(/[\s_\-]+/g, ' ').trim();
}

function classifyFile(fileName, customerName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  if (/증권/.test(base)) return { doc_type: '증권', hospital_name: '' };
  if (HOSPITAL_KEYWORDS.test(base)) {
    return { doc_type: '병원', hospital_name: guessHospitalName(base, customerName) };
  }
  return { doc_type: '기타', hospital_name: '' };
}

function openCustomerForm(customer = null, prefill = {}) {
  const folderSection = customer
    ? null
    : `
      <div class="card" style="padding:14px;margin:16px 0;background:#f7f9fc;">
        <label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:6px;">
          고객 폴더로 등록 (선택) — 폴더를 선택하면 안의 파일을 하나씩 증권 / 병원 / 기타서류로 분류해 등록하고,
          진단서·증권을 읽어 생년월일, 주소, 진단명, 보험회사 등 나머지 항목을 자동으로 채워줍니다.
        </label>
        <input type="file" id="folder-input" webkitdirectory multiple />
        <div id="folder-status" style="margin-top:8px;font-size:13px;"></div>
        <div id="folder-files"></div>
      </div>
    `;

  openModal(`
    <h2>${customer ? '고객 정보 수정' : '고객 추가'}</h2>
    <div id="form-error"></div>
    <form id="customer-form">
      ${customerFormFields(customer || prefill, folderSection)}
      <div class="actions-row">
        <button type="submit" class="primary" id="customer-save-btn">저장</button>
        <button type="button" class="secondary" id="cancel-form">취소</button>
      </div>
    </form>
  `);

  document.getElementById('cancel-form').addEventListener('click', closeModal);

  const folderInput = document.getElementById('folder-input');
  const saveBtn = document.getElementById('customer-save-btn');
  let folderFiles = [];

  function renderFolderRows() {
    const box = document.getElementById('folder-files');
    if (!folderFiles.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `
      <div class="table-scroll"><table class="folder-table">
        <thead><tr><th>파일</th><th>분류</th><th>병원명</th><th></th></tr></thead>
        <tbody>${folderFiles
          .map(
            (row, i) => `
          <tr>
            <td>${esc(row.file.name)}</td>
            <td>
              <select data-folder-type="${i}">
                <option value="증권" ${row.doc_type === '증권' ? 'selected' : ''}>증권</option>
                <option value="병원" ${row.doc_type === '병원' ? 'selected' : ''}>병원</option>
                <option value="기타" ${row.doc_type === '기타' ? 'selected' : ''}>기타서류</option>
              </select>
            </td>
            <td><input type="text" data-folder-hospital="${i}" value="${esc(row.hospital_name)}" placeholder="병원명" ${row.doc_type === '병원' ? '' : 'hidden'} /></td>
            <td><button type="button" class="danger" data-folder-remove="${i}">제외</button></td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`;

    box.querySelectorAll('[data-folder-type]').forEach((sel) =>
      sel.addEventListener('change', () => {
        const row = folderFiles[Number(sel.dataset.folderType)];
        row.doc_type = sel.value;
        const hospitalInput = box.querySelector(`[data-folder-hospital="${sel.dataset.folderType}"]`);
        hospitalInput.hidden = sel.value !== '병원';
      })
    );
    box.querySelectorAll('[data-folder-hospital]').forEach((input) =>
      input.addEventListener('input', () => {
        folderFiles[Number(input.dataset.folderHospital)].hospital_name = input.value;
      })
    );
    box.querySelectorAll('[data-folder-remove]').forEach((btn) =>
      btn.addEventListener('click', () => {
        folderFiles.splice(Number(btn.dataset.folderRemove), 1);
        renderFolderRows();
      })
    );
  }

  if (folderInput) {
    folderInput.addEventListener('change', async () => {
      const status = document.getElementById('folder-status');
      const allFiles = [...folderInput.files];
      const files = allFiles.filter(
        (f) =>
          !IGNORED_FILE_NAMES.test(f.name) &&
          DOCUMENT_EXT.test(f.name) &&
          !SKIP_FOLDER.test((f.webkitRelativePath || '').split('/').slice(0, -1).join('/'))
      );
      const skippedCount = allFiles.length - files.length;
      folderFiles = [];
      if (!files.length) {
        status.innerHTML = allFiles.length
          ? '<span style="color:var(--danger);">등록할 수 있는 서류 파일(PDF, 이미지, 한글, 워드 등)이 없습니다.</span>'
          : '';
        renderFolderRows();
        return;
      }

      const folderName = (files[0].webkitRelativePath || '').split('/')[0];
      const nameFromFolder = folderCustomerName(folderName);
      folderFiles = files.map((file) => ({ file, ...classifyFile(file.name, nameFromFolder) }));
      renderFolderRows();
      const skippedNote = skippedCount ? ` (영상·프로그램 등 서류가 아닌 파일 ${skippedCount}개는 제외)` : '';

      // 내용으로 서류 종류와 고객 정보를 확인할 파일 선정: 진단서·소견서 우선, 약관·지급결의서 등은 제외
      const priority = (row) => (/진단서/.test(row.file.name) ? 0 : row.doc_type === '병원' ? 1 : 2);
      const candidates = folderFiles
        .filter(
          (row) =>
            OCR_FILE_EXT.test(row.file.name) &&
            row.file.size <= 20 * 1024 * 1024 &&
            row.doc_type !== '증권' &&
            !NON_MEDICAL_NAME.test(row.file.name)
        )
        .sort((a, b) => priority(a) - priority(b))
        .slice(0, 6);
      const policies = folderFiles.filter((row) => row.doc_type === '증권' && OCR_FILE_EXT.test(row.file.name)).slice(0, 3);

      saveBtn.disabled = true;
      const merged = {};
      const hospitals = [];
      const insurers = [];
      let finished = 0;
      const total = candidates.length + policies.length;
      const showProgress = () => {
        status.innerHTML = `<span class="muted">서류 내용 확인 중... (${finished}/${total}) 스캔본은 파일당 10초 정도 걸립니다.${skippedNote}</span>`;
      };

      try {
        if (total) showProgress();

        // 최대 2개씩 동시에 분석 (서버 OCR 워커가 병렬 처리)
        const jobs = [
          ...candidates.map((row) => async () => {
            const fd = new FormData();
            fd.append('file', row.file);
            try {
              const { fields = {} } = await api('/api/documents/extract', { method: 'POST', body: fd });
              const isMedical = fields.kind === 'hospital' || /진단서|소견서/.test(row.file.name);
              if (isMedical) {
                for (const [key, value] of Object.entries(fields)) if (value && !merged[key]) merged[key] = value;
                if (fields.hospital) hospitals.push(fields.hospital);
              }
              if (fields.kind === 'hospital' && row.doc_type === '기타') {
                row.doc_type = '병원';
                row.hospital_name = guessHospitalName(row.file.name.replace(/\.[^.]+$/, ''), nameFromFolder);
              }
              if (fields.hospital && row.doc_type === '병원' && /진단서|소견서/.test(row.file.name)) {
                row.hospital_name = fields.hospital;
              }
            } catch (err) {
              // 분석에 실패한 파일은 파일명 기준 분류를 그대로 사용
            }
          }),
          ...policies.map((row) => async () => {
            const fd = new FormData();
            fd.append('file', row.file);
            try {
              const { fields = {} } = await api('/api/documents/extract?kind=policy', { method: 'POST', body: fd });
              for (const name of fields.insurers || []) if (!insurers.includes(name)) insurers.push(name);
            } catch (err) {
              // 증권 인식 실패는 무시
            }
          }),
        ];
        let next = 0;
        const runner = async () => {
          while (next < jobs.length) {
            const job = jobs[next++];
            await job();
            finished++;
            showProgress();
          }
        };
        await Promise.all([runner(), runner()]);

        // 진단서에서 읽은 정식 병원명(예: 서울특별시보라매병원)으로 같은 병원의 다른 서류도 통일
        for (const row of folderFiles) {
          if (row.doc_type !== '병원' || !row.hospital_name) continue;
          const full = hospitals.find((h) => h.includes(row.hospital_name.replace(/\s/g, '')));
          if (full) row.hospital_name = full;
        }

        const form = document.getElementById('customer-form');
        const filled = [];
        const setIfEmpty = (fieldName, value, label) => {
          const el = form.elements[fieldName];
          if (value && el && !el.value) {
            el.value = value;
            filled.push(label);
          }
        };
        setIfEmpty('name', nameFromFolder, '이름');
        setIfEmpty('birth_date', merged.birth_date, '생년월일');
        setIfEmpty('address', merged.address, '주소');
        setIfEmpty('diagnosis', merged.diagnosis, '진단명');
        setIfEmpty('case_type', merged.case_type, '사고종류');
        setIfEmpty('insurance_companies', insurers.join(', '), '보험회사');

        renderFolderRows();
        const counts = ['증권', '병원', '기타'].map((t) => `${t === '기타' ? '기타서류' : t} ${folderFiles.filter((r) => r.doc_type === t).length}건`);
        status.innerHTML = `<span style="color:#1c7c42;">파일 ${folderFiles.length}개 분류 완료 (${counts.join(', ')})${skippedNote}. ${
          filled.length ? `서류에서 자동 입력: ${filled.join(', ')}.` : '서류에서 인식된 고객 정보가 없습니다.'
        } 아래 항목을 확인하고 저장해주세요.</span>`;

        if (!form.elements.phone.value) {
          status.innerHTML += '<div style="color:var(--danger);margin-top:4px;">연락처를 입력해야 저장됩니다.</div>';
          form.elements.phone.scrollIntoView({ block: 'center' });
          form.elements.phone.focus();
        }
      } catch (err) {
        status.innerHTML = `<span style="color:var(--danger);">폴더 분석 중 오류가 발생했습니다: ${esc(err.message)}</span>`;
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  document.getElementById('customer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const text = (field) => (form.get(field) || '').trim();
    const payload = {
      name: text('name'),
      referrer: text('referrer'),
      phone: text('phone'),
      birth_date: form.get('birth_date') || '',
      address: text('address'),
      diagnosis: text('diagnosis'),
      estimated_amount: form.get('estimated_amount') ? Number(form.get('estimated_amount')) : null,
      case_type: text('case_type'),
      retained: form.get('retained') || undefined,
      receipt_number: text('receipt_number'),
      success_fee_rate: form.get('success_fee_rate') ? Number(form.get('success_fee_rate')) : null,
      status: form.get('status') || undefined,
      manager: text('manager'),
      case_title: text('case_title'),
      insurance_companies: text('insurance_companies')
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

      const failed = [];
      if (folderFiles.length) {
        saveBtn.disabled = true;
        const status = document.getElementById('folder-status');
        for (let i = 0; i < folderFiles.length; i++) {
          const row = folderFiles[i];
          status.innerHTML = `<span class="muted">서류 등록 중... (${i + 1}/${folderFiles.length}) ${esc(row.file.name)}</span>`;
          const docFd = new FormData();
          docFd.append('file', row.file);
          docFd.append('doc_type', row.doc_type);
          docFd.append('hospital_name', row.hospital_name || '');
          try {
            await api(`/api/customers/${saved.id}/documents`, { method: 'POST', body: docFd });
          } catch (docErr) {
            failed.push(`${row.file.name} (${docErr.message})`);
          }
        }
      }
      if (failed.length) {
        alert(`고객 정보는 저장되었지만 일부 서류 등록에 실패했습니다:\n${failed.join('\n')}`);
      }

      state.selectedCustomerId = saved.id;
      closeModal();
      await refreshCurrentView();
    } catch (err) {
      const errorBox = document.getElementById('form-error');
      errorBox.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
      errorBox.scrollIntoView({ block: 'center' });
      saveBtn.disabled = false;
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

    <h3>진행사항</h3>
    <textarea data-progress-input rows="4" placeholder="예: 2026-09-09 서류 접수 완료, 보험사 심사 진행중">${esc(customer.progress)}</textarea>
    <div class="actions-row" style="margin-top:8px;">
      <button type="button" class="primary" data-action="save-progress">진행사항 저장</button>
    </div>
    <div data-progress-banner></div>

    ${documentsSectionHtml(customer)}
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

// ---- 사건 관리 정보: 증권 / 병원(병원별) / 기타서류 ----
const DOC_GROUP_LABELS = { 증권: '증권', 병원: '병원', 기타: '기타서류' };

function docItemHtml(d) {
  return `
    <li class="doc-item">
      <div class="doc-item-row">
        <span>${esc(d.file_name)} <span class="muted">(${esc(d.uploaded_at)})</span></span>
        <span>
          <a href="/api/documents/${d.id}/file" class="link-as-btn" target="_blank">열기</a>
          <button class="danger" data-delete-doc="${d.id}">삭제</button>
        </span>
      </div>
      <details class="doc-move" ${d.doc_type === '기타' ? 'open' : ''}>
        <summary>분류 변경</summary>
        <form data-move-doc="${d.id}" class="doc-move-form">
          <select name="doc_type">${Object.entries(DOC_GROUP_LABELS)
            .map(([type, label]) => `<option value="${type}" ${type === d.doc_type ? 'selected' : ''}>${label}</option>`)
            .join('')}</select>
          <input type="text" name="hospital_name" list="hospital-list-${d.customer_id}" placeholder="병원명" value="${esc(d.hospital_name)}" ${d.doc_type === '병원' ? '' : 'hidden'} />
          <button type="submit" class="secondary">변경</button>
        </form>
      </details>
    </li>`;
}

function documentsSectionHtml(customer) {
  const docs = (customer.documents || []).map((d) => ({ ...d, customer_id: customer.id }));
  const policies = docs.filter((d) => d.doc_type === '증권');
  const hospitalDocs = docs.filter((d) => d.doc_type === '병원');
  const others = docs.filter((d) => d.doc_type === '기타');
  const hospitals = [...new Set(hospitalDocs.map((d) => d.hospital_name || ''))];
  const isOpen = (group) => (state.openDocGroups.has(group) ? 'open' : '');
  const list = (items) => `<ul class="doc-list">${items.map(docItemHtml).join('')}</ul>`;
  const uploadForm = (type, withHospital) => `
    <form data-doc-upload-form data-doc-type="${type}" class="doc-upload-form">
      ${withHospital ? `<input type="text" name="hospital_name" list="hospital-list-${customer.id}" placeholder="병원명 (예: 서울특별시보라매병원)" required />` : ''}
      <input type="file" name="files" multiple required />
      <button type="submit" class="primary">${DOC_GROUP_LABELS[type]} 등록</button>
    </form>`;

  return `
    <h3>사건 관리 정보 · 서류</h3>
    <datalist id="hospital-list-${customer.id}">${hospitals.filter(Boolean).map((h) => `<option value="${esc(h)}"></option>`).join('')}</datalist>

    <details class="doc-group" data-doc-group="증권" ${isOpen('증권')}>
      <summary>증권 <span class="tag">${policies.length}</span></summary>
      ${policies.length ? list(policies) : '<p class="muted">등록된 증권이 없습니다.</p>'}
      ${uploadForm('증권', false)}
    </details>

    <details class="doc-group" data-doc-group="병원" ${isOpen('병원')}>
      <summary>병원 <span class="tag">${hospitalDocs.length}</span> <span class="muted">${hospitals.length}곳</span></summary>
      ${
        hospitals.length
          ? hospitals
              .map((h) => {
                const items = hospitalDocs.filter((d) => (d.hospital_name || '') === h);
                return `<h4 class="hospital-title">${esc(h || '병원 미지정')} <span class="tag">${items.length}</span></h4>${list(items)}`;
              })
              .join('')
          : '<p class="muted">등록된 병원서류가 없습니다.</p>'
      }
      ${uploadForm('병원', true)}
    </details>

    <details class="doc-group" data-doc-group="기타" ${isOpen('기타')}>
      <summary>기타서류 <span class="tag tag-muted">${others.length}</span> <span class="muted">증권·병원에 해당하지 않는 서류 — 확인 후 '분류 변경'으로 옮기세요</span></summary>
      ${others.length ? list(others) : '<p class="muted">등록된 기타서류가 없습니다.</p>'}
      ${uploadForm('기타', false)}
    </details>
  `;
}

function bindDocumentEvents(root, customer, hooks) {
  const errorBox = root.querySelector('[data-doc-error]');

  root.querySelectorAll('details.doc-group').forEach((el) =>
    el.addEventListener('toggle', () => {
      if (el.open) state.openDocGroups.add(el.dataset.docGroup);
      else state.openDocGroups.delete(el.dataset.docGroup);
    })
  );

  root.querySelectorAll('[data-delete-doc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 파일을 삭제하시겠습니까?')) return;
      await api(`/api/documents/${btn.dataset.deleteDoc}`, { method: 'DELETE' });
      hooks.onChanged();
    });
  });

  root.querySelectorAll('[data-doc-upload-form]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const hospital = form.elements.hospital_name ? form.elements.hospital_name.value.trim() : '';
      const failed = [];
      for (const file of form.elements.files.files) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('doc_type', form.dataset.docType);
        fd.append('hospital_name', hospital);
        try {
          await api(`/api/customers/${customer.id}/documents`, { method: 'POST', body: fd });
        } catch (err) {
          failed.push(`${file.name} (${err.message})`);
        }
      }
      if (failed.length) alert(`일부 파일 등록에 실패했습니다:\n${failed.join('\n')}`);
      hooks.onChanged();
    });
  });

  root.querySelectorAll('[data-move-doc]').forEach((form) => {
    const typeSelect = form.elements.doc_type;
    const hospitalInput = form.elements.hospital_name;
    typeSelect.addEventListener('change', () => {
      hospitalInput.hidden = typeSelect.value !== '병원';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/api/documents/${form.dataset.moveDoc}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doc_type: typeSelect.value, hospital_name: hospitalInput.value.trim() }),
        });
        hooks.onChanged();
      } catch (err) {
        errorBox.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
      }
    });
  });
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
      banner.innerHTML = `<div class="banner success">진행사항이 저장되었습니다.</div>`;
    } catch (err) {
      banner.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  });

  bindDocumentEvents(root, customer, hooks);

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

// ---- 고객관리 표: 서류 칸에서 바로 PDF 추가 (병원은 제1병원, 제2병원 … 칸별로) ----
const DOC_ACCEPT = '.pdf,.jpg,.jpeg,.png';
const UNASSIGNED_HOSPITAL = '병원 미지정';

function docRowHtml(d, moveOptionsHtml = '') {
  return `
    <div class="doc-row">
      <a class="doc-link" href="/api/documents/${d.id}/file" target="_blank" title="${esc(d.file_name)}">${esc(d.file_name)}</a>
      <button type="button" class="doc-x" data-del-doc="${d.id}" title="삭제">×</button>
      ${
        moveOptionsHtml
          ? `<select class="doc-move-select" data-quick-move="${d.id}" title="증권 또는 병원서류로 옮기기">${moveOptionsHtml}</select>`
          : ''
      }
    </div>`;
}

function addDocButton(customerId, docType, hospital = '') {
  return `<label class="add-doc-btn">+ PDF 추가<input type="file" hidden multiple accept="${DOC_ACCEPT}" data-add-doc="${customerId}" data-doc-type="${docType}" data-hospital="${esc(hospital)}" /></label>`;
}

// 서류가 있는 병원 + 비어 있는 제N병원 칸(처음엔 제1·제2병원, 항상 여분 1칸)을 번호순으로 반환
function hospitalSlots(c) {
  const docs = (c.documents || []).filter((d) => d.doc_type === '병원');
  const groups = [];
  for (const d of docs) {
    const name = d.hospital_name || UNASSIGNED_HOSPITAL;
    if (!groups.includes(name)) groups.push(name);
  }
  const namedCount = groups.filter((n) => n !== UNASSIGNED_HOSPITAL).length;
  let empties = Math.max(1, 2 - namedCount) + (state.hospitalSlots[c.id] || 0);
  const slots = [...groups];
  for (let i = 1; empties > 0; i++) {
    const name = `제${i}병원`;
    if (!slots.includes(name)) {
      slots.push(name);
      empties--;
    }
  }
  const order = (name) => {
    const m = name.match(/^제(\d+)병원$/);
    if (name === UNASSIGNED_HOSPITAL) return 1e6;
    return m ? Number(m[1]) : 1000 + groups.indexOf(name);
  };
  return slots.sort((a, b) => order(a) - order(b));
}

function hospitalDocCell(c) {
  const docs = (c.documents || []).filter((d) => d.doc_type === '병원');
  const html = hospitalSlots(c)
    .map((name) => {
      const items = docs.filter((d) => (d.hospital_name || UNASSIGNED_HOSPITAL) === name);
      const unassigned = name === UNASSIGNED_HOSPITAL;
      return `
        <div class="hospital-group">
          <div class="hospital-name">
            <span>${esc(name)}</span>
            ${items.length ? `<button type="button" class="doc-x" data-rename-hospital="${c.id}" data-from="${unassigned ? '' : esc(name)}" title="병원 이름 바꾸기">✎</button>` : ''}
          </div>
          ${items.map((d) => docRowHtml(d)).join('')}
          ${unassigned ? '' : addDocButton(c.id, '병원', name)}
        </div>`;
    })
    .join('');
  return `${html}<button type="button" class="add-doc-btn" data-add-hospital="${c.id}">+ 병원 칸 추가</button>`;
}

function managementRow(c) {
  const dash = '<span class="muted">-</span>';
  const docs = c.documents || [];
  const companies = c.insurance_companies.map((ic) => `<span class="tag">${esc(ic.name)}</span>`).join('');
  const policyDocs = docs.filter((d) => d.doc_type === '증권').map((d) => docRowHtml(d)).join('');
  const moveOptions =
    '<option value="">이동</option><option value="증권">증권</option>' +
    hospitalSlots(c)
      .filter((name) => name !== UNASSIGNED_HOSPITAL)
      .map((name) => `<option value="병원:${esc(name)}">${esc(name)}</option>`)
      .join('');
  const otherDocs = docs.filter((d) => d.doc_type === '기타').map((d) => docRowHtml(d, moveOptions)).join('');

  return `
    <tr>
      <td class="cell-name"><button type="button" class="link-btn" data-detail="${c.id}">${esc(c.name)}</button></td>
      <td class="cell-num">${esc(c.phone)}</td>
      <td class="cell-wide">${c.case_title ? `<div class="clamp">${esc(c.case_title)}</div>` : dash}</td>
      <td class="cell-wide">${c.diagnosis ? esc(c.diagnosis) : dash}</td>
      <td class="cell-docs">${hospitalDocCell(c)}</td>
      <td class="cell-docs">${companies}${policyDocs}${addDocButton(c.id, '증권')}</td>
      <td class="cell-docs">${otherDocs}${addDocButton(c.id, '기타')}</td>
      <td class="cell-num">${formatKRW(c.estimated_amount)}</td>
      <td class="cell-wide">${c.progress ? `<div class="clamp">${esc(c.progress)}</div>` : dash}</td>
      <td class="cell-actions">
        <button class="secondary" data-edit="${c.id}">수정</button>
        <button class="danger" data-delete="${c.id}">삭제</button>
      </td>
    </tr>`;
}

function bindManagementDocActions(root, customers, reload) {
  const byId = new Map(customers.map((c) => [String(c.id), c]));
  const banner = () => document.getElementById('mgmt-banner');

  root.querySelectorAll('[data-add-doc]').forEach((input) => {
    input.addEventListener('change', async () => {
      const customer = byId.get(input.dataset.addDoc);
      const docType = input.dataset.docType;
      const hospital = input.dataset.hospital || '';
      const label = docType === '기타' ? '기타서류' : docType === '병원' ? hospital : '증권';
      const files = [...input.files];
      if (!files.length) return;

      const failed = [];
      for (let i = 0; i < files.length; i++) {
        banner().innerHTML = `<div class="banner success">${esc(customer.name)}님 ${esc(label)} 등록 중... (${i + 1}/${files.length}) ${esc(files[i].name)}</div>`;
        const fd = new FormData();
        fd.append('file', files[i]);
        fd.append('doc_type', docType);
        fd.append('hospital_name', docType === '병원' ? hospital : '');
        try {
          await api(`/api/customers/${customer.id}/documents`, { method: 'POST', body: fd });
        } catch (err) {
          failed.push(`${files[i].name} (${err.message})`);
        }
      }
      banner().innerHTML = failed.length
        ? `<div class="banner error">등록하지 못한 파일: ${esc(failed.join(', '))}</div>`
        : `<div class="banner success">${esc(customer.name)}님 ${esc(label)} ${files.length}개를 등록했습니다.</div>`;
      await reload();
    });
  });

  root.querySelectorAll('[data-add-hospital]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.addHospital;
      state.hospitalSlots[id] = (state.hospitalSlots[id] || 0) + 1;
      await reload();
    });
  });

  root.querySelectorAll('[data-rename-hospital]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const from = btn.dataset.from;
      const to = (prompt('병원 이름을 입력하세요 (예: 서울대병원)', from) || '').trim();
      if (!to || to === from) return;
      try {
        await api(`/api/customers/${btn.dataset.renameHospital}/hospital-name`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to }),
        });
      } catch (err) {
        alert(err.message);
      }
      await reload();
    });
  });

  root.querySelectorAll('[data-del-doc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 서류를 삭제하시겠습니까?')) return;
      await api(`/api/documents/${btn.dataset.delDoc}`, { method: 'DELETE' });
      await reload();
    });
  });

  root.querySelectorAll('[data-quick-move]').forEach((select) => {
    select.addEventListener('change', async () => {
      if (!select.value) return;
      const isHospital = select.value.startsWith('병원:');
      await api(`/api/documents/${select.dataset.quickMove}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doc_type: isHospital ? '병원' : select.value,
          hospital_name: isHospital ? select.value.slice('병원:'.length) : '',
        }),
      });
      await reload();
    });
  });
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
      <h2>서류 등록 (증권 / 병원 / 기타)</h2>
      <p class="muted">파일을 업로드하고 고객이름과 연락처를 입력하면, 연락처(고객 분류번호)가 같은 기존 고객에게 자동으로 연결됩니다.</p>
      <div id="upload-banner"></div>
      <form id="match-upload-form">
        <div class="form-grid">
          <label>파일 종류 *
            <select name="doc_type" required>
              <option value="증권">증권</option>
              <option value="병원">병원</option>
              <option value="기타">기타서류</option>
            </select>
          </label>
          <label>병원명 (병원 서류일 때)
            <input type="text" name="hospital_name" placeholder="예: 서울특별시보라매병원" />
          </label>
          <label class="full">첨부파일 *
            <input type="file" name="file" required />
          </label>
          <label>고객이름 *
            <input type="text" name="name" required />
          </label>
          <label>연락처 *
            <input type="text" name="phone" placeholder="010-000-0000" required />
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

// ---- 고객관리: 이름 조회 + 사건내용 한눈에 보기, 최근 업무일지 ----
async function renderManagementView() {
  app.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input type="text" id="mgmt-search-input" placeholder="이름으로 조회 (연락처로도 찾을 수 있어요)" value="${esc(state.mgmtSearch)}" style="flex:1;min-width:200px;" />
        <button class="primary" id="mgmt-add-btn">+ 고객 추가</button>
      </div>
      <div id="mgmt-count" class="muted" style="margin-bottom:8px;"></div>
      <div id="mgmt-banner"></div>
      <div id="mgmt-body">불러오는 중...</div>
    </div>

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
  `;

  document.getElementById('mgmt-add-btn').addEventListener('click', () => openCustomerForm());

  const searchInput = document.getElementById('mgmt-search-input');
  let debounce;
  searchInput.addEventListener('input', () => {
    state.mgmtSearch = searchInput.value;
    clearTimeout(debounce);
    debounce = setTimeout(loadManagementTable, 300);
  });
  searchInput.focus();
  searchInput.setSelectionRange(state.mgmtSearch.length, state.mgmtSearch.length);

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

  async function loadManagementTable() {
    const body = document.getElementById('mgmt-body');
    const previousScroll = document.querySelector('#mgmt-body .table-scroll');
    const scrollLeft = previousScroll ? previousScroll.scrollLeft : 0;
    const q = state.mgmtSearch.trim();
    const customers = await api(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    document.getElementById('mgmt-count').textContent = `총 ${customers.length}명`;
    body.innerHTML = customers.length
      ? `<div class="table-scroll"><table class="mgmt-table">
          <thead><tr><th>이름</th><th>연락처</th><th>청구내용</th><th>진단명</th><th>병원서류</th><th>증권</th><th>기타서류</th><th>추산금액</th><th>진행사항</th><th>작업</th></tr></thead>
          <tbody>${customers.map(managementRow).join('')}</tbody>
        </table></div>`
      : '<div class="empty-state">조회된 고객이 없습니다.</div>';
    const scroller = body.querySelector('.table-scroll');
    if (scroller) scroller.scrollLeft = scrollLeft;
    bindTableActions(customers);
    bindManagementDocActions(body, customers, loadManagementTable);
  }

  await Promise.all([loadManagementTable(), loadWorkLogs()]);
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
  app.classList.toggle('wide', state.view === 'management');
  if (state.view === 'list') renderListView();
  else if (state.view === 'management') renderManagementView();
  else if (state.view === 'companies') renderCompaniesView();
  else if (state.view === 'upload') renderUploadView();
  else if (state.view === 'inquiries') renderInquiriesView();
  else if (state.view === 'calls') renderCallLogsView();
}

render();
