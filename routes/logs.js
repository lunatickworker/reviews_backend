// backend/routes/logs.js - 리뷰 작성 진행 로그 API
const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

/**
 * 특정 작업의 로그 조회
 * GET /api/logs/:taskId
 */
router.get('/:taskId', authMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    const { data, error } = await supabase
      .from('logs')
      .select('*')
      .eq('task_id', taskId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error('❌ 로그 조회 오류:', error);
    res.status(500).json({ error: '로그 조회에 실패했습니다.' });
  }
});

/**
 * 모든 로그 조회 (최근 100개, 주로 디버깅용)
 * GET /api/logs
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;

    const { data, error } = await supabase
      .from('logs')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error('❌ 로그 조회 오류:', error);
    res.status(500).json({ error: '로그 조회에 실패했습니다.' });
  }
});

/**
 * 로그 삭제 (완료된 작업의 로그)
 * DELETE /api/logs/:taskId
 */
router.delete('/:taskId', authMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;

    // devadmin 권한 확인
    if (req.user.role !== 'devadmin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: '로그 삭제 권한이 없습니다.' });
    }

    const { error } = await supabase
      .from('logs')
      .delete()
      .eq('task_id', taskId);

    if (error) throw error;

    res.json({ message: '로그가 삭제되었습니다.' });
  } catch (error) {
    console.error('❌ 로그 삭제 오류:', error);
    res.status(500).json({ error: '로그 삭제에 실패했습니다.' });
  }
});

module.exports = router;
