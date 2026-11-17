/**
 * Plain Korean Error Explainer
 * Rule-based classification of common runtime, build, and test errors into
 * a 1-2 line Korean cause and suggested fix. No external LLM required.
 */

/**
 * @typedef {Object} ErrorExplanation
 * @property {string} category - 'network_disconnected' | 'timeout' | 'port_in_use' | 'permission' | 'module_not_found' | 'assertion_failure' | 'type_error' | 'syntax' | 'unknown'
 * @property {string} categoryLabel - Korean label
 * @property {string} cause - 1-2 line Korean description of the cause
 * @property {string} fix - Actionable suggested fix in plain Korean
 * @property {string|null} target - Identified package, file, or symbol if detectable
 * @property {number} confidence - 0.0 to 1.0 confidence score
 */

const RULES = [
  // 1. Network Disconnection
  //
  // Ahead of timeout on purpose: `ETIMEDOUT` is also a connection failure, and a
  // provider that was never reached is a different fix from a command that ran too
  // long. The rule only claims the ETIMEDOUT form that carries connection evidence.
  {
    category: 'network_disconnected',
    categoryLabel: '네트워크 단절 (Network unreachable)',
    regex: /(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT.*connect|connect.*ETIMEDOUT|getaddrinfo ENOTFOUND|socket hang up|fetch failed|Network request failed|Could not resolve host|Temporary failure in name resolution|네트워크에 연결|네트워크 연결이|요청 시간이 만료)/i,
    extract: (text) => {
      const host = text.match(/(?:ENOTFOUND|EAI_AGAIN|Could not resolve host:?)\s+([\w.-]+)/i)
        || text.match(/https?:\/\/([\w.-]+)/i)
        || text.match(/connect (?:ETIMEDOUT|ECONNREFUSED|ECONNRESET) ([\w.:-]+)/i);
      return host ? host[1] : null;
    },
    explain: (target) => ({
      cause: target
        ? `실행 환경에서 ${target} 주소에 닿지 못했습니다. 연결이 끊겼거나 주소가 잘못되었습니다.`
        : '실행 환경에서 외부 주소로 나가는 연결이 끊겼거나 상대 서버가 응답하지 않았습니다.',
      fix: '네트워크 연결과 프록시 설정을 확인하고, 오프라인이라면 로컬 실행 경로로 전환한 뒤 다시 시도하세요.'
    })
  },

  // 2. Timeout
  {
    category: 'timeout',
    categoryLabel: '실행 시간 초과 (Timeout)',
    regex: /(ETIMEDOUT|timed? ?out|타임아웃|시간 ?초과|command timed out|Process timed out after)/i,
    extract: (text) => {
      const match = text.match(/after (\d+m?s)/i) || text.match(/timeout of (\d+m?s)/i);
      return match ? match[1] : null;
    },
    explain: (target) => ({
      cause: target
        ? `지정된 제한 시간(${target}) 내에 명령이 완료되지 않고 멈췄습니다.`
        : '지정된 제한 시간 내에 작업이 완료되지 않고 멈췄습니다.',
      fix: '코드 내 무한 루프, 미종료 리스너(서버 대기), 입력 대기 상태가 있는지 점검하고 필요 시 타임아웃을 연장하세요.'
    })
  },

  // 3. Port In Use — an additional category beyond the documented seven. A local
  // bind conflict is neither a timeout nor a disconnection, and callers already read
  // `port_in_use`, so it is kept and classified after both of them.
  {
    category: 'port_in_use',
    categoryLabel: '네트워크 포트 충돌 (Port in use)',
    regex: /(EADDRINUSE|address already in use|port \d+ is already in use|already listening on|bind: address already in use)/i,
    extract: (text) => {
      const match = text.match(/port (\d+)/i) || text.match(/:(\d{2,5})\b/) || text.match(/address already in use (?:0\.0\.0\.0|127\.0\.0\.1|:::)?(?::)?(\d+)/i);
      return match ? match[1] : null;
    },
    explain: (target) => ({
      cause: target
        ? `포트 번호 ${target}번이 이미 다른 프로세스에서 사용 중입니다.`
        : '사용하려는 네트워크 포트가 이미 다른 프로그램에서 실행 중입니다.',
      fix: target
        ? `실행 중인 기존 프로세스를 종료하거나, 포트를 ${Number(target) + 1} 등으로 변경하여 다시 시도하세요.`
        : '이전에 실행된 서버 프로세스를 완전히 종료하거나 다른 포트 번호로 변경하세요.'
    })
  },

  // 4. Permission
  {
    category: 'permission',
    categoryLabel: '접근 권한 오류 (Permission denied)',
    regex: /(EACCES|EPERM|Permission denied|Operation not permitted|Access is denied|권한이 없습니다)/i,
    extract: (text) => {
      const match = text.match(/(?:permission denied|open|unlink|access)\s+['"]?([^'"\r\n]+)['"]?/i);
      return match ? match[1].trim() : null;
    },
    explain: (target) => ({
      cause: target
        ? `'${target}' 파일/폴더에 접근하거나 쓸 권한이 없습니다.`
        : '파일이나 디렉터리를 읽기/쓰기할 권한이 부족합니다.',
      fix: '다른 프로그램(IDE, 터미널 등)이 해당 파일을 점유 중인지 확인하고, 권한 설정 또는 쓰기 보호를 해제하세요.'
    })
  },

  // 4. Module Not Found / Import failure
  {
    category: 'module_not_found',
    categoryLabel: '모듈/패키지 누락 (Module not found)',
    regex: /(Cannot find module ['"]([^'"]+)['"]|ModuleNotFoundError: No module named ['"]([^'"]+)['"]|ImportError: cannot import name|unresolved import ['"]?([^'"\r\n]+)['"]?|package ['"]?([^'"\r\n]+)['"]? is not installed|failed to resolve import)/i,
    extract: (text) => {
      const match = text.match(/Cannot find module ['"]([^'"]+)['"]/) ||
                    text.match(/No module named ['"]([^'"]+)['"]/) ||
                    text.match(/unresolved import ['"]?([^'"\r\n]+)['"]?/) ||
                    text.match(/failed to resolve import ['"]([^'"]+)['"]/);
      return match ? (match[1] || match[2] || match[3] || match[4]) : null;
    },
    explain: (target) => {
      if (target && !target.startsWith('.') && !target.startsWith('/')) {
        return {
          cause: `필요한 패키지 '${target}'(이)가 설치되지 않았거나 경로를 찾을 수 없습니다.`,
          fix: `패키지 매니저로 설치하세요 (예: npm install ${target} 또는 pip install ${target}).`
        };
      }
      return {
        cause: target
          ? `'${target}' 파일이나 모듈 경로가 올바르지 않습니다.`
          : '참조하려는 모듈 또는 파일 경로를 찾을 수 없습니다.',
        fix: 'import/require 문의 상대 경로 및 파일 확장자 표기가 정확한지 확인하세요.'
      };
    }
  },

  // 5. Test Assertion Failure
  {
    category: 'assertion_failure',
    categoryLabel: '테스트 검증 실패 (Assertion failure)',
    regex: /(AssertionError|Expected:|Received:|Expected \S+ but received|assert \S+ == \S+|Assertion failed|FAILED \(failures=\d+\)|FAIL\s+\S+\.(?:test|spec)\.[jt]sx?)/i,
    extract: (text) => {
      const match = text.match(/Expected:\s*([^\r\n]+)[\s\S]*?Received:\s*([^\r\n]+)/i);
      if (match) {
        return `기대값: ${match[1].trim()}, 실제값: ${match[2].trim()}`;
      }
      const loose = text.match(/Expected\s+([^\r\n]+?)\s+but\s+received\s+([^\r\n]+)/i);
      if (loose) {
        return `기대값: ${loose[1].trim()}, 실제값: ${loose[2].trim()}`;
      }
      const failMatch = text.match(/assert ([^\r\n]+)/);
      return failMatch ? failMatch[1].trim() : null;
    },
    explain: (target) => ({
      cause: target
        ? `테스트 검증 조건 불일치: ${target}`
        : '테스트 코드에서 기대한 결과값과 실제 실행 결과값이 다릅니다.',
      fix: '함수의 반환값이나 계산 로직이 테스트의 기댓값과 일치하도록 비즈니스 로직을 수정하세요.'
    })
  },

  // 6. Type Error
  {
    category: 'type_error',
    categoryLabel: '타입 오류 (Type error)',
    regex: /(TypeError:|TS2322|TS2339|TS2345|TS2304|Cannot read propert(?:y|ies) of (?:null|undefined)|is not a function|NoneType' object has no attribute|AttributeError:)/i,
    extract: (text) => {
      const match = text.match(/Cannot read propert(?:y|ies) of (?:null|undefined) \(reading ['"]?([^'")\r\n]+)['"]?\)/i) ||
                    text.match(/(\S+) is not a function/i) ||
                    text.match(/AttributeError: '([^']+)' object has no attribute '([^']+)'/i) ||
                    text.match(/Property '([^']+)' does not exist on type/i);
      if (match) {
        return match[0];
      }
      return null;
    },
    explain: (target) => ({
      cause: target
        ? `잘못된 타입 또는 필드 접근: ${target}`
        : 'null 또는 undefined인 객체의 속성을 참조했거나 올바르지 않은 타입이 전달되었습니다.',
      fix: '객체가 비어있지 않은지(null/undefined 방어 코드) 확인하고 속성명 오탈자를 점검하세요.'
    })
  },

  // 7. Syntax Error
  {
    category: 'syntax',
    categoryLabel: '문법 오류 (Syntax error)',
    regex: /(SyntaxError:|IndentationError:|unexpected token|Parsing error:|expected [;'")}\]]|Syntax error:)/i,
    extract: (text) => {
      const match = text.match(/([^\r\n]+:\d+:\d+)/) || text.match(/line \d+/i);
      return match ? match[1] || match[0] : null;
    },
    explain: (target) => ({
      cause: target
        ? `코드 문법 규칙 불일치 (${target})`
        : '코드 문법(괄호 쌍, 따옴표, 들여쓰기, 세미콜론 등)이 올바르지 않습니다.',
      fix: '해당 위치의 열린 괄호가 닫혔는지, 콤마나 따옴표가 누락되지 않았는지 확인하세요.'
    })
  }
];

/**
 * Classifies an error log (stderr, stdout, or exception message) into plain Korean.
 *
 * @param {string|Error} errorOrLog
 * @returns {ErrorExplanation}
 */
export function explainError(errorOrLog) {
  const text = typeof errorOrLog === 'string'
    ? errorOrLog
    : `${errorOrLog?.message || ''}\n${errorOrLog?.stack || ''}`;

  if (!text || text.trim() === '') {
    return {
      category: 'unknown',
      categoryLabel: '알 수 없는 오류',
      cause: '에러 로그 내용이 비어있어 원인을 특정할 수 없습니다.',
      fix: '상세 로그를 활성화하거나 콘솔 출력 내용을 확인하세요.',
      target: null,
      confidence: 0.1
    };
  }

  for (const rule of RULES) {
    if (rule.regex.test(text)) {
      const target = rule.extract ? rule.extract(text) : null;
      const explanation = rule.explain(target);

      return {
        category: rule.category,
        categoryLabel: rule.categoryLabel,
        cause: explanation.cause,
        fix: explanation.fix,
        target,
        confidence: 0.95
      };
    }
  }

  // Fallback for unclassified error
  const firstLine = text.split('\n').map(l => l.trim()).filter(Boolean)[0] || 'Unknown error';
  return {
    category: 'unknown',
    categoryLabel: '일반 실행 오류',
    cause: `실행 중 오류가 발생했습니다: ${firstLine.slice(0, 100)}`,
    fix: '에러 로그의 스택 트레이스를 확인하고 발생한 줄 번호의 코드를 검토하세요.',
    target: null,
    confidence: 0.4
  };
}
