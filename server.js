const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const { PDFParse } = require('pdf-parse');
const db = require('./db');

const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const OCR_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];
const UPLOAD_EXT = [
  ...OCR_EXT, '.gif', '.bmp', '.tif', '.tiff', '.hwp', '.hwpx',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.zip',
];
const DOC_TYPES = ['증권', '병원', '기타'];

function normalizeDocType(type) {
  if (type === '진단서') return '병원';
  return DOC_TYPES.includes(type) ? type : null;
}

function normalizeHospitalName(docType, name) {
  return docType === '병원' ? String(name || '').trim() || null : null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, UPLOAD_EXT.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// 진단서 자동 인식(OCR/PDF 텍스트 추출)용 - 디스크에 남기지 않고 메모리에서만 처리
const extractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, OCR_EXT.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// OCR 워커 풀: CPU 여유만큼(최대 3개) 워커를 만들어 재사용하고, 초과 요청은 대기열에서 순서대로 처리
const OCR_POOL_SIZE = Math.max(1, Math.min(3, os.cpus().length - 1));
const idleOcrWorkers = [];
const ocrWaiters = [];
let ocrWorkersCreated = 0;

async function acquireOcrWorker() {
  if (idleOcrWorkers.length) return idleOcrWorkers.pop();
  if (ocrWorkersCreated < OCR_POOL_SIZE) {
    ocrWorkersCreated++;
    try {
      return await Tesseract.createWorker('kor+eng');
    } catch (err) {
      ocrWorkersCreated--;
      throw err;
    }
  }
  return new Promise((resolve) => ocrWaiters.push(resolve));
}

function releaseOcrWorker(worker) {
  const next = ocrWaiters.shift();
  if (next) next(worker);
  else idleOcrWorkers.push(worker);
}

async function ocrImage(buffer) {
  const worker = await acquireOcrWorker();
  try {
    const { data } = await worker.recognize(buffer);
    return data.text || '';
  } finally {
    releaseOcrWorker(worker);
  }
}

// PDF는 텍스트 레이어를 먼저 읽고, 스캔본이면 첫 페이지를 이미지로 변환해 OCR
async function extractText(buffer, ext) {
  if (ext !== '.pdf') return ocrImage(buffer);

  const parser = new PDFParse({ data: buffer });
  try {
    let text = (await parser.getText({ partial: [1] })).text || '';
    if (text.replace(/\s|-- \d+ of \d+ --/g, '').length < 30) {
      const shot = await parser.getScreenshot({ scale: 2, partial: [1] });
      text = await ocrImage(Buffer.from(shot.pages[0].data));
    }
    return text;
  } finally {
    await parser.destroy();
  }
}

// multer는 파일명을 latin1로 해석하므로 한글 파일명을 UTF-8로 복원
function decodeUploadName(name) {
  if ([...name].some((ch) => ch.charCodeAt(0) > 255)) return name;
  return Buffer.from(name, 'latin1').toString('utf8');
}

const { extractFieldsFromText, findInsurers } = require('./extraction');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getCustomerFull(id) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return null;
  customer.insurance_companies = db
    .prepare(
      `SELECT ic.id, ic.name FROM insurance_companies ic
       JOIN customer_insurance ci ON ci.insurance_company_id = ic.id
       WHERE ci.customer_id = ?`
    )
    .all(id);
  customer.documents = db
    .prepare('SELECT * FROM customer_documents WHERE customer_id = ? ORDER BY uploaded_at DESC')
    .all(id);
  customer.progress_logs = db
    .prepare('SELECT * FROM progress_logs WHERE customer_id = ? ORDER BY log_date DESC, id DESC')
    .all(id);
  customer.call_logs = db
    .prepare('SELECT * FROM call_logs WHERE phone = ? ORDER BY call_date DESC, id DESC')
    .all(customer.phone);
  return customer;
}

