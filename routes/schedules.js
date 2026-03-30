const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

// 랜덤 시간 생성: 첫 번째는 즉시, 나머지는 24시간 내 랜덤
function generateRandomTimes(count) {
  const times = [];
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  
  // 1️⃣ 첫 번째: 현재 시간 (즉시 시작)
  if (count >= 1) {
    const nowTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
    times.push(nowTimeStr);
  }
  
  // 2️⃣ 나머지: 24시간 내 랜덤
  while (times.length < count) {
    const hour = Math.floor(Math.random() * 24);
    const minute = Math.floor(Math.random() * 60);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    
    // 중복 제거
    if (!times.includes(timeStr)) {
      times.push(timeStr);
    }
  }
  
  return times.sort();
}

// 배포 스케줄 조회
router.get('/', authMiddleware, async (req, res) => {
  try {
    let query = supabase
      .from('deploy_schedules')
      .select('*, stores(store_name, review_message, daily_frequency, total_count)')
      .order('updated_at', { ascending: false });

    // 관리자가 아니면 자신의 스케줄만
    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      query = query.eq('user_id', req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('❌ 스케줄 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 배포 스케줄 생성 (배포 예약) - Admin만
router.post('/', authMiddleware, async (req, res) => {
  try {
    // 🔐 관리자만 배포 예약 가능
    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      return res.status(403).json({ error: '배포 예약은 관리자만 가능합니다.' });
    }

    const { storeId, dailyFrequency, totalCount } = req.body;

    if (!storeId || !dailyFrequency || !totalCount) {
      return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    // 같은 매장의 활성 스케줄 확인
    const { data: existingSchedule } = await supabase
      .from('deploy_schedules')
      .select('id')
      .eq('store_id', storeId)
      .eq('status', 'active')
      .eq('user_id', req.user.id);

    if (existingSchedule && existingSchedule.length > 0) {
      return res.status(400).json({ error: '이미 진행 중인 배포가 있습니다.' });
    }

    // 🚀 오늘의 배포 시간 즉시 생성 (매일 자정까지 기다리지 않음)
    const deployTimes = generateRandomTimes(dailyFrequency);
    const today = new Date().toISOString().split('T')[0];

    // 스케줄 생성
    const { data, error } = await supabase
      .from('deploy_schedules')
      .insert([{
        store_id: storeId,
        user_id: req.user.id,
        daily_frequency: dailyFrequency,
        total_count: totalCount,
        completed_count: 0,
        remaining_count: totalCount,
        status: 'active',
        start_date: today,
        last_deploy_date: null,  // ❌ 초기에는 null (배포 후에 설정)
        next_deploy_times: deployTimes,  // 🎯 배포 시간 즉시 설정
      }])
      .select();

    if (error) throw error;

    console.log(`✅ 스케줄 생성: ID=${data[0].id}, 배포 시간=${deployTimes.join(', ')}`);
    res.json({ 
      message: '배포 스케줄이 등록되었습니다.', 
      schedule: data[0],
      deployTimes 
    });
  } catch (error) {
    console.error('❌ 스케줄 생성 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 배포 스케줄 취소 - Admin만
router.put('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    // 🔐 관리자만 배포 취소 가능
    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      return res.status(403).json({ error: '배포 취소는 관리자만 가능합니다.' });
    }

    const { id } = req.params;

    // 자신의 스케줄만 취소 가능
    const { data: schedule } = await supabase
      .from('deploy_schedules')
      .select('user_id')
      .eq('id', id)
      .single();

    if (!schedule || schedule.user_id !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다.' });
    }

    const { data, error } = await supabase
      .from('deploy_schedules')
      .update({ status: 'paused' })
      .eq('id', id)
      .select();

    if (error) throw error;

    res.json({ message: '스케줄이 일시 중지되었습니다.', schedule: data[0] });
  } catch (error) {
    console.error('❌ 스케줄 취소 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 스케줄 상태 업데이트 (관리자용)
router.put('/:id/status', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, completedCount, remainingCount } = req.body;

    if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
      return res.status(403).json({ error: '권한이 없습니다.' });
    }

    const updateData = { status };
    if (completedCount !== undefined) updateData.completed_count = completedCount;
    if (remainingCount !== undefined) updateData.remaining_count = remainingCount;

    const { data, error } = await supabase
      .from('deploy_schedules')
      .update(updateData)
      .eq('id', id)
      .select();

    if (error) throw error;

    res.json({ message: '스케줄이 업데이트되었습니다.', schedule: data[0] });
  } catch (error) {
    console.error('❌ 스케줄 업데이트 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
