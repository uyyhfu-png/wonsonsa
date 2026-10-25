// 서류 텍스트(OCR/PDF 텍스트)에서 고객 정보·보험회사·서류 종류를 추정하는 함수 모음

const INSURERS = [
  '삼성생명', '교보생명', '한화생명', '신한라이프', '흥국생명', 'DB생명', '동양생명', 'AIA생명', '메트라이프',
  '푸본현대생명', 'KB라이프', 'NH농협생명', '처브라이프', '라이나생명', 'ABL생명', 'IBK연금보험', 'KDB생명',
  '삼성화재', '현대해상', 'DB손해보험', 'KB손해보험', '메리츠화재', '한화손해보험', '롯데손해보험', '흥국화재',
  'NH농협손해보험', '하나손해보험', 'AXA손해보험', '캐롯손해보험', 'MG손해보험', '서울보증보험', '우체국보험',
];

// 줄임말·영문 표기 (OCR은 한글보다 영문 로고를 더 잘 읽는 경우가 많음)
const INSURER_ALIASES = [
  [/AIA/i, 'AIA생명'],
  [/동부화재|동부생명|DB\s*손보|디비손보/, 'DB손해보험'],
  [/KB\s*손보/, 'KB손해보험'],
  [/농협\s*손보|NH\s*손보|농협\s*손해/, 'NH농협손해보험'],
  [/농협\s*생명/, 'NH농협생명'],
  [/현대\s*해상/, '현대해상'],
  [/삼성\s*화재/, '삼성화재'],
  [/흥국\s*화재/, '흥국화재'],
  [/우체국/, '우체국보험'],
];

function findInsurers(text) {
  const compact = text.replace(/\s/g, '');
  const found = INSURERS.filter((name) => compact.includes(name));
  for (const [pattern, name] of INSURER_ALIASES) {
    if (pattern.test(text) && !found.includes(name)) found.push(name);
  }
  return found;
}

// 질병분류기호로 사고종류를 대략 추정 (확인 후 수정 가능)
function suggestCaseType(icdCode) {
  if (!icdCode) return null;
  const letter = icdCode[0];
  const num = Number(icdCode.slice(1, 3));
  if (letter === 'C') return '암진단';
  if (letter === 'D' && (num <= 9 || (num >= 37 && num <= 48))) return '유사암';
  if (letter === 'I' && num >= 20 && num <= 25) return '허혈성심장질환';
  if (letter === 'I' && num >= 60 && num <= 69) return '뇌혈관질환';
  if (letter === 'S' || letter === 'T') return '상해';
  return null;
}

// 서류 종류 추정: 본문에 병원/증권 단서가 충분할 때만 판단
function guessDocumentKind(text) {
  if (/보험\s*증권|증권\s*번호/.test(text)) return 'policy';
  const hospitalWords = ['진단서', '소견서', '진료', '경과기록', '외래', '입원', '퇴원', '처방', '환자', '병록번호', '의료기관'];
  const hits = hospitalWords.filter((word) => text.includes(word));
  return hits.length >= 2 ? 'hospital' : null;
}

