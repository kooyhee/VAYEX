/**
 * 부스 시연용 방문자 응원 메시지 로직
 */

/**
 * 메시지 유효성 검증 함수
 * @param {string} text - 검증할 입력 문자열
 * @returns {{ valid: boolean, message: string }}
 */
function validateMessage(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      message: '메시지를 입력해 주세요.'
    };
  }
  if (trimmed.length > 50) {
    return {
      valid: false,
      message: '메시지는 50자 이내로 입력해 주세요.'
    };
  }
  return {
    valid: true,
    message: `등록 완료: "${trimmed}"`
  };
}

// 브라우저 환경에서 이벤트 핸들러 바인딩
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('message-input');
    const button = document.getElementById('submit-btn');
    const status = document.getElementById('status-msg');

    if (button && input && status) {
      button.addEventListener('click', () => {
        const result = validateMessage(input.value);
        status.textContent = result.message;
        status.className = 'status-box ' + (result.valid ? 'success' : 'error');
        if (result.valid) {
          input.value = '';
        }
      });
    }
  });
}

// Node.js 테스트 환경을 위한 export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateMessage };
}
