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
    const { storeName, address, reviewMessage, imageUrls, dailyFrequency, totalCount } = req.body;

    if (!storeName) {
      return res.status(400).json({ error: '매장명을 입력하세요.' });
    }

    const dailyFreq = dailyFrequency || 1;
    const totalCnt = totalCount || 1;

    // ✓ 검증: 총 발행 횟수는 일발행 횟수 이상이어야 함
    if (totalCnt < dailyFreq) {
      return res.status(400).json({ error: `총 발행 횟수는 일발행 횟수(${dailyFreq}회) 이상이어야 합니다.` });
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

    // imageUrls 배열 검증 및 정리
    const processedImageUrls = Array.isArray(imageUrls) 
      ? imageUrls.filter(url => typeof url === 'string' && url.trim().length > 0 && url.trim().startsWith('http'))
      : [];

    const { data, error } = await supabase
      .from('stores')
      .insert([
        {
          store_name: storeName,
          address: address || null,
          review_message: reviewMessage || null,
          image_urls: processedImageUrls,
          daily_frequency: dailyFreq,
          total_count: totalCnt,
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

// 매장 수정 (자신의 매장만)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { storeName, address, reviewMessage, imageUrls, dailyFrequency, totalCount } = req.body;

    if (!storeName) {
      return res.status(400).json({ error: '매장명을 입력하세요.' });
    }

    const dailyFreq = dailyFrequency || 1;
    const totalCnt = totalCount || 1;

    // ✓ 검증: 총 발행 횟수는 일발행 횟수 이상이어야 함
    if (totalCnt < dailyFreq) {
      return res.status(400).json({ error: `총 발행 횟수는 일발행 횟수(${dailyFreq}회) 이상이어야 합니다.` });
    }

    // 매장 조회 및 권한 검증
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('id, user_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    // 🔐 권한 검증: Admin이 아니면 자신의 매장만 수정 가능
    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      if (store.user_id !== req.user.id) {
        return res.status(403).json({ error: '이 매장을 수정할 권한이 없습니다.' });
      }
    }

    // imageUrls 배열 검증 및 정리
    const processedImageUrls = Array.isArray(imageUrls) 
      ? imageUrls.filter(url => typeof url === 'string' && url.trim().length > 0 && url.trim().startsWith('http'))
      : [];

    const { data, error } = await supabase
      .from('stores')
      .update({
        store_name: storeName,
        address: address || null,
        review_message: reviewMessage || null,
        image_urls: processedImageUrls,
        daily_frequency: dailyFreq,
        total_count: totalCnt,
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

// 매장 삭제 (자신의 매장만)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    // 매장 조회 및 권한 검증
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('id, user_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    // 🔐 권한 검증: Admin이 아니면 자신의 매장만 삭제 가능
    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      if (store.user_id !== req.user.id) {
        return res.status(403).json({ error: '이 매장을 삭제할 권한이 없습니다.' });
      }
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
