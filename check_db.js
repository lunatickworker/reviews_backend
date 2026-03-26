const supabase = require('./supabaseClient');

(async () => {
  console.log('📊 === Supabase 데이터 확인 ===\n');
  
  // 1. deploy_schedules 확인
  const { data: schedules, error: schedError } = await supabase
    .from('deploy_schedules')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  
  console.log('✅ deploy_schedules 테이블:');
  console.log('   에러:', schedError || '없음');
  console.log('   개수:', schedules?.length || 0);
  if (schedules && schedules.length > 0) {
    schedules.forEach((s, i) => {
      console.log(`   [${i+1}] ID: ${s.id}, 매장ID: ${s.store_id}, 상태: ${s.status}, 진행률: ${s.completed_count}/${s.total_count}`);
    });
  }
  
  // 2. tasks 확인
  const { data: tasks, error: taskError } = await supabase
    .from('tasks')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  
  console.log('\n✅ tasks 테이블:');
  console.log('   에러:', taskError || '없음');
  console.log('   개수:', tasks?.length || 0);
  if (tasks && tasks.length > 0) {
    tasks.forEach((t, i) => {
      console.log(`   [${i+1}] ID: ${t.id}, 작업: ${t.place_name}, 상태: ${t.status}`);
    });
  }
  
  process.exit(0);
})();
