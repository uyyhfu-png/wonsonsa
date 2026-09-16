const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const { PDFParse } = require('pdf-parse');
const db = require('./db');

const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_EXT.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// 증권/진단서 자동 인식(OCR/PDF 텍스트 추출)용 - 디스크에 남기지 않고 메모리에서만 처리
const extractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_EXT.includes(path.extname(file.originalname).toLowerCase()));
  },
});

function normalizeBirthDate(yyyy, mm, dd) {
  const y = String(yyyy).padStart(4, '0');
  const m = String(mm).padStart(2, '0');
  const d = String(dd).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extractFieldsFromText(text) {
  const fields = {};

  const nameMatch = text.match(/(?:성명|환자명|피보험자|이름)\s*[:：]?\s*([가-힣]{2,5})/);
  if (nameMatch) fields.name = nameMatch[1];

  const phoneMatch = text.match(/(01[0-9])[-.\s]?(\d{3,4})[-.\s]?(\d{4})/);
  if (phoneMatch) fields.phone = `${phoneMatch[1]}-${phoneMatch[2]}-${phoneMatch[3]}`;

  const birthLabelMatch = text.match(/생년월일\s*[:：]?\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  const rrnMatch = text.match(/(\d{2})(\d{2})(\d{2})[-\s]?([1-4])\d{6}/);
  const genericDateMatch = text.match(/\b(19|20)(\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/);
  if (birthLabelMatch) {
    fields.birth_date = normalizeBirthDate(birthLabelMatch[1], birthLabelMatch[2], birthLabelMatch[3]);
  } else if (rrnMatch) {
    const genderDigit = Number(rrnMatch[4]);
    const century = genderDigit <= 2 ? 1900 : genderDigit <= 4 ? 2000 : genderDigit <= 6 ? 1900 : 2000;
    fields.birth_date = normalizeBirthDate(century + Number(rrnMatch[1]), rrnMatch[2], rrnMatch[3]);
  } else if (genericDateMatch) {
    fields.birth_date = normalizeBirthDate(
      `${genericDateMatch[1]}${genericDateMatch[2]}`,
      genericDateMatch[3],
      genericDateMatch[4]
    );
  }

  const addressMatch = text.match(/주소\s*[:：]?\s*(.+)/);
  if (addressMatch) fields.address = addressMatch[1].trim();

  const diagnosisMatch = text.match(/(?:진단명|병명)\s*[:：]?\s*(.+)/);
  if (diagnosisMatch) fields.diagnosis = diagnosisMatch[1].trim();

  return fields;
}

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
  let rows = db.prepare('SELECT * FROM customers ORDER BY updated_at DESC').all();

  if (insurance_company_id) {
    const ids = new Set(
      db
        .prepare('SELECT customer_id FROM customer_insurance WHERE insurance_company_id = ?')
        .all(insurance_company_id)
        .map((r) => r.customer_id)
    );
    rows = rows.filter((c) => ids.has(c.id));
  }

  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((c) =>
      [c.name, c.phone, c.address, c.diagnosis, c.birth_date, c.referrer, c.progress]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    );
  }

  const withCompanies = rows.map((c) => ({
    ...c,
    insurance_companies: db
      .prepare(
        `SELECT ic.id, ic.name FROM insurance_companies ic
         JOIN customer_insurance ci ON ci.insurance_company_id = ic.id
         WHERE ci.customer_id = ?`
      )
      .all(c.id),
  }));

  if (q) {
    const needle = q.toLowerCase();
    res.json(
      withCompanies.filter(
        (c) =>
          c.insurance_companies.some((ic) => ic.name.toLowerCase().includes(needle)) ||
          [c.name, c.phone, c.address, c.diagnosis, c.birth_date, c.referrer, c.progress]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(needle))
      )
    );
  } else {
    res.json(withCompanies);
  }
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
  if (!name || !address || !phone || !birth_date) {
    return res.status(400).json({ error: '고객이름, 주소, 연락처, 생년월일은 필수입니다.' });
  }
  const info = db
    .prepare(
      `INSERT INTO customers
        (name, referrer, address, phone, birth_date, diagnosis, estimated_amount, progress,
         case_type, retained, receipt_number, success_fee_rate, status, manager, case_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name, referrer || null, address, phone, birth_date, diagnosis || null, estimated_amount || null, progress || null,
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
  if (!name || !address || !phone || !birth_date) {
    return res.status(400).json({ error: '고객이름, 주소, 연락처, 생년월일은 필수입니다.' });
  }
  db.prepare(
    `UPDATE customers SET name = ?, referrer = ?, address = ?, phone = ?, birth_date = ?, diagnosis = ?, estimated_amount = ?, progress = ?,
       case_type = ?, retained = ?, receipt_number = ?, success_fee_rate = ?, status = ?, manager = ?, case_title = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    name, referrer || null, address, phone, birth_date, diagnosis || null, estimated_amount || null, progress || null,
    case_type || null, retained || '수임', receipt_number || null, success_fee_rate || null, status || '진행', manager || null, case_title || null,
    req.params.id
  );
  setCustomerInsurance(req.params.id, insurance_companies);
  res.json(getCustomerFull(req.params.id));
});

