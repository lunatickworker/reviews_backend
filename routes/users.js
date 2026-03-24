const express = require('express');
const bcryptjs = require('bcryptjs');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

// 사용자 조회 (admin - 모든 사용자, agency - 자신이 생성한 하위만)
router.get('/', authMiddleware, async (req, res) => {
  try {
    let query = supabase
      .from('users')
      .select('id, user_id, role, superior_name, created_at')
      .order('created_at', { ascending: false });

    // agency 사용자는 자신이 생성한 하위 사용자만 조회
    if (req.user.role === 'agency') {
      query = query.eq('superior_name', req.user.userId);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('사용자 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 특정 사용자 조회
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, user_id, role, superior_name, created_at')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }

    res.json(data);
  } catch (error) {
    console.error('사용자 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 사용자 권한 업데이트 (admin - 모든 사용자, agency - 자신의 하위만)
router.put('/:id/role', authMiddleware, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['agency', 'admin'].includes(role)) {
      return res.status(400).json({ error: '유효하지 않은 권한입니다.' });
    }

    // agency 사용자는 자신의 하위 사용자만 수정 가능
    if (req.user.role === 'agency') {
      const { data: targetUser } = await supabase
        .from('users')
        .select('superior_name')
        .eq('id', req.params.id)
        .single();

      if (!targetUser || targetUser.superior_name !== req.user.userId) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }
    }

    const { data, error } = await supabase
      .from('users')
      .update({ role })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;

    res.json({ message: '권한이 업데이트되었습니다.', user: data[0] });
  } catch (error) {
    console.error('권한 업데이트 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 사용자 삭제 (admin - 모든 사용자, agency - 자신의 하위만)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    // agency 사용자는 자신의 하위 사용자만 삭제 가능
    if (req.user.role === 'agency') {
      const { data: targetUser } = await supabase
        .from('users')
        .select('superior_name')
        .eq('id', req.params.id)
        .single();

      if (!targetUser || targetUser.superior_name !== req.user.userId) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ message: '사용자가 삭제되었습니다.' });
  } catch (error) {
    console.error('사용자 삭제 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 비밀번호 변경 (admin - 모든 사용자, agency - 자신의 하위만)
router.put('/:id/password', authMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: '새 비밀번호를 입력하세요.' });
    }

    // agency 사용자는 자신의 하위 사용자만 비밀번호 변경 가능
    if (req.user.role === 'agency') {
      const { data: targetUser } = await supabase
        .from('users')
        .select('superior_name')
        .eq('id', req.params.id)
        .single();

      if (!targetUser || targetUser.superior_name !== req.user.userId) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }
    }

    // 비밀번호 해시화
    const hashedPassword = await bcryptjs.hash(newPassword, 10);

    const { data, error } = await supabase
      .from('users')
      .update({ password: hashedPassword })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;

    res.json({ message: '비밀번호가 변경되었습니다.', user: data[0] });
  } catch (error) {
    console.error('비밀번호 변경 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
