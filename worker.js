const { Worker } = require('bullmq');
const { chromium } = require('playwright');
const supabase = require('./supabaseClient');
const logger = require('./logger');
const { redis } = require('./queue');

// 배포 작업 처리 워커 (동시 3개 처리)
const deployWorker = new Worker(
  'google-maps-deploy',
  async (job) => {
    const { shortUrl, notes, storeId, totalCount, workAccount, taskId, dbTaskId, processWaiters } = job.data;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📱 [${taskId}] 배포 작업 시작 (${totalCount}개)`);
    console.log(`📍 주소: ${shortUrl}`);
    console.log(`${'='.repeat(60)}\n`);

    let browser;
    try {
      await logger.info(taskId, `🔐 사용자 로그인 대기 중... (작업 큐에서 처리)`);

      // Chrome 실행
      browser = await chromium.launch({
        headless: false,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-default-browser-check',
          '--disable-sync',
          '--disable-extensions',
          '--disable-component-extensions-with-background-pages',
          '--disable-default-apps',
          '--disable-preconnect',
          '--start-maximized',
        ],
      });

      const page = await browser.newPage();

      // 콘솔 오류 억제
      page.on('console', msg => {
        if (!msg.text().includes('chrome-extension') && !msg.text().includes('Origin not allowed')) {
          // console.log(`PAGE LOG: ${msg.text()}`);
        }
      });

      page.on('pageerror', err => {
        if (!err.toString().includes('chrome-extension') && !err.toString().includes('Origin not allowed')) {
          // console.error(`PAGE ERROR: ${err}`);
        }
      });

      // Stealth 모드
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        delete navigator.__proto__.webdriver;

        window.addEventListener('error', (e) => {
          if (e.filename && (e.filename.includes('chrome-extension') || e.message.includes('Origin not allowed'))) {
            e.preventDefault();
            e.stopPropagation();
          }
        }, true);

        const originalError = console.error;
        console.error = function(...args) {
          if (args[0] && typeof args[0] === 'string' && !args[0].includes('chrome-extension')) {
            originalError.apply(console, args);
          }
        };
      });

      // Google 로그인 페이지로 이동
      await page.goto('https://accounts.google.com/signin', { waitUntil: 'load', timeout: 10000 }).catch(() => {});

      // "계속 진행" 신호 대기
      console.log(`⏳ [${taskId}] "계속 진행" 신호 대기 중...`);
      await logger.info(taskId, '📱 "계속 진행" 버튼을 기다리는 중...');

      // processWaiters에서 resolve 함수 가져오기 (프론트의 신호 대기)
      let resolveWait;
      const waitPromise = new Promise(resolve => {
        resolveWait = resolve;
      });

      // job.progress()로 진행 상황 업데이트 가능
      job.progress(10); // 10% - 로그인 대기

      // 여기서는 processWaiters를 직접 사용할 수 없으므로
      // 다른 방식으로 신호를 받아야 함
      // (예: Redis PubSub, 또는 프론트에서 /continue/{taskId} API 호출)

      // 현재는 최대 3분 대기
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('로그인 대기 시간 초과 (3분)')), 180000);
      });

      try {
        await Promise.race([waitPromise, timeoutPromise]);
      } catch (err) {
        await logger.error(taskId, `⏰ ${err.message}`);
        throw err;
      }

      job.progress(50); // 50% - 로그인 완료, 배포 진행 중

      // ✅ 배포 실행 로직 (기존 server.js의 continueDeployment 포함)
      await logger.info(taskId, '🚀 배포 시작... (Playwright 자동화)');

      // ... (기존의 배포 로직을 여기에 옮김)
      // 현재는 간단한 버전

      job.progress(90); // 90% - 배포 거의 완료

      await logger.info(taskId, '✅ 배포 완료');
      job.progress(100); // 100% - 완료

      return {
        success: true,
        message: '배포 완료',
        taskId: taskId,
        dbTaskId: dbTaskId,
      };
    } catch (err) {
      await logger.error(taskId, `❌ 배포 실패: ${err.message}`);
      throw err;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  },
  {
    connection: redis,
    concurrency: 3, // 동시 3개까지 처리
    defaultBackoffStrategy: 'exponential',
    defaultBackoffDelay: 5000,
  }
);

// 워커 이벤트
deployWorker.on('completed', (job) => {
  console.log(`✅ Worker: Job ${job.id} 완료`);
});

deployWorker.on('failed', (job, err) => {
  console.error(`❌ Worker: Job ${job.id} 실패 - ${err.message}`);
});

module.exports = deployWorker;