app.put('/api/customers/:id/progress', (req, res) => {
  const existing = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '고객을 찾을 수 없습니다.' });
  const { progress } = req.body;
  db.prepare(`UPDATE customers SET progress = ?, updated_at = datetime('now') WHERE id = ?`).run(
    progress || null,
    req.params.id
  );
  res.json(getCustomerFull(req.params.id));
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

// ---- Documents (증권/진단서) ----
app.post('/api/customers/:id/documents', upload.single('file'), (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    return res.status(404).json({ error: '고객을 찾을 수 없습니다.' });
  }
  if (!req.file) return res.status(400).json({ error: '파일이 필요합니다 (PDF, JPG, PNG).' });
  const { doc_type } = req.body;
  if (!['증권', '진단서'].includes(doc_type)) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).json({ error: '파일 종류는 증권 또는 진단서여야 합니다.' });
  }
  const info = db
    .prepare(
      'INSERT INTO customer_documents (customer_id, doc_type, file_name, stored_name) VALUES (?, ?, ?, ?)'
    )
    .run(req.params.id, doc_type, req.file.originalname, req.file.filename);
  res.status(201).json(db.prepare('SELECT * FROM customer_documents WHERE id = ?').get(info.lastInsertRowid));
});

// 증권/진단서 파일에서 텍스트를 추출해 고객 정보 항목을 자동으로 추정
app.post('/api/documents/extract', extractUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 필요합니다 (PDF, JPG, PNG).' });

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    let text = '';

    if (ext === '.pdf') {
      const parser = new PDFParse({ data: req.file.buffer });
      const result = await parser.getText();
      await parser.destroy();
      text = result.text || '';
    } else {
      const { data } = await Tesseract.recognize(req.file.buffer, 'kor+eng');
      text = data.text || '';
    }

    const fields = extractFieldsFromText(text);
    res.json({ text, fields });
  } catch (err) {
    res.status(500).json({ error: '파일에서 정보를 추출하는 중 오류가 발생했습니다: ' + err.message });
  }
});

// 파일 업로드 + 이름/전화번호/주소/생년월일로 기존 고객 매칭
app.post('/api/documents/match', upload.single('file'), (req, res) => {
  const { name, phone, address, birth_date, doc_type } = req.body;
  if (!req.file) return res.status(400).json({ error: '파일이 필요합니다 (PDF, JPG, PNG).' });
  if (!['증권', '진단서'].includes(doc_type)) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).json({ error: '파일 종류는 증권 또는 진단서여야 합니다.' });
  }
  if (!name || !phone || !address || !birth_date) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).json({ error: '고객이름, 전화번호, 주소, 생년월일을 모두 입력해주세요.' });
  }

  const match = db
    .prepare(
      `SELECT * FROM customers WHERE name = ? AND phone = ? AND address = ? AND birth_date = ?`
    )
    .get(name, phone, address, birth_date);

  if (!match) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(404).json({
      error: '일치하는 고객이 없습니다. 먼저 고객을 등록해주세요.',
      matched: false,
    });
  }

  const info = db
    .prepare(
      'INSERT INTO customer_documents (customer_id, doc_type, file_name, stored_name) VALUES (?, ?, ?, ?)'
    )
    .run(match.id, doc_type, req.file.originalname, req.file.filename);

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
      `SELECT name, progress, created_at, updated_at FROM customers
       WHERE name = ? AND substr(replace(replace(phone, '-', ''), ' ', ''), -4) = ?`
    )
    .get(name, phone_last4);

  if (!match) {
    return res.status(404).json({ found: false, error: '일치하는 사건을 찾을 수 없습니다. 상담센터로 문의해주세요.' });
  }
  res.json({
    found: true,
    name: match.name,
    progress: match.progress,
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

const PORT = process.env.PORT || 4300;
app.listen(PORT, () => {
  console.log(`고객관리프로그램 서버 실행 중: http://localhost:${PORT}`);
});
