const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

// 현재 사용자의 매장 조회
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stores')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

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
    const { storeName, address, reviewMessage } = req.body;

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

// 매장 수정 (본인 매장만)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { storeName, address, reviewMessage } = req.body;

    if (!storeName) {
      return res.status(400).json({ error: '매장명을 입력하세요.' });
    }

    // 본인의 매장인지 확인
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('user_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    if (store.user_id !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다.' });
    }

    const { data, error } = await supabase
      .from('stores')
      .update({
        store_name: storeName,
        address: address || null,
        review_message: reviewMessage || null,
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

// 매장 삭제 (본인 매장만)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    // 본인의 매장인지 확인
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('user_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    if (store.user_id !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다.' });
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
