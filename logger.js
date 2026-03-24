// backend/logger.js - Playwright 로깅 시스템
const supabase = require('./supabaseClient');

// 로그 레벨
const LOG_LEVELS = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR'
};

// 이모지 매핑
const EMOJIS = {
  DEBUG: '🔍',
  INFO: 'ℹ️',
  WARN: '⚠️',
  ERROR: '❌'
};

/**
 * 구조화된 로그 저장
 * @param {string} taskId - 작업 ID
 * @param {string} message - 로그 메시지
 * @param {string} level - 로그 레벨 (DEBUG, INFO, WARN, ERROR)
 * @param {object} meta - 추가 메타데이터
 */
async function log(taskId, message, level = 'INFO', meta = {}) {
  const emoji = EMOJIS[level] || '📝';
  const timestamp = new Date().toISOString();
  
  // 콘솔에 출력
  const consoleMessage = `[${timestamp}] ${emoji} [${level}] ${message}`;
  
  if (level === 'ERROR') {
    console.error(consoleMessage);
  } else if (level === 'WARN') {
    console.warn(consoleMessage);
  } else if (level === 'DEBUG') {
    console.debug(consoleMessage);
  } else {
    console.log(consoleMessage);
  }

  // DB에 저장
  try {
    const { data, error } = await supabase
      .from('logs')
      .insert([
        {
          task_id: taskId,
          message: message,
          log_level: level,
          timestamp: timestamp,
          ...(Object.keys(meta).length > 0 && { metadata: meta })
        }
      ]);

    if (error) {
      console.error('❌ Supabase 로그 저장 오류:', error.message, error.details);
    } else {
      console.log(`✅ 로그 저장됨: ${taskId} - ${message}`);
    }
  } catch (error) {
    console.error('❌ 로그 저장 Exception:', error.message);
  }
}

/**
 * 작업 상태 업데이트
 * @param {string} taskId - 작업 ID (task_xxxxx 형식)
 * @param {object} updates - 업데이트할 필드들
 */
async function updateTaskStatus(taskId, updates) {
  try {
    // task_id로 업데이트 시도
    const { data, error } = await supabase
      .from('tasks')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('task_id', taskId)
      .select();

    if (error) {
      console.error('❌ 작업 상태 업데이트 실패:', error);
      return null;
    }

    if (data && data.length > 0) {
      console.log(`✅ 작업 상태 업데이트 성공: ${taskId}`);
      return data[0];
    }

    return null;
  } catch (error) {
    console.error('❌ 작업 상태 업데이트 오류:', error.message);
    return null;
  }
}

/**
 * 특정 작업의 모든 로그 조회
 * @param {string} taskId - 작업 ID
 * @param {number} limit - 최대 로그 개수
 */
async function getLogs(taskId, limit = 100) {
  try {
    const { data, error } = await supabase
      .from('logs')
      .select('*')
      .eq('task_id', taskId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('❌ 로그 조회 실패:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('❌ 로그 조회 오류:', error.message);
    return [];
  }
}

/**
 * 편의 함수들
 */
const logger = {
  debug: (taskId, message, meta) => log(taskId, message, 'DEBUG', meta),
  info: (taskId, message, meta) => log(taskId, message, 'INFO', meta),
  warn: (taskId, message, meta) => log(taskId, message, 'WARN', meta),
  error: (taskId, message, meta) => log(taskId, message, 'ERROR', meta),
  updateStatus: updateTaskStatus,
  getLogs: getLogs
};

module.exports = logger;
