const { Queue, Worker } = require('bullmq');

// Redis 연결 설정 (자동 재연결, 에러 무시)
const redis = {
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => {
    if (times > 10) return null; // 10회 이후 재시도 중단
    return Math.min(times * 100, 3000); // 지수 백오프
  },
};

// 배포 작업 큐 생성
const deployQueue = new Queue('google-maps-deploy', { connection: redis });

// 큐 이벤트 로깅
deployQueue.on('waiting', (job) => {
  console.log(`📋 Job ${job.id} 대기열에 추가됨 (총 대기: ${job.queue.size})`);
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