function setCustomerInsurance(customerId, companyNames) {
  db.prepare('DELETE FROM customer_insurance WHERE customer_id = ?').run(customerId);
  const findOrCreate = db.prepare('SELECT id FROM insurance_companies WHERE name = ?');
  const insertCompany = db.prepare('INSERT INTO insurance_companies (name) VALUES (?)');
  const link = db.prepare(
    'INSERT OR IGNORE INTO customer_insurance (customer_id, insurance_company_id) VALUES (?, ?)'
  );
  for (const raw of companyNames || []) {
    const name = String(raw).trim();
    if (!name) continue;
    let row = findOrCreate.get(name);
    if (!row) {
      const info = insertCompany.run(name);
      row = { id: info.lastInsertRowid };
    }
    link.run(customerId, row.id);
  }
}

// ---- Insurance companies ----
app.get('/api/insurance-companies', (req, res) => {
  res.json(db.prepare('SELECT * FROM insurance_companies ORDER BY name').all());
});

// ---- Customers ----
app.get('/api/customers', (req, res) => {
  const { q, insurance_company_id } = req.query;
  let rows = db.prepare('SELECT * FROM customers ORDER BY updated_at DESC, id ASC').all();

  if (insurance_company_id) {
    const ids = new Set(
      db
        .prepare('SELECT customer_id FROM customer_insurance WHERE insurance_company_id = ?')
        .all(insurance_company_id)
        .map((r) => r.customer_id)
    );
    rows = rows.filter((c) => ids.has(c.id));
  }

  const companiesStmt = db.prepare(
    `SELECT ic.id, ic.name FROM insurance_companies ic
     JOIN customer_insurance ci ON ci.insurance_company_id = ic.id
     WHERE ci.customer_id = ?`
  );
  const documentsStmt = db.prepare(
    'SELECT id, doc_type, hospital_name, file_name FROM customer_documents WHERE customer_id = ? ORDER BY id'
  );
  const progressLogsStmt = db.prepare(
    'SELECT id, log_date, content FROM progress_logs WHERE customer_id = ? ORDER BY log_date DESC, id DESC'
  );
  const latestCallStmt = db.prepare(
    'SELECT call_date, content FROM call_logs WHERE phone = ? ORDER BY call_date DESC, id DESC LIMIT 1'
  );

  let result = rows.map((c) => ({
    ...c,
    insurance_companies: companiesStmt.all(c.id),
    documents: documentsStmt.all(c.id),
    latest_call: latestCallStmt.get(c.phone) || null,
    progress_logs: progressLogsStmt.all(c.id),
  }));

  if (q) {
    const needle = q.toLowerCase();
    const needleDigits = needle.replace(/\D/g, '');
    result = result.filter(
      (c) =>
        c.insurance_companies.some((ic) => ic.name.toLowerCase().includes(needle)) ||
        [c.name, c.phone, c.address, c.diagnosis, c.birth_date, c.referrer, c.case_title, c.case_type]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)) ||
        c.progress_logs.some((l) => l.content.toLowerCase().includes(needle)) ||
        (needleDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(needleDigits))
    );
  }

  res.json(result);
});

app.get('/api/customers/:id', (req, res) => {
  const customer = getCustomerFull(req.params.id);
  if (!customer) return res.status(404).json({ error: '고객을 찾을 수 없습니다.' });
  res.json(customer);
});

