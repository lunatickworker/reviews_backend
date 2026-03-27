const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

// 모든 리뷰 조회 (자신의 리뷰만)
router.get('/', authMiddleware, async (req, res) => {
  try {
    console.log('📝 Reviews GET 요청 들어옴:', {
      user: req.user,
      timestamp: new Date().toISOString()
    });

    let query = supabase
      .from('reviews')
      .select('*')
      .order('created_at', { ascending: false });

    // 🔐 권한: Admin이 아니면 자신의 리뷰만 조회
    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      query = query.eq('user_id', req.user.id);
    }

    const { data, error } = await query;

    console.log('📊 Supabase 쿼리 결과:', {
      rowCount: data?.length || 0,
      error: error ? error.message : null
    });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('❌ 리뷰 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 리뷰 업데이트 (자신의 리뷰만)
router.put('/update', authMiddleware, async (req, res) => {
  try {
    const { id, rating, notes, status } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'ID는 필수입니다.' });
    }

    // 리뷰 조회 및 권한 검증
    const { data: review, error: fetchError } = await supabase
      .from('reviews')
      .select('id, user_id')
      .eq('id', id)
      .single();

    if (fetchError || !review) {
      return res.status(404).json({ error: '리뷰를 찾을 수 없습니다.' });
    }

    // 🔐 권한 검증: Admin이 아니면 자신의 리뷰만 수정 가능
    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      if (review.user_id !== req.user.id) {
        return res.status(403).json({ error: '이 리뷰를 수정할 권한이 없습니다.' });
      }
    }

    const updateData = {};
    if (rating !== undefined) updateData.rating = rating;
    if (notes !== undefined) updateData.notes = notes;
    if (status !== undefined) updateData.status = status;
    updateData.updated_at = new Date().toISOString();

    console.log('📝 리뷰 업데이트:', {
      id,
      updateData,
      user: req.user.id
    });

    const { data, error } = await supabase
      .from('reviews')
      .update(updateData)
      .eq('id', id)
      .select();

    if (error) throw error;

    console.log('✅ 리뷰 업데이트 성공:', data);
    res.json({ message: '리뷰가 업데이트되었습니다.', review: data[0] });
  } catch (error) {
    console.error('❌ 리뷰 업데이트 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 새로운 리뷰 생성
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { placeName, rating, notes, status } = req.body;

    if (!placeName) {
      return res.status(400).json({ error: '장소명은 필수입니다.' });
    }

    const { data, error } = await supabase
      .from('reviews')
      .insert([
        {
          place_name: placeName,
          rating: rating || 0,
          notes: notes || '',
          status: status || 'pending',
          user_id: req.user.id,
          created_at: new Date().toISOString(),
        },
      ])
      .select();

    if (error) throw error;

    res.json({ message: '리뷰가 생성되었습니다.', review: data[0] });
  } catch (error) {
    console.error('❌ 리뷰 생성 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 리뷰 삭제 (자신의 리뷰만)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    // 리뷰 조회 및 권한 검증
    const { data: review, error: fetchError } = await supabase
      .from('reviews')
      .select('id, user_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !review) {
      return res.status(404).json({ error: '리뷰를 찾을 수 없습니다.' });
    }

    // 🔐 권한 검증: Admin이 아니면 자신의 리뷰만 삭제 가능
    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      if (review.user_id !== req.user.id) {
        return res.status(403).json({ error: '이 리뷰를 삭제할 권한이 없습니다.' });
      }
    }

    const { error } = await supabase
      .from('reviews')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ message: '리뷰가 삭제되었습니다.' });
  } catch (error) {
    console.error('❌ 리뷰 삭제 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
