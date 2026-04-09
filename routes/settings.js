const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

// 설정 조회 (Admin만)
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin 권한이 필요합니다.' });
    }

    const { data, error } = await supabase
      .from('admin_settings')
      .select('*')
      .limit(1)
      .single();

    if (error) {
      // 설정이 없으면 기본값 반환
      if (error.code === 'PGRST116') {
        return res.json({
          id: null,
          allow_agency_create_account: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    console.error('❌ 설정 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 설정 업데이트 (Admin만)
router.put('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin 권한이 필요합니다.' });
    }

    const { allow_agency_create_account } = req.body;

    // 첫 번째 행 가져오기
    const { data: existing, error: getError } = await supabase
      .from('admin_settings')
      .select('id')
      .limit(1)
      .single();

    const updateData = {
      allow_agency_create_account: !!allow_agency_create_account,
      updated_at: new Date().toISOString(),
    };

    let result;

    if (existing?.id) {
      // 첫 번째 행 업데이트
      result = await supabase
        .from('admin_settings')
        .update(updateData)
        .eq('id', existing.id)
        .select();
    } else {
      // 새 행 생성
      result = await supabase
        .from('admin_settings')
        .insert([updateData])
        .select();
    }

    if (result.error) {
      console.error('❌ 업데이트 오류:', result.error);
      throw result.error;
    }

    const savedSettings = result.data[0];

    res.json({ 
      message: '설정이 저장되었습니다.', 
      settings: savedSettings 
    });
  } catch (error) {
    console.error('❌ 설정 업데이트 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 권한 조회 (모든 사용자)
router.get('/check/agency-create-account', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_settings')
      .select('allow_agency_create_account')
      .single();

    if (error) {
      // 설정이 없으면 기본값은 false
      if (error.code === 'PGRST116') {
        return res.json({ allowed: false });
      }
      throw error;
    }

    res.json({ allowed: data?.allow_agency_create_account || false });
  } catch (error) {
    console.error('❌ 권한 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
