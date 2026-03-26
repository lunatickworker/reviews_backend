const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

// 매장 조회 (관리자: 모든 매장, 일반 사용자: 자신의 매장)
router.get('/', authMiddleware, async (req, res) => {
  try {
    let query = supabase
      .from('stores')
      .select('*, user:user_id(user_id, superior_name)')
      .order('created_at', { ascending: false });

    // 관리자가 아니면 자신의 매장만 조회
    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      query = query.eq('user_id', req.user.id);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('매장 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 매장 생성 (현재 사용자)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { storeName, address, reviewMessage, dailyFrequency, totalCount } = req.body;

    if (!storeName) {
      return res.status(400).json({ error: '매장명을 입력하세요.' });
    }

    // 중복 체크
    const { data: existing } = await supabase
      .from('stores')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('store_name', storeName);

    if (existing && existing.length > 0) {
      return res.status(400).json({ error: '이미 등록된 매장입니다.' });
    }

    const { data, error } = await supabase
      .from('stores')
      .insert([
        {
          store_name: storeName,
          address: address || null,
          review_message: reviewMessage || null,
          daily_frequency: dailyFrequency || 1,
          total_count: totalCount || 1,
          user_id: req.user.id,
          created_at: new Date().toISOString(),
        },
      ])
      .select();

    if (error) throw error;

    res.json({ message: '매장이 등록되었습니다.', store: data[0] });
  } catch (error) {
    console.error('매장 생성 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 매장 수정 (모든 사용자)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { storeName, address, reviewMessage, dailyFrequency, totalCount } = req.body;

    if (!storeName) {
      return res.status(400).json({ error: '매장명을 입력하세요.' });
    }

    // 매장 존재 여부만 확인
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    const { data, error } = await supabase
      .from('stores')
      .update({
        store_name: storeName,
        address: address || null,
        review_message: reviewMessage || null,
        daily_frequency: dailyFrequency || 1,
        total_count: totalCount || 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;

    res.json({ message: '매장이 수정되었습니다.', store: data[0] });
  } catch (error) {
    console.error('매장 수정 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 매장 삭제 (모든 사용자)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    // 매장 존재 여부만 확인
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    const { error } = await supabase
      .from('stores')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ message: '매장이 삭제되었습니다.' });
  } catch (error) {
    console.error('매장 삭제 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
