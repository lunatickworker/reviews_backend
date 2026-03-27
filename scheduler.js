const supabase = require('./supabaseClient');
const logger = require('./logger');
const axios = require('axios');

/**
 * 백그라운드 스케줄러
 * - 매일 자정(00:00)에 활성 스케줄 확인
 * - dailyFrequency만큼 랜덤 시간 예약
 * - 예약된 시간에 자동으로 배포 실행
 */

// 🎯 배포 실행 함수 (실제 Playwright 자동화 호출)
async function executePlaywrightDeploy(storeData, schedule) {
  try {
    console.log(`[Scheduler] 🎬 Playwright 배포 시작: ${storeData.store_name}`);
    console.log(`[Scheduler] 🔍 storeData columns:`, Object.keys(storeData));
    console.log(`[Scheduler] 📝 storeData:`, JSON.stringify(storeData, null, 2));

    // 매장의 Google Maps 링크 가져오기 (address 컬럼에 저장됨)
    const shortUrl = storeData.address || storeData.map_short_url || storeData.google_maps_link;
    console.log(`[Scheduler] 🔗 shortUrl 시도: address=${storeData.address}, map_short_url=${storeData.map_short_url}, google_maps_link=${storeData.google_maps_link}`);
    console.log(`[Scheduler] ⚡ 최종 shortUrl:`, shortUrl);
    
    if (!shortUrl) {
      console.error(`[Scheduler] ❌ 매장 링크 없음: ${storeData.store_name}`);
      return;
    }
    
    console.log(`[Scheduler] ✅ 매장 링크 확인됨: ${shortUrl}`);

    // 로컬 서버의 deploy-internal 엔드포인트 호출
    const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';

    console.log(`[Scheduler] 🔗 배포 엔드포인트 호출: ${baseUrl}/api/deploy-internal`);

    const response = await axios.post(
      `${baseUrl}/api/deploy-internal`,
      {
        shortUrl: shortUrl,
        notes: storeData.review_message || '',
        storeId: storeData.id,
        userId: schedule.user_id,  // 스케줄 생성자 ID
      },
      {
        timeout: 10000,
      }
    );

    if (response.data.success) {
      console.log(`[Scheduler] ✅ Playwright 배포 요청 완료: taskId=${response.data.taskId}`);
      console.log(`[Scheduler] 📊 응답:`, response.data);
      
      // ✅ 진행률 업데이트 (배포 요청이 성공했으므로 completed_count 증가)
      const completedCount = (schedule.completed_count || 0) + 1;
      const remainingCount = Math.max(0, schedule.total_count - completedCount);
      
      let newStatus = schedule.status;
      if (remainingCount === 0) {
        newStatus = 'completed';
        console.log(`[Scheduler] 🎉🎉🎉 스케줄 완료!!! ID=${schedule.id}`);
      }

      await supabase
        .from('deploy_schedules')
        .update({
          completed_count: completedCount,
          remaining_count: remainingCount,
          status: newStatus,
        })
        .eq('id', schedule.id);

      console.log(`[Scheduler] 📊 진행률 UPDATE: ${completedCount}/${schedule.total_count} (남음: ${remainingCount}회)`);
    } else {
      console.warn(`[Scheduler] ⚠️ Playwright 배포 응답 (성공 아님):`, response.data.message);
    }
    
  } catch (error) {
    console.error(`[Scheduler] ❌ Playwright 배포 오류: ${error.message}`);
  }
}

// 랜덤 시간 생성 (00:00 ~ 23:59)
function generateRandomTimes(count) {
  const times = [];
  while (times.length < count) {
    const hour = Math.floor(Math.random() * 24);
    const minute = Math.floor(Math.random() * 60);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (!times.includes(timeStr)) {
      times.push(timeStr);
    }
  }
  return times.sort();
}

// 랜덤 시간 생성 (24시간 범위)
function generateNextDeployTimes(dailyFrequency) {
  const times = [];
  while (times.length < dailyFrequency) {
    const hour = Math.floor(Math.random() * 24);
    const minute = Math.floor(Math.random() * 60);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (!times.includes(timeStr)) {
      times.push(timeStr);
    }
  }
  return times.sort();
}

/**
 * 매일 자정에 실행: 활성 스케줄들의 예약 시간 생성
 */
async function refreshDailySchedules() {
  try {
    console.log('[Scheduler] 📅 일일 스케줄 갱신 시작...');

    // 1. 상태가 active이고 로컬 시간이 자정인 스케줄 조회
    const { data: schedules, error } = await supabase
      .from('deploy_schedules')
      .select('*')
      .eq('status', 'active');

    if (error) throw error;

    if (!schedules || schedules.length === 0) {
      console.log('[Scheduler] ℹ️ 진행 중인 스케줄이 없습니다.');
      return;
    }

    // 2. 각 스케줄에 대해 오늘 배포 시간 확인
    const today = new Date().toISOString().split('T')[0];

    for (const schedule of schedules) {
      const lastDeployDate = schedule.last_deploy_date;
      
      // 오늘 이미 배포했으면 스킵
      if (lastDeployDate === today) {
        console.log(`[Scheduler] ✅ ${schedule.id}: 오늘 이미 처리됨`);
        continue;
      }

      // 3. dailyFrequency만큼 랜덤 시간 생성
      const dailyFreq = schedule.daily_frequency || 1;
      const deployTimes = generateRandomTimes(dailyFreq);

      // 4. next_deploy_times 업데이트
      await supabase
        .from('deploy_schedules')
        .update({
          next_deploy_times: deployTimes,
          last_deploy_date: today,
        })
        .eq('id', schedule.id);

      console.log(
        `[Scheduler] 📌 ${schedule.id}: 오늘 배포 시간 설정 - ${deployTimes.join(', ')}`
      );
    }

    console.log('[Scheduler] ✅ 일일 스케줄 갱신 완료');
  } catch (error) {
    console.error('[Scheduler] ❌ 일일 스케줄 갱신 오류:', error);
  }
}

