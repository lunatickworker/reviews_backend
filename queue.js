const { Queue, Worker } = require('bullmq');

// Redis 연결 설정 (조용히 오류 처리)
const redis = {
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
  enableReadyCheck: false,
  retryStrategy: (times) => {
    if (times > 2) return null; // 2회 후 중단
    return 500;
  },
};

// 배포 작업 큐 생성 (에러 무시)
const deployQueue = new Queue('google-maps-deploy', { connection: redis });

// 큐 레벨 에러 이벤트만 처리
deployQueue.on('error', () => {
  // Redis 연결 오류 무시
});

// 큐 이벤트 로깅 (정상 작동만 표시)
deployQueue.on('waiting', (job) => {
  console.log(`📋 Job ${job.id} 대기열에 추가됨`);
});

deployQueue.on('active', (job) => {
  console.log(`🚀 Job ${job.id} 실행 시작`);
});

deployQueue.on('completed', (job) => {
  console.log(`✅ Job ${job.id} 완료`);
});

deployQueue.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} 실패: ${err.message}`);
});

module.exports = { deployQueue, redis };