app.post('/api/customers', (req, res) => {
  const {
    name, referrer, address, phone, birth_date, diagnosis, estimated_amount, progress,
    case_type, retained, receipt_number, success_fee_rate, status, manager, case_title,
    insurance_companies,
  } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: '고객이름과 연락처는 필수입니다.' });
  }
  const info = db
    .prepare(
      `INSERT INTO customers
        (name, referrer, address, phone, birth_date, diagnosis, estimated_amount, progress,
         case_type, retained, receipt_number, success_fee_rate, status, manager, case_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name, referrer || null, address || '', phone, birth_date || '', diagnosis || null, estimated_amount || null, progress || null,
      case_type || null, retained || '수임', receipt_number || null, success_fee_rate || null, status || '진행', manager || null, case_title || null
    );
  setCustomerInsurance(info.lastInsertRowid, insurance_companies);
  res.status(201).json(getCustomerFull(info.lastInsertRowid));
});

app.put('/api/customers/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '고객을 찾을 수 없습니다.' });

  const {
    name, referrer, address, phone, birth_date, diagnosis, estimated_amount, progress,
    case_type, retained, receipt_number, success_fee_rate, status, manager, case_title,
    insurance_companies,
  } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: '고객이름과 연락처는 필수입니다.' });
  }
  db.prepare(
    `UPDATE customers SET name = ?, referrer = ?, address = ?, phone = ?, birth_date = ?, diagnosis = ?, estimated_amount = ?, progress = ?,
       case_type = ?, retained = ?, receipt_number = ?, success_fee_rate = ?, status = ?, manager = ?, case_title = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    name, referrer || null, address || '', phone, birth_date || '', diagnosis || null, estimated_amount || null, progress || null,
    case_type || null, retained || '수임', receipt_number || null, success_fee_rate || null, status || '진행', manager || null, case_title || null,
    req.params.id
  );
  setCustomerInsurance(req.params.id, insurance_companies);
  res.json(getCustomerFull(req.params.id));
});

// ---- 진행사항 (날짜별) ----
const LOG_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.post('/api/customers/:id/progress-logs', (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: '고객을 찾을 수 없습니다.' });
  const logDate = String(req.body.log_date || '').trim();
  const content = String(req.body.content || '').trim();
  if (!LOG_DATE_RE.test(logDate) || !content) {
    return res.status(400).json({ error: '날짜와 진행사항 내용을 입력해주세요.' });
  }
  const info = db
    .prepare('INSERT INTO progress_logs (customer_id, log_date, content) VALUES (?, ?, ?)')
    .run(req.params.id, logDate, content);
  db.prepare("UPDATE customers SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.status(201).json(db.prepare('SELECT * FROM progress_logs WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/progress-logs/:id', (req, res) => {
  const log = db.prepare('SELECT * FROM progress_logs WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).json({ error: '진행사항을 찾을 수 없습니다.' });
  const logDate = String(req.body.log_date || log.log_date).trim();
  const content = String(req.body.content ?? log.content).trim();
  if (!LOG_DATE_RE.test(logDate) || !content) {
    return res.status(400).json({ error: '날짜와 진행사항 내용을 입력해주세요.' });
  }
  db.prepare('UPDATE progress_logs SET log_date = ?, content = ? WHERE id = ?').run(logDate, content, req.params.id);
  db.prepare("UPDATE customers SET updated_at = datetime('now') WHERE id = ?").run(log.customer_id);
  res.json(db.prepare('SELECT * FROM progress_logs WHERE id = ?').get(req.params.id));
});

app.delete('/api/progress-logs/:id', (req, res) => {
  const log = db.prepare('SELECT id FROM progress_logs WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).end();
  db.prepare('DELETE FROM progress_logs WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.delete('/api/customers/:id', (req, res) => {
  const docs = db
    .prepare('SELECT stored_name FROM customer_documents WHERE customer_id = ?')
    .all(req.params.id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  for (const doc of docs) {
    fs.rm(path.join(UPLOAD_DIR, doc.stored_name), { force: true }, () => {});
  }
  res.status(204).end();
});

// ---- Documents (증권 / 병원(병원별) / 기타) ----
app.post('/api/customers/:id/documents', upload.single('file'), (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    return res.status(404).json({ error: '고객을 찾을 수 없습니다.' });
  }
  if (!req.file) return res.status(400).json({ error: '지원하지 않는 파일 형식이거나 파일이 없습니다.' });
  const docType = normalizeDocType(req.body.doc_type);
  if (!docType) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).json({ error: '파일 종류는 증권, 병원, 기타 중 하나여야 합니다.' });
  }
  const info = db
    .prepare(
      'INSERT INTO customer_documents (customer_id, doc_type, hospital_name, file_name, stored_name) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      req.params.id,
      docType,
      normalizeHospitalName(docType, req.body.hospital_name),
      decodeUploadName(req.file.originalname),
      req.file.filename
    );
  res.status(201).json(db.prepare('SELECT * FROM customer_documents WHERE id = ?').get(info.lastInsertRowid));
});