/**
 * 매분 실행: 예약된 시간에 도달한 작업 실행
 */
async function executeScheduledDeploys() {
  try {
    const { data: schedules, error } = await supabase
      .from('deploy_schedules')
      .select('*')
      .eq('status', 'active');

    if (error) throw error;
    if (!schedules || schedules.length === 0) return;

    const now = new Date();
    const currentHour = String(now.getHours()).padStart(2, '0');
    const currentMinute = String(now.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${currentHour}:${currentMinute}`;
    
    console.log(`[Scheduler] ⏰ 현재 시간: ${currentTimeStr}`);

    for (const schedule of schedules) {
      const deployTimes = schedule.next_deploy_times || [];
      
      if (deployTimes.length === 0) {
        console.log(`[Scheduler] ℹ️ ${schedule.id}: 예약된 배포 시간 없음`);
        continue;
      }

      console.log(`[Scheduler] 📌 ${schedule.id}: 예약 시간 = [${deployTimes.join(', ')}]`);
      
      // 예약된 각 시간 확인
      for (const timeStr of deployTimes) {
        // ✅ 시간:분이 같거나, 이미 지났으면 즉시 실행
        const [scheduledHour, scheduledMin] = timeStr.split(':').map(Number);
        const scheduledTime = scheduledHour * 60 + scheduledMin;
        const currentTime = now.getHours() * 60 + now.getMinutes();
        
        // 배포 시간이 도달했거나 지난 경우 (자신의 배포 시간 ± 1분 범위)
        const isTimeReached = Math.abs(currentTime - scheduledTime) <= 1;
        
        if (!isTimeReached) continue;

        console.log(`[Scheduler] 🚀🚀🚀 ${schedule.id}: ${timeStr} 배포 시작!`);

        try {
          // 매장 정보 조회
          const { data: storeData } = await supabase
            .from('stores')
            .select('*')
            .eq('id', schedule.store_id)
            .single();

          if (!storeData) {
            console.warn(`[Scheduler] ⚠️ 매장 없음: ${schedule.store_id}`);
            continue;
          }

          console.log(`[Scheduler] ✅ 매점 정보 조회: ${storeData.store_name}`);
          console.log(`[Scheduler] 📊 Store columns:`, Object.keys(storeData));
          console.log(`[Scheduler] 🔗 address 값:`, storeData.address);
          console.log(`[Scheduler] 📝 전체 storeData:`, JSON.stringify(storeData, null, 2));
          
          // 배포된 시간 제거 (즉시)
          const updatedDeployTimes = schedule.next_deploy_times.filter(t => t !== timeStr);
          
          // 📌 일단 schedule 업데이트 (Playwright 배포는 백그라운드에서 진행)
          await supabase
            .from('deploy_schedules')
            .update({
              next_deploy_times: updatedDeployTimes,
              last_deploy_date: new Date().toISOString().split('T')[0],
            })
            .eq('id', schedule.id);

          console.log(`[Scheduler] 📌 예약 시간 제거 완료: [${updatedDeployTimes.join(', ')}]`);

          // 🎬 Playwright 배포 비동기 실행 (블로킹 안 함)
          executePlaywrightDeploy(storeData, schedule).catch(err => {
            console.error(`[Scheduler] ⚠️ Playwright 배포 오류:`, err.message);
          });

          console.log(`[Scheduler] 🚀 Playwright 배포 시작됨 (백그라운드)`);
        } catch (deployError) {
          console.error(`[Scheduler] ❌ 배포 실행 오류:`, deployError);
        }
      }
    }
  } catch (error) {
    console.error('[Scheduler] ❌ 배포 실행 오류:', error);
  }
}

/**
 * 스케줄러 초기화
 */
function initScheduler() {
  console.log('[Scheduler] 🔧 스케줄러 초기화...');

  // 매일 자정(00:00)에 일일 스케줄 갱신
  // 예: 00:00, 00:01, 00:02 중 가장 빠른 시간에 실행
  const checkDailyRefresh = setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      refreshDailySchedules();
    }
  }, 60000); // 1분마다 확인

  // 매분 배포 시간 확인 및 실행
  const executeInterval = setInterval(executeScheduledDeploys, 60000); // 1분마다 실행

  // 백그라운드에서 즉시 실행 (앱 시작 시)
  refreshDailySchedules();
  executeScheduledDeploys();

  console.log(`[Scheduler] ✅ 스케줄러 시작! (현재 시간: ${new Date().toLocaleTimeString()})`);
  console.log('[Scheduler] 📅 일일 갱신: 매일 00:00');
  console.log('[Scheduler] 🚀 배포 확인: 매분 00초');

  return { checkDailyRefresh, executeInterval };
}

module.exports = {
  initScheduler,
  refreshDailySchedules,
  executeScheduledDeploys,
};
