// backend/routes/accounts.js
const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

// ✅ 모든 계정 조회
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('id, email, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ 계정 조회 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 계정 추가 (admin만)
router.post('/', authMiddleware, async (req, res) => {
  const { email } = req.body;

  // admin 권한 확인
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin 권한이 필요합니다.' });
  }

  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'email is required' });
  }

  try {
    const { data, error } = await supabase
      .from('accounts')
      .insert([{ email: email.trim() }])
      .select();

    if (error) {
      if (error.message.includes('duplicate')) {
        return res.status(400).json({ error: '이미 존재하는 계정입니다.' });
      }
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ 계정 추가: ${email}`);
    res.json(data[0]);
  } catch (error) {
    console.error('❌ 계정 추가 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 계정 삭제 (admin)
router.delete('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;

  // admin 권한 확인
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin 권한이 필요합니다.' });
  }

  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const { data, error } = await supabase
      .from('accounts')
      .delete()
      .eq('id', id)
      .select();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (data.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    console.log(`✅ 계정 삭제: ${data[0].email}`);
    res.json({ success: true, deleted: data[0] });
  } catch (error) {
    console.error('❌ 계정 삭제 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