// 병원 이름 바꾸기 (예: 제1병원 -> 서울대병원): 해당 고객의 같은 병원 서류를 한꺼번에 변경
app.put('/api/customers/:id/hospital-name', (req, res) => {
  const from = String(req.body.from || '').trim();
  const to = String(req.body.to || '').trim();
  if (!to) return res.status(400).json({ error: '병원 이름을 입력해주세요.' });
  db.prepare(
    "UPDATE customer_documents SET hospital_name = ? WHERE customer_id = ? AND doc_type = '병원' AND IFNULL(hospital_name, '') = ?"
  ).run(to, req.params.id, from);
  res.json({ ok: true });
});

// 서류 분류 변경 (예: 기타서류 -> 증권 또는 병원)
app.put('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT id FROM customer_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: '서류를 찾을 수 없습니다.' });
  const docType = normalizeDocType(req.body.doc_type);
  if (!docType) return res.status(400).json({ error: '파일 종류는 증권, 병원, 기타 중 하나여야 합니다.' });
  db.prepare('UPDATE customer_documents SET doc_type = ?, hospital_name = ? WHERE id = ?').run(
    docType,
    normalizeHospitalName(docType, req.body.hospital_name),
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM customer_documents WHERE id = ?').get(req.params.id));
});

// 진단서 파일에서 텍스트를 추출해 고객 정보 항목을 자동으로 추정
app.post('/api/documents/extract', extractUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 필요합니다 (PDF, JPG, PNG).' });

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (req.query.kind === 'policy') {
      // 증권: 파일명에 보험회사가 있으면 OCR 없이 바로 확인, 없으면 본문에서 찾기
      let insurers = findInsurers(decodeUploadName(req.file.originalname));
      if (!insurers.length) insurers = findInsurers(await extractText(req.file.buffer, ext));
      return res.json({ fields: { insurers } });
    }

    const text = await extractText(req.file.buffer, ext);
    const fields = extractFieldsFromText(text);
    res.json({ text, fields });
  } catch (err) {
    res.status(500).json({ error: '파일에서 정보를 추출하는 중 오류가 발생했습니다: ' + err.message });
  }
});

// 파일 업로드 + 이름/전화번호/주소/생년월일로 기존 고객 매칭
app.post('/api/documents/match', upload.single('file'), (req, res) => {
  const { name, phone } = req.body;
  if (!req.file) return res.status(400).json({ error: '지원하지 않는 파일 형식이거나 파일이 없습니다.' });
  const docType = normalizeDocType(req.body.doc_type);
  if (!docType) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).json({ error: '파일 종류는 증권, 병원, 기타 중 하나여야 합니다.' });
  }
  if (!name || !phone) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).json({ error: '고객이름과 연락처를 입력해주세요.' });
  }

  const match = db
    .prepare(
      `SELECT * FROM customers WHERE name = ? AND phone = ?`
    )
    .get(name, phone);

  if (!match) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(404).json({
      error: '일치하는 고객이 없습니다. 먼저 고객을 등록해주세요.',
      matched: false,
    });
  }

  const info = db
    .prepare(
      'INSERT INTO customer_documents (customer_id, doc_type, hospital_name, file_name, stored_name) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      match.id,
      docType,
      normalizeHospitalName(docType, req.body.hospital_name),
      decodeUploadName(req.file.originalname),
      req.file.filename
    );

  res.status(201).json({
    matched: true,
    customer: match,
    document: db.prepare('SELECT * FROM customer_documents WHERE id = ?').get(info.lastInsertRowid),
  });
});

app.get('/api/documents/:id/file', (req, res) => {
  const doc = db.prepare('SELECT * FROM customer_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).end();
  res.download(path.join(UPLOAD_DIR, doc.stored_name), doc.file_name);
});

app.delete('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM customer_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).end();
  db.prepare('DELETE FROM customer_documents WHERE id = ?').run(req.params.id);
  fs.rm(path.join(UPLOAD_DIR, doc.stored_name), { force: true }, () => {});
  res.status(204).end();
});

