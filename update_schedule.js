const supabase = require('./supabaseClient');

async function updateSchedule() {
  try {
    console.log('🔧 스케줄 23 배포 시간 업데이트 중...\n');
    
    // 현재 시간 + 1분
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    const newTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    
    console.log(`⏰ 현재 시간: ${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`);
    console.log(`🎯 새로운 배포 시간: ${newTimeStr}`);
    
    const { data, error } = await supabase
      .from('deploy_schedules')
      .update({
        next_deploy_times: [newTimeStr]
      })
      .eq('id', 23)
      .select();

    if (error) throw error;
    
    console.log(`\n✅ 스케줄 23 업데이트 완료`);
    console.log(`   새로운 배포 시간: ${JSON.stringify(data[0].next_deploy_times)}`);
    console.log(`\n   ${newTimeStr}에 배포가 시작될 예정입니다.`);

  } catch (error) {
    console.error('❌ 오류:', error.message);
  }
  
  process.exit();
}

updateSchedule();