function normalizeBirthDate(yyyy, mm, dd) {
  return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function isValidDate(y, m, d) {
  const year = Number(y);
  return year >= 1900 && year <= new Date().getFullYear() && Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31;
}

function extractBirthDate(text) {
  const labeled = text.match(/생년월일\s*[:：]?\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (labeled && isValidDate(labeled[1], labeled[2], labeled[3])) {
    return normalizeBirthDate(labeled[1], labeled[2], labeled[3]);
  }
  for (const m of text.matchAll(/(\d{2})(\d{2})(\d{2})[-\s]?([1-4])\d{6}/g)) {
    const gender = Number(m[4]);
    const century = gender <= 2 ? 1900 : 2000;
    if (isValidDate(century + Number(m[1]), m[2], m[3])) {
      return normalizeBirthDate(century + Number(m[1]), m[2], m[3]);
    }
  }
  return null;
}

// ---- 진단명 / 질병분류기호 ----
// OCR은 'I'를 '1'이나 'l'로, 소수점은 빼고 읽는 경우가 많아 보정 (질병분류코드는 숫자로 시작하지 않음)
const CODE_TOKEN = '[A-TV-Zl1]\\d{2}(?:\\.\\d{1,2}|\\d)?';
const ANCHOR_RE = /진단명|병\s*명|한국\s*질병\s*분류|질병\s*분류|분류\s*번호/;
const LABEL_RE = /진단명|병\s*명|분류\s*(?:번호|기호)|한국질병|임상적|최종\s*진단|추정|주\s*소|성\s*명|주민|등록번호|의사|면허|의료기관|발\s*행|용도|비고|소견|치료|향후|전화|상기|위와|국제|번호/;

function normalizeIcd(raw) {
  let code = raw.replace(/^[l1]/, 'I');
  if (/^[A-Z]\d{3}$/.test(code)) code = `${code.slice(0, 3)}.${code.slice(3)}`;
  return code;
}

function cleanDiagnosisName(text) {
  return text
    .replace(/^[\s|[\]·\-]+/, '')
    .replace(/^\(?[가-힣A-Za-z]{1,2}\)\s*/, '')
    .replace(/[\s|]+$/, '')
    .trim();
}

function isNameLike(name) {
  const hangul = (name.match(/[가-힣]/g) || []).length;
  const english = /^[A-Za-z][A-Za-z ,'()-]{9,70}$/.test(name);
  return (hangul >= 3 && name.length <= 45) || english;
}

function extractDiagnoses(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const codeAtEnd = new RegExp(`^(.*?)[\\s|]*(${CODE_TOKEN})\\s*$`);
  const results = [];

  for (let i = 0; i < lines.length && results.length < 3; i++) {
    if (!ANCHOR_RE.test(lines[i])) continue;
    const remainder = lines[i].replace(/^.*?(?:진단명|병\s*명|한국\s*질병\s*분류\s*번호|분류\s*번호)\s*[:：|]?/, '');
    const found = [];
    for (const line of [remainder, ...lines.slice(i + 1, i + 6)]) {
      if (!line || LABEL_RE.test(line)) continue;
      const withCode = line.match(codeAtEnd);
      if (withCode) {
        const name = cleanDiagnosisName(withCode[1]);
        if (isNameLike(name)) found.push({ name, code: normalizeIcd(withCode[2]) });
      } else if (!found.length && isNameLike(cleanDiagnosisName(line))) {
        found.push({ name: cleanDiagnosisName(line), code: '' });
      } else if (found.length) {
        break;
      }
    }
    for (const item of found) if (results.length < 3 && !results.some((r) => r.name === item.name)) results.push(item);
  }

  // 병명이 라벨 앞쪽 줄(영문 진단명 등)에 있는 서식
  if (!results.length) {
    for (let i = 0; i < lines.length; i++) {
      if (!ANCHOR_RE.test(lines[i])) continue;
      for (const line of lines.slice(Math.max(0, i - 2), i)) {
        if (!LABEL_RE.test(line) && /^[A-Za-z][A-Za-z ,'()-]{9,70}$/.test(line)) {
          results.push({ name: line, code: '' });
          break;
        }
      }
      if (results.length) break;
    }
  }

  // 코드가 비어 있으면 라벨 근처의 코드를 사용
  if (results.length && !results[0].code) {
    const labeled = text.match(new RegExp(`(?:[질실]\\s*병\\s*분류\\s*(?:기호|번호)|분류\\s*(?:기호|번호)|국제\\s*질병)[^\\n]{0,30}?\\b(${CODE_TOKEN})\\b`));
    if (labeled) results[0].code = normalizeIcd(labeled[1]);
  }
  return results;
}

// ---- 주소 / 병원 ----
const ADDRESS_RE = /(?:[가-힣]{2,}도\s*[가-힣]+시|[가-힣]{2,}(?:특별시|광역시|시|도)?\s*[가-힣]*(?:구|군))\s+[가-힣0-9#]+(?:로|길|동|읍|면)\S*(?:\s+\d[\d-]*)?/;

function cleanAddress(text) {
  return text
    .replace(/\s+전화.*$/, '')
    .replace(/\(?[A-Z]{2,4}\)?\s*/g, '')
    .replace(/\s*[|[\]].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAddress(text) {
  const labeled = text.match(/환자의?\s*주\s*소\s*[:：|]?\s*(.+)/);
  if (labeled) {
    const address = cleanAddress(labeled[1]);
    if (ADDRESS_RE.test(address)) return address;
  }
  // 라벨이 깨진 경우: 의료기관(병원) 정보가 나오기 전의 첫 주소 형태 줄을 환자 주소로 간주
  const lines = text.split('\n');
  const stop = lines.findIndex((line) => /의료기\s*관|발\s*행\s*일/.test(line));
  for (const line of lines.slice(0, stop > 0 ? stop : lines.length)) {
    const m = line.match(ADDRESS_RE);
    if (m) return cleanAddress(m[0]);
  }
  return null;
}

function extractHospital(text) {
  const m = text.match(/의료기\s*관\s*(?:명칭|명)?\s*[:：]?\s*(\S.*?(?:병원|의원|내과|외과|클리닉|센터|치과|한의원))/);
  return m ? m[1].replace(/\s+/g, '') : null;
}

function extractFieldsFromText(text) {
  const fields = {};

  const nameMatch = text.match(/(?:성\s*명|환자명|피보험자|이름)\s*[:：]?\s*([가-힣]{2,5})/);
  if (nameMatch) fields.name = nameMatch[1];

  const phoneMatch = text.match(/(01[0-9])[-.\s]?(\d{3,4})[-.\s]?(\d{4})/);
  if (phoneMatch) fields.phone = `${phoneMatch[1]}-${phoneMatch[2]}-${phoneMatch[3]}`;

  const birthDate = extractBirthDate(text);
  if (birthDate) fields.birth_date = birthDate;

  const address = extractAddress(text);
  if (address) fields.address = address;

  const hospital = extractHospital(text);
  if (hospital) fields.hospital = hospital;

  const diagnoses = extractDiagnoses(text);
  if (diagnoses.length) {
    fields.diagnosis = diagnoses.map((d) => (d.code ? `${d.name}(${d.code})` : d.name)).join(', ');
    const firstCode = diagnoses.find((d) => d.code);
    if (firstCode) {
      fields.icd_code = firstCode.code;
      const caseType = suggestCaseType(firstCode.code);
      if (caseType) fields.case_type = caseType;
    }
  }

  const kind = guessDocumentKind(text);
  if (kind === 'policy') {
    // 증권에는 환자 정보가 없으므로 진단·주소 등은 버림
    return { kind, ...(fields.phone ? { phone: fields.phone } : {}) };
  }
  if (kind) fields.kind = kind;
  return fields;
}

module.exports = { extractFieldsFromText, findInsurers, guessDocumentKind };
