const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

// 모든 작업 조회 (권한에 따라 필터링)
router.get('/', authMiddleware, async (req, res) => {
  try {
    let query = supabase
      .from('tasks')
      .select('id, place_name, stars, image_uploaded, status, review_status, image_status, current_step, notes, work_account, user_id, store_id, task_id, completed_count, created_at, updated_at, review_share_link, user:user_id(user_id, superior_name), store:store_id(id, store_name, daily_frequency, total_count, owner:user_id(user_id))')
      .order('created_at', { ascending: false });

    // agency 권한: 자신이 소유한 매장의 작업만 조회 (store_id로 필터링)
    if (req.user.role === 'agency') {
      // 1. Agency가 소유한 stores 조회
      const { data: userStores, error: storesError } = await supabase
        .from('stores')
        .select('id')
        .eq('user_id', req.user.id);

      if (storesError) throw storesError;

      // 2. stores의 id 배열 생성
      const storeIds = userStores?.map(s => s.id) || [];

      // 3. 해당 stores에 연결된 tasks만 필터링
      if (storeIds.length > 0) {
        query = query.in('store_id', storeIds);
      } else {
        // store가 없으면 빈 결과 반환 (불가능한 조건)
        query = query.eq('store_id', null);
      }
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
    const { placeName, stars, imageUploaded, status, notes, reviewStatus, imageStatus } = req.body;

    if (!placeName) {
      return res.status(400).json({ error: '매장명은 필수입니다.' });
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
    const { placeName, stars, imageUploaded, status, notes, reviewStatus, imageStatus, currentStep, workAccount } = req.body;

    // agency 권한 확인: 본인의 작업인지 확인
    if (req.user.role === 'agency') {
      const { data: task } = await supabase
        .from('tasks')
        .select('user_id')
        .eq('id', req.params.id)
        .single();

      if (!task || task.user_id !== req.user.id) {
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
    if (workAccount !== undefined) updateData.work_account = workAccount;
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

    res.json({ message: '작업이 업데이트되었습니다.', updatedTask: data[0] });
  } catch (error) {
    console.error('작업 업데이트 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 작업 삭제
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    // agency 권한 확인: 본인의 작업인지 확인
    if (req.user.role === 'agency') {
      const { data: task } = await supabase
        .from('tasks')
        .select('user_id')
        .eq('id', req.params.id)
        .single();

      if (!task || task.user_id !== req.user.id) {
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

// 리뷰 링크 저장
router.post('/:id/review-link', authMiddleware, async (req, res) => {
  try {
    const { review_share_link } = req.body;
    
    if (!review_share_link) {
      return res.status(400).json({ error: '링크가 필요합니다.' });
    }

    // Task 조회 및 권한 검증
    const { data: task, error: fetchError } = await supabase
      .from('tasks')
      .select('id, user_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !task) {
      return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
    }

    // 🔐 권한 검증: Admin이거나 본인의 작업인지 확인
    if (req.user.role !== 'admin') {
      if (task.user_id !== req.user.id) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }
    }

    // 링크 저장
    const { data: updatedTask, error: updateError } = await supabase
      .from('tasks')
      .update({ review_share_link })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateError) {
      console.error('링크 업데이트 오류:', updateError);
      return res.status(500).json({ error: '링크 저장에 실패했습니다.' });
    }

    res.json({ updatedTask });
  } catch (error) {
    console.error('리뷰 링크 저장 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// Task 상태 리셋 (in_progress → pending)
router.post('/:id/reset', authMiddleware, async (req, res) => {
  try {
    // Task 조회 및 권한 검증
    const { data: task, error: fetchError } = await supabase
      .from('tasks')
      .select('id, user_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !task) {
      return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
    }

    // 🔐 권한 검증: Admin이거나 본인의 작업인지 확인
    if (req.user.role !== 'admin') {
      if (task.user_id !== req.user.id) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }
    }

    // Task 상태 리셋
    const { data, error } = await supabase
      .from('tasks')
      .update({
        status: 'pending',
        review_status: 'pending',
        image_status: 'pending',
        current_step: '대기 중',
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;

    res.json({ message: '작업이 리셋되었습니다.', task: data[0] });
  } catch (error) {
    console.error('작업 리셋 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