// ---- 홈페이지 내사건조회 (이름/연락처 뒤 4자리 일치 시 진행상황만 공개) ----
app.post('/api/case-lookup', (req, res) => {
  const { name, phone_last4 } = req.body;
  if (!name || !phone_last4 || !/^\d{4}$/.test(phone_last4)) {
    return res.status(400).json({ error: '이름과 연락처 뒤 4자리를 정확히 입력해주세요.' });
  }
  const match = db
    .prepare(
      `SELECT id, name, created_at, updated_at FROM customers
       WHERE name = ? AND substr(replace(replace(phone, '-', ''), ' ', ''), -4) = ?`
    )
    .get(name, phone_last4);

  if (!match) {
    return res.status(404).json({ found: false, error: '일치하는 사건을 찾을 수 없습니다. 상담센터로 문의해주세요.' });
  }
  const logs = db
    .prepare('SELECT log_date, content FROM progress_logs WHERE customer_id = ? ORDER BY log_date DESC, id DESC LIMIT 5')
    .all(match.id);
  res.json({
    found: true,
    name: match.name,
    progress: logs.length ? logs[0].content : null,
    progress_logs: logs,
    created_at: match.created_at,
    updated_at: match.updated_at,
  });
});

// ---- 홈페이지 상담문의 ----
app.get('/api/inquiries', (req, res) => {
  res.json(db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC').all());
});

app.post('/api/inquiries', (req, res) => {
  const { name, phone, message } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: '이름과 연락처는 필수입니다.' });
  }
  const info = db
    .prepare('INSERT INTO inquiries (name, phone, message) VALUES (?, ?, ?)')
    .run(name, phone, message || null);
  res.status(201).json(db.prepare('SELECT * FROM inquiries WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/inquiries/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM inquiries WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).end();
  db.prepare('DELETE FROM inquiries WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---- 최근 업무일지 ----
app.get('/api/work-logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  res.json(db.prepare('SELECT * FROM work_logs ORDER BY created_at DESC LIMIT ?').all(limit));
});

app.post('/api/work-logs', (req, res) => {
  const { log_type, related_name, manager, content } = req.body;
  if (!log_type || !content) {
    return res.status(400).json({ error: '업무유형과 내용은 필수입니다.' });
  }
  const info = db
    .prepare('INSERT INTO work_logs (log_type, related_name, manager, content) VALUES (?, ?, ?, ?)')
    .run(log_type, related_name || null, manager || null, content);
  res.status(201).json(db.prepare('SELECT * FROM work_logs WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/work-logs/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM work_logs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).end();
  db.prepare('DELETE FROM work_logs WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---- 통화내역 (전화번호를 고객 분류번호로 사용) ----
app.get('/api/call-logs', (req, res) => {
  const { phone } = req.query;
  const rows = phone
    ? db.prepare('SELECT * FROM call_logs WHERE phone = ? ORDER BY call_date DESC, id DESC').all(phone)
    : db.prepare('SELECT * FROM call_logs ORDER BY call_date DESC, id DESC').all();
  res.json(rows);
});

app.post('/api/call-logs', (req, res) => {
  const { phone, name, call_date, content } = req.body;
  if (!phone || !call_date || !content) {
    return res.status(400).json({ error: '전화번호, 통화일자, 업무내용은 필수입니다.' });
  }
  const info = db
    .prepare('INSERT INTO call_logs (phone, name, call_date, content) VALUES (?, ?, ?, ?)')
    .run(phone, name || null, call_date, content);
  res.status(201).json(db.prepare('SELECT * FROM call_logs WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/call-logs/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM call_logs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).end();
  db.prepare('DELETE FROM call_logs WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

const PORT = process.env.PORT || 4300;
app.listen(PORT, () => {
  console.log(`고객관리프로그램 서버 실행 중: http://localhost:${PORT}`);
});
