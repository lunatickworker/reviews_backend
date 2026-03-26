const supabase = require('./supabaseClient');

async function debugSchedule() {
  try {
    console.log('📊 Database 상태 확인 중...\n');
    
    // 1. 모든 스케줄 조회
    const { data: allSchedules, error: err1 } = await supabase
      .from('deploy_schedules')
      .select('*')
      .order('id', { ascending: false });

    if (err1) throw err1;
    
    console.log(`📅 전체 스케줄 개수: ${allSchedules.length}`);
    console.log('📝 최근 스케줄들:');
    allSchedules.slice(0, 5).forEach(s => {
      console.log(`  ID=${s.id}: 상태=${s.status}, store_id=${s.store_id}, next_deploy_times=${JSON.stringify(s.next_deploy_times)}`);
    });

    // 2. 스케줄 23 확인
    console.log('\n🔍 스케줄 23 상세 정보:');
    const { data: schedule23, error: err2 } = await supabase
      .from('deploy_schedules')
      .select('*')
      .eq('id', 23)
      .single();

    if (err2) {
      console.log(`  ❌ 스케줄 23 없음: ${err2.message}`);
    } else {
      console.log(`  ID: ${schedule23.id}`);
      console.log(`  상태: ${schedule23.status}`);
      console.log(`  store_id: ${schedule23.store_id}`);
      console.log(`  daily_frequency: ${schedule23.daily_frequency}`);
      console.log(`  total_count: ${schedule23.total_count}`);
      console.log(`  completed_count: ${schedule23.completed_count}`);
      console.log(`  next_deploy_times: ${JSON.stringify(schedule23.next_deploy_times)}`);
      console.log(`  last_deploy_date: ${schedule23.last_deploy_date}`);
    }

    // 3. 활성 스케줄 확인
    console.log('\n⏱️ 활성 스케줄 확인:');
    const { data: activeSchedules, error: err3 } = await supabase
      .from('deploy_schedules')
      .select('id, status, next_deploy_times, store_id')
      .eq('status', 'active');

    if (err3) throw err3;
    console.log(`  활성 스케줄 개수: ${activeSchedules.length}`);
    activeSchedules.forEach(s => {
      console.log(`    ID=${s.id}: next_deploy_times=${JSON.stringify(s.next_deploy_times)}`);
    });

    // 4. 현재 시간
    console.log('\n⏰ 현재 시간:');
    const now = new Date();
    console.log(`  서버 시간: ${now.toLocaleString('ko-KR')} (${now.toISOString()})`);
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    console.log(`  HH:MM format: ${timeStr}`);

  } catch (error) {
    console.error('❌ 오류:', error.message);
  }
  
  process.exit();
}

debugSchedule();
