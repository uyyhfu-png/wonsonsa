const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'customers.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  referrer TEXT,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  diagnosis TEXT,
  estimated_amount INTEGER,
  progress TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS insurance_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS customer_insurance (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  insurance_company_id INTEGER NOT NULL REFERENCES insurance_companies(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, insurance_company_id)
);

CREATE TABLE IF NOT EXISTS customer_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('증권', '진단서')),
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_type TEXT NOT NULL,
  related_name TEXT,
  manager TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  name TEXT,
  call_date TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_call_logs_phone ON call_logs(phone);
`);

// 기존 DB에 고객관리(사건) 컬럼이 없으면 추가
const existingColumns = new Set(db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name));
const newCustomerColumns = {
  case_type: 'TEXT',
  retained: "TEXT DEFAULT '수임'",
  receipt_number: 'TEXT',
  success_fee_rate: 'REAL',
  status: "TEXT DEFAULT '진행'",
  manager: 'TEXT',
  case_title: 'TEXT',
};
for (const [column, type] of Object.entries(newCustomerColumns)) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE customers ADD COLUMN ${column} ${type}`);
  }
}

module.exports = db;
