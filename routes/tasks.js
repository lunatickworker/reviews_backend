const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

// 모든 작업 조회 (권한에 따라 필터링)
router.get('/', authMiddleware, async (req, res) => {
  try {
    let query = supabase
      .from('tasks')
      .select('*, users(user_id), stores(store_name)')
      .order('created_at', { ascending: false });

    // agency 권한은 자신의 매장에만 접근 가능
    if (req.user.role === 'agency') {
      // 먼저 사용자의 매장 IDs 조회
      const { data: stores } = await supabase
        .from('stores')
        .select('id')
        .eq('user_id', req.user.id);

      const storeIds = stores ? stores.map(s => s.id) : [];
      
      if (storeIds.length === 0) {
        return res.json([]); // 매장이 없으면 빈 배열 반환
      }

      query = query.in('store_id', storeIds);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('❌ 작업 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 새 작업 생성
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { placeName, stars, imageUploaded, status, notes, reviewStatus, imageStatus, storeId } = req.body;

    if (!placeName) {
      return res.status(400).json({ error: '매장명은 필수입니다.' });
    }

    if (!storeId) {
      return res.status(400).json({ error: '매장을 선택하세요.' });
    }

    // agency 권한 확인: 본인의 매장인지 확인
    if (req.user.role === 'agency') {
      const { data: store } = await supabase
        .from('stores')
        .select('user_id')
        .eq('id', storeId)
        .single();

      if (!store || store.user_id !== req.user.id) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert([
        {
          place_name: placeName,
          stars: stars || 0,
          image_uploaded: imageUploaded || false,
          status: status || 'pending',
          review_status: reviewStatus || 'pending',
          image_status: imageStatus || 'pending',
          current_step: '대기 중',
          notes: notes || '',
          user_id: req.user.id,
          store_id: storeId,
          created_at: new Date().toISOString(),
        },
      ])
      .select();

    if (error) throw error;

    res.json({ message: '작업이 생성되었습니다.', task: data[0] });
  } catch (error) {
    console.error('작업 생성 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 작업 업데이트
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { placeName, stars, imageUploaded, status, notes, reviewStatus, imageStatus, currentStep } = req.body;

    // agency 권한 확인: 본인의 매장 작업인지 확인
    if (req.user.role === 'agency') {
      const { data: task } = await supabase
        .from('tasks')
        .select('store_id')
        .eq('id', req.params.id)
        .single();

      if (!task) {
        return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
      }

      const { data: store } = await supabase
        .from('stores')
        .select('user_id')
        .eq('id', task.store_id)
        .single();

      if (!store || store.user_id !== req.user.id) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }
    }

    const updateData = {};
    if (placeName !== undefined) updateData.place_name = placeName;
    if (stars !== undefined) updateData.stars = stars;
    if (imageUploaded !== undefined) updateData.image_uploaded = imageUploaded;
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (reviewStatus !== undefined) updateData.review_status = reviewStatus;
    if (imageStatus !== undefined) updateData.image_status = imageStatus;
    if (currentStep !== undefined) updateData.current_step = currentStep;
    updateData.updated_at = new Date().toISOString();

    console.log('📝 작업 업데이트:', {
      id: req.params.id,
      updateData,
      user: req.user.id
    });

    const { data, error } = await supabase
      .from('tasks')
      .update(updateData)
      .eq('id', req.params.id)
      .select();

    if (error) throw error;

    res.json({ message: '작업이 업데이트되었습니다.', task: data[0] });
  } catch (error) {
    console.error('작업 업데이트 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 작업 삭제
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    // agency 권한 확인: 본인의 매장 작업인지 확인
    if (req.user.role === 'agency') {
      const { data: task } = await supabase
        .from('tasks')
        .select('store_id')
        .eq('id', req.params.id)
        .single();

      if (!task) {
        return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
      }

      const { data: store } = await supabase
        .from('stores')
        .select('user_id')
        .eq('id', task.store_id)
        .single();

      if (!store || store.user_id !== req.user.id) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }
    }

    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ message: '작업이 삭제되었습니다.' });
  } catch (error) {
    console.error('작업 삭제 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 사용자별 작업 조회
router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('작업 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
