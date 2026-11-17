import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function runTests() {
  const root = __dirname;

  // 1. 필수 정적 파일 존재 확인
  const requiredFiles = ['package.json', 'index.html', 'style.css', 'app.js'];
  for (const file of requiredFiles) {
    const p = path.join(root, file);
    assert.ok(fs.existsSync(p), `필수 파일 누락: ${file}`);
  }

  // 2. HTML 구조 검증
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('id="title"'), 'index.html에 id="title" 요소가 있어야 합니다.');
  assert.ok(html.includes('id="submit-btn"'), 'index.html에 id="submit-btn" 요소가 있어야 합니다.');
  assert.ok(html.includes('id="message-input"'), 'index.html에 id="message-input" 요소가 있어야 합니다.');

  // 3. app.js 로직 검증
  const { validateMessage } = require('./app.js');
  assert.equal(typeof validateMessage, 'function', 'validateMessage 함수가 export되어야 합니다.');

  const emptyCheck = validateMessage('');
  assert.equal(emptyCheck.valid, false, '빈 문자열 입력 시 valid=false여야 합니다.');

  const passCheck = validateMessage('국립목포해양대 화이팅');
  assert.equal(passCheck.valid, true, '정상 입력 시 valid=true여야 합니다.');
  assert.ok(passCheck.message.includes('국립목포해양대 화이팅'), '정상 입력 시 메시지가 포함되어야 합니다.');

  console.log('✓ [PASS] 부스 예제 검증 통과: UI 요소 및 함수 로직 정상 (0개 실패)');
}

runTests();
