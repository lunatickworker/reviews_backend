// backend/server.js
const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
require('dotenv').config();

// 작업 큐 import
const { deployQueue } = require('./queue');
const deployWorker = require('./worker');

// 라우트 import
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const storeRoutes = require('./routes/stores');
const taskRoutes = require('./routes/tasks');
const reviewRoutes = require('./routes/reviews');
const authMiddleware = require('./auth-middleware');
const logger = require('./logger');
const supabase = require('./supabaseClient');

const app = express();
app.use(express.json());

// CORS 설정 - 로컬 및 Vercel 배포된 프론트엔드 허용
const corsOptions = {
  origin: [
    'http://localhost:3000',                    // 로컬 개발
    'http://localhost:3001',                    // 대체 포트
    /https:\/\/.*\.vercel\.app$/,              // Vercel 배포 도메인
  ],
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// ✅ 프로세스 진행 신호 대기 (taskId → Promise)
const processWaiters = new Map();

// ✅ 배포 동시성 제어 (최대 5개까지 동시 실행)
const CONCURRENT_DEPLOYS = 5;
const activeDeployments = new Map(); // taskId → deployment promise
const deploymentQueue = []; // 대기 중인 배포 요청 큐

// 배포 시작 (동시성 제어)
const startDeployment = async (taskId, deployFn) => {
  try {
    // 활성 배포가 제한 수 이하일 때까지 대기
    while (activeDeployments.size >= CONCURRENT_DEPLOYS) {
      await new Promise(resolve => setTimeout(resolve, 100)); // 100ms 대기
    }

    console.log(`🚀 [${taskId}] 배포 시작 (활성: ${activeDeployments.size + 1}/${CONCURRENT_DEPLOYS})`);

    // 배포 실행 및 추적
    const deployPromise = deployFn()
      .finally(() => {
        activeDeployments.delete(taskId);
        console.log(`✅ [${taskId}] 배포 완료 (활성: ${activeDeployments.size}/${CONCURRENT_DEPLOYS})`);
      });

    activeDeployments.set(taskId, deployPromise);
    return await deployPromise;
  } catch (err) {
    activeDeployments.delete(taskId);
    throw err;
  }
};

// 사용자 데이터 디렉토리 (쿠키/세션 저장)
const userDataDir = path.join(__dirname, '.auth');
if (!fs.existsSync(userDataDir)) {
  fs.mkdirSync(userDataDir, { recursive: true });
}

// API 라우트
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/reviews', reviewRoutes);
const logRoutes = require('./routes/logs');
app.use('/api/logs', logRoutes);
const accountRoutes = require('./routes/accounts');
app.use('/api/accounts', accountRoutes);

// Supabase Storage에 스크린샷 업로드
async function uploadScreenshot(screenshotBuffer, taskId, dbTaskId) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `screenshots/${dbTaskId}_${timestamp}.png`;
    
    const { data, error } = await supabase.storage
      .from('reviews')
      .upload(fileName, screenshotBuffer, {
        contentType: 'image/png',
        upsert: false,
      });

    if (error) {
      console.log(`[${taskId}] ⚠️ 스크린샷 업로드 실패: ${error.message}`);
      await logger.warn(taskId, `⚠️ 스크린샷 업로드 실패: ${error.message}`);
      return null;
    }

    // 공개 URL 생성
    const { data: urlData } = supabase.storage
      .from('reviews')
      .getPublicUrl(fileName);

    const screenshotUrl = urlData?.publicUrl;
    
    if (screenshotUrl) {
      // DB에 스크린샷 URL 저장
      await supabase
        .from('tasks')
        .update({ screenshot_url: screenshotUrl })
        .eq('id', dbTaskId);

      console.log(`[${taskId}] ✅ 스크린샷 업로드 완료: ${screenshotUrl}`);
      await logger.info(taskId, `✅ 스크린샷 저장 완료`);
      return screenshotUrl;
    }
  } catch (error) {
    console.log(`[${taskId}] ⚠️ 스크린샷 처리 오류: ${error.message}`);
    await logger.warn(taskId, `⚠️ 스크린샷 처리 오류: ${error.message}`);
  }
  return null;
}

// 🔧 내부 배포 엔드포인트 (scheduler용 - 인증 불필요)
app.post('/api/deploy-internal', async (req, res) => {
  const { shortUrl, notes, storeId, userId } = req.body;
  if (!shortUrl) {
    return res.status(400).json({ error: 'shortUrl is required' });
  }

  // 기본값 설정
  const totalCount = 1;
  let browser;

  try {
    // 1. store 정보 조회
    let placeName = '로딩 중...';
    const assignedUserId = userId || 'scheduler';
    
    if (storeId) {
      const { data: storeData } = await supabase
        .from('stores')
        .select('id, store_name')
        .eq('id', storeId)
        .single();
      
      if (storeData && storeData.store_name) {
        placeName = storeData.store_name;
      }
    }
    
    // 2. Task 생성
    const tasksToInsert = [{
      place_name: placeName,
      status: 'in_progress',
      review_status: 'pending',
      image_status: 'pending',
      current_step: '시작',
      notes: notes ? notes.trim() : '',
      store_id: storeId || null,
      user_id: assignedUserId,
      created_at: new Date().toISOString(),
    }];

    const { data: taskDataArray, error: taskError } = await supabase
      .from('tasks')
      .insert(tasksToInsert)
      .select();

    if (taskError) {
      console.error('❌ Task 생성 오류:', taskError);
      return res.status(500).json({ error: 'Task 생성 실패' });
    }

    const dbTaskId = taskDataArray[0].id;
    const taskId = `task_${dbTaskId}`;
    
    // Task ID 업데이트
    await supabase
      .from('tasks')
      .update({ task_id: taskId })
      .eq('id', dbTaskId);

    console.log(`📋 [내부 배포] Task 생성: ${taskId}, 매장: ${placeName}, 사용자: ${assignedUserId}`);
    await logger.info(taskId, `📋 스케줄된 배포 시작: ${placeName}`);
    
    // 랜덤 Google 계정 선택
    const account = getRandomAccount();
    
    // 작업 계정은 호출 측에서 전달된 값을 사용하고, 없으면 미지정으로 유지
    const explicitWorkAccount = req.body.workAccount?.trim() || null;
    if (explicitWorkAccount) {
      await supabase
        .from('tasks')
        .update({ work_account: explicitWorkAccount })
        .eq('id', dbTaskId);
      await logger.info(taskId, `작업 계정 설정(명시): ${explicitWorkAccount}`);
    }

    await logger.info(taskId, `사용 계정 (로그인용): ${account.email}`);

    // 프로필 디렉토리 설정
    const profileDir = path.join(
      process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'),
      'Playwright', 'google-maps-profiles'
    );
    
    const safeEmail = account.email.replace(/[^a-z0-9]/gi, '_');
    const profilePath = path.join(profileDir, safeEmail);
    
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }

    const isFirstLogin = !fs.existsSync(path.join(profilePath, 'Default'));
    
    if (isFirstLogin) {
      await logger.warn(taskId, '⚠️ 첫 로그인 - 수동 로그인 필요');
      console.log(`[${taskId}] ⚠️ 첫 로그인 감지 - 스케줄 배포 스킵`);
      
      // 첫 로그인이면 스킵
      await supabase
        .from('tasks')
        .update({ 
          status: 'pending',
          current_step: '로그인 필요'
        })
        .eq('id', dbTaskId);
      
      return res.json({
        success: false,
        message: '첫 로그인 필요 - 스케줄 배포 스킵',
        taskId: taskId
      });
    }

    // Chrome 실행
    browser = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      channel: 'chrome',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-preconnect',
      ],
    });

    const page = browser.pages()[0] || await browser.newPage();

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

    console.log(`[${taskId}] 📱 저장된 세션으로 브라우저 오픈`);
    await logger.info(taskId, '📱 저장된 세션으로 브라우저 오픈');

    // 백그라운드에서 자동화 처리
    backgroundTask(page, shortUrl, notes, account.email, browser, profilePath, userId, taskId, storeId);

    res.json({
      success: true,
      message: '🎬 스케줄된 배포 시작됨',
      taskId: taskId,
      usedAccount: account.email
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('❌ 내부 배포 오류:', error);
    res.status(500).json({ error: error.message });
  }
});

// 리뷰 배포 API (admin만 요청 가능) - 권한 체계 추가
app.post('/api/automate-map', authMiddleware, async (req, res) => {
  // admin 권한 확인
  if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
    return res.status(403).json({ error: 'admin 권한이 필요합니다.' });
  }

  const { shortUrl, notes, storeId, totalCount = 1, workAccount: explicitWorkAccount = '' } = req.body;
  if (!shortUrl) return res.status(400).json({ error: 'shortUrl is required' });

  let browser;
  try {
    // 1. store 정보 조회 (storeId가 있으면)
    let placeName = '로딩 중...';
    let storeTotalCount = totalCount;
    
    if (storeId) {
      const { data: storeData } = await supabase
        .from('stores')
        .select('store_name, total_count')
        .eq('id', storeId)
        .single();
      
      if (storeData && storeData.store_name) {
        placeName = storeData.store_name;
      }
      
      if (storeData && storeData.total_count) {
        storeTotalCount = storeData.total_count;
      }
      
      // ✅ 현재발행수 확인
      const { data: completedTasks } = await supabase
        .from('tasks')
        .select('completed_count')
        .eq('store_id', storeId);
      
      const currentCount = (completedTasks || []).reduce((sum, task) => sum + (task.completed_count || 0), 0);
      
      // ✅ 총발행 초과 체크
      if (currentCount >= storeTotalCount) {
        return res.status(400).json({ 
          error: `❌ 이미 총발행수(${storeTotalCount})에 도달했습니다.\n현재발행수: ${currentCount} / ${storeTotalCount}`
        });
      }
    }
    
    // 2. totalCount만큼 tasks 생성
    const taskIds = [];
    const tasksToInsert = [];
    
    for (let i = 0; i < Math.max(1, totalCount); i++) {
      tasksToInsert.push({
        place_name: placeName,
        status: i === 0 ? 'in_progress' : 'pending',     // 첫 번째만 진행중, 나머지는 대기
        review_status: 'pending',
        image_status: 'pending',
        current_step: i === 0 ? '시작' : '대기중',
        notes: notes ? notes.trim() : '',
        store_id: storeId || null,  // ✅ 매장 ID 저장
        user_id: req.user.id,
        work_account: explicitWorkAccount?.trim() || null,
        created_at: new Date().toISOString(),
      });
    }

    const { data: taskDataArray, error: taskError } = await supabase
      .from('tasks')
      .insert(tasksToInsert)
      .select();

    if (taskError) {
      console.error('❌ 작업 생성 오류:', taskError);
      return res.status(500).json({ error: '작업 생성에 실패했습니다.' });
    }

    // 첫 번째 task만 Playwright로 실행
    const dbTaskId = taskDataArray[0].id;
    const taskId = `task_${dbTaskId}`;
    
    // 모든 task의 task_id 업데이트
    for (let i = 0; i < taskDataArray.length; i++) {
      const dataTaskId = `task_${taskDataArray[i].id}`;
      await supabase
        .from('tasks')
        .update({ task_id: dataTaskId })
        .eq('id', taskDataArray[i].id);
    }

    console.log(`📋 ${totalCount}개 작업 생성됨: 첫 번째 ID=${dbTaskId}, taskId=${taskId}`);
    console.log(`📝 Notes: "${notes ? notes.trim() : '(없음)'}"`);
    await logger.info(taskId, `배포 시작: ${totalCount}개 작업 생성, shortUrl=${shortUrl}`, { user: req.user.id, totalCount });
    if (notes) {
      await logger.info(taskId, `📝 메모: ${notes}`);
    }

    // Chrome 실행 (깨끗한 상태 - 저장된 프로필 사용 안함)
    console.log(`${'='.repeat(60)}`);
    console.log(`📱 [${taskId}] 🔐 어느 Google 계정으로든 로그인하세요!`);
    console.log(`📍 매장 주소: ${shortUrl}`);
    console.log(`📲 로그인 후에 "계속 진행"을 클릭해주세요.`);
    console.log(`${'='.repeat(60)}\n`);

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

    // 콘솔 오류 억제 (확장 오류 무시)
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

    // Stealth 모드 - Automation 감지 회피 + 확장 오류 억제
    await page.addInitScript(() => {
      // Automation 감지 회피
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      delete navigator.__proto__.webdriver;

      // 확장 오류 전역 억제
      window.addEventListener('error', (e) => {
        if (e.filename && (e.filename.includes('chrome-extension') || e.message.includes('Origin not allowed'))) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);

      // console 오류 필터링
      const originalError = console.error;
      console.error = function(...args) {
        if (args[0] && typeof args[0] === 'string' && !args[0].includes('chrome-extension')) {
          originalError.apply(console, args);
        }
      };
    });

    // ✅ 로그인 대기: 매번 깨끗한 상태에서 시작하므로 항상 사용자 로그인 필요
    await logger.info(taskId, '🔐 수동 로그인 필요');
    await logger.info(taskId, '📍 Google 계정으로 로그인하세요');
    await logger.info(taskId, '📲 로그인 완료 후 "계속 진행" 버튼을 클릭해주세요');

    // Google 로그인 페이지로 이동
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'load', timeout: 10000 }).catch(() => {});

    // ✅ 사용자가 "계속 진행" 또는 "취소"를 클릭할 때까지 대기
    console.log(`⏳ [${taskId}] 사용자 입력 대기 중...`);
    await logger.info(taskId, '📱 "계속 진행" 또는 "취소" 버튼을 기다리는 중...');

    // Promise 생성 및 저장
    let resolveWait;
    const waitPromise = new Promise(resolve => {
      resolveWait = resolve;
    });
    processWaiters.set(taskId, resolveWait);

    // ✅ 응답을 먼저 보냄!
    const userEmail = explicitWorkAccount?.trim() || req.user.id || 'unknown';
    res.json({
      placeName: '로딩 중...',
      message: `✅ 자동화 시작됨 (${totalCount}개 작업 생성). 브라우저에서 리뷰를 작성해주세요. (2분 후 자동 종료)`,
      usedAccount: userEmail,
      workAccount: explicitWorkAccount?.trim() || null,
      taskId: taskId,
      dbTaskId: dbTaskId,
      totalCount: totalCount,
      createdTasks: totalCount
    });

    // ✅ 그 다음에 대기
    const result = await waitPromise;
    processWaiters.delete(taskId);

    if (result === 'cancel') {
      await browser.close();
      await logger.warn(taskId, '사용자가 취소함');
      await logger.updateStatus(taskId, { status: 'cancelled', review_status: 'pending' });
      return;
    }

    console.log(`✅ [${taskId}] 계속 진행!`);
    await logger.info(taskId, '✅ 프로세스 진행!');

    // ✅ 계속 진행 신호 받은 후 자동화 시작!
    await backgroundTask(page, shortUrl, notes, userEmail, browser, null, req.user.id, taskId, storeId);

  } catch (error) {
    if (browser) await browser.close();
    console.error('❌ 에러:', error);
    res.status(500).json({ error: error.message });
  }
});

// 백그라운드에서 자동화 작업 처리
async function backgroundTask(page, shortUrl, notes, email, browser, tempDir, userId, taskId, storeId) {
  try {
    // dbTaskId 추출 (taskId 형식: "task_105")
    const dbTaskId = parseInt(taskId.split('_')[1]);
    
    // 작업 상태 초기화
    await logger.updateStatus(taskId, {
      status: 'in_progress',
      review_status: 'in_progress',
      current_step: '브라우저 오픈'
    });
    
    // 1. 단축 URL 열기
    console.log(`\n[${taskId}] 📱 브라우저 오픈`);
    await logger.info(taskId, '📱 브라우저 오픈');
    await logger.info(taskId, `🔗 URL 접속: ${shortUrl}`);
    await page.goto(shortUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {
      console.log(`[${taskId}] ⚠️ URL 로드 완료되지 않았지만 계속 진행`);
      logger.warn(taskId, 'URL 로드 완료되지 않았지만 계속 진행');
    });

    // 로그인 페이지로 리다이렉트된 경우 감지
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
      console.log(`[${taskId}] 🔐 로그인 필요 (60초 대기)`);
      await logger.warn(taskId, '🔐 로그인이 필요합니다. 60초 동안 기다리는 중...');
      
      const startTime = Date.now();
      const timeout = 60000;
      let loggedIn = false;

      while (Date.now() - startTime < timeout) {
        try {
          const url = page.url();
          if (!url.includes('accounts.google.com') && !url.includes('signin')) {
            loggedIn = true;
            console.log(`[${taskId}] ✅ 로그인 완료`);
            await logger.info(taskId, '✅ 로그인 감지! Maps로 이동 중...');
            await page.waitForTimeout(2000);
            break;
          }
        } catch (e) {
          // 무시
        }
        await page.waitForTimeout(1000);
      }

      if (!loggedIn) {
        console.log(`[${taskId}] ❌ 로그인 시간 초과`);
        await logger.error(taskId, '❌ 로그인 시간 초과');
        await logger.updateStatus(taskId, {
          status: 'failed',
          review_status: 'failed',
          current_step: '로그인 실패'
        });
        return;
      }
    } else {
      console.log(`[${taskId}] ✅ 이미 로그인됨`);
      await logger.info(taskId, '✅ 저장된 세션으로 자동 로그인됨');
    }

    // 2. 최종 URL 파싱
    const finalUrl = page.url();
    const urlObj = new URL(finalUrl);
    const paths = urlObj.pathname.split('/').filter(Boolean);
    const placeNameEncoded = paths[2] || '';
    const placeName = decodeURIComponent(placeNameEncoded.replace(/\+/g, ' '));
    console.log(`[${taskId}] 🏠 장소명: ${placeName}`);
    await logger.info(taskId, `🏠 장소명: ${placeName}`);
    
    // DB에 최종 장소명 업데이트
    await logger.updateStatus(taskId, { place_name: placeName });

    // 3. 리뷰 탭 클릭
    console.log(`[${taskId}] 💬 리뷰 탭 클릭 중...`);
    await logger.updateStatus(taskId, { current_step: '리뷰 탭 클릭' });
    await logger.info(taskId, '💬 리뷰 탭 찾기...');
    await page.waitForTimeout(2000);
    
    let reviewTabClicked = false;
    try {
      const selectors = [
        'button[aria-label*="Reviews"]',
        'button[aria-label*="리뷰"]',
        'button[jsaction*="reviews"]',
        'button[jsaction*="pane.review"]',
        'div[role="button"][aria-label*="Reviews"]',
        'div[role="button"][aria-label*="리뷰"]',
      ];

      for (const selector of selectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            await element.click();
            reviewTabClicked = true;
            console.log(`[${taskId}] ✅ 리뷰 탭 클릭 완료`);
            await logger.info(taskId, '✅ 리뷰 탭 클릭 완료');
            await page.waitForTimeout(1500);
            break;
          }
        } catch (e) {
          // 무시
        }
      }

      if (!reviewTabClicked) {
        const allButtons = await page.$$('button');
        for (const btn of allButtons) {
          const text = await btn.textContent();
          if (text && (text.includes('Reviews') || text.includes('리뷰'))) {
            await btn.click();
            reviewTabClicked = true;
            console.log(`[${taskId}] ✅ 리뷰 탭 클릭 완료`);
            await logger.info(taskId, '✅ 리뷰 탭 클릭 완료');
            await page.waitForTimeout(1500);
            break;
          }
        }
      }

      if (!reviewTabClicked) {
        console.log(`[${taskId}] ⚠️ 리뷰 탭을 찾지 못함 (계속 진행)`);
        await logger.warn(taskId, '⚠️ 리뷰 탭을 찾지 못함 (계속 진행)');
      }
    } catch (e) {
      console.log(`[${taskId}] ⚠️ 리뷰 탭 클릭 오류: ${e.message}`);
      await logger.warn(taskId, `⚠️ 리뷰 탭 클릭 오류: ${e.message}`);
    }

    // 4. "리뷰 작성" 버튼 클릭
    console.log(`[${taskId}] ✍️ 리뷰 작성 버튼 클릭 중...`);
    await logger.updateStatus(taskId, { current_step: '리뷰 작성 버튼 클릭' });
    await logger.info(taskId, '✍️ 리뷰 작성 버튼 찾기...');
    
    let writeReviewClicked = false;
    try {
      await page.waitForTimeout(1000);
      
      const writeReviewSelectors = [
        'button[jsname="fk8dgd"]',
        'button[aria-label*="Write a review"]',
        'button[aria-label*="리뷰 작성"]',
        'div[role="button"][aria-label*="Write a review"]',
        'div[role="button"][aria-label*="리뷰 작성"]',
      ];

      for (const selector of writeReviewSelectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            await element.click();
            writeReviewClicked = true;
            console.log(`[${taskId}] ✅ 리뷰 작성 버튼 클릭 완료`);
            await logger.info(taskId, '✅ 리뷰 작성 버튼 클릭 완료');
            await page.waitForTimeout(1500);
            break;
          }
        } catch (e) {
          // 무시
        }
      }

      if (!writeReviewClicked) {
        const allButtons = await page.$$('button, div[role="button"]');
        for (const btn of allButtons) {
          const text = await btn.textContent();
          if (text && (text.includes('Write a review') || text.includes('리뷰 작성'))) {
            await btn.click();
            writeReviewClicked = true;
            console.log(`[${taskId}] ✅ 리뷰 작성 버튼 클릭 완료`);
            await logger.info(taskId, '✅ 리뷰 작성 버튼 클릭 완료');
            await page.waitForTimeout(2000);
            
            // 📊 페이지 상태 저장 (디버깅용)
            try {
              const htmlContent = await page.content();
              const fs = require('fs');
              const logPath = `${tempDir}/form_page_html_${taskId}.html`;
              fs.writeFileSync(logPath, htmlContent);
              console.log(`[${taskId}] 💾 페이지 HTML 저장됨: ${logPath}`);
              
              // 페이지의 모든 input, textarea, contenteditable 요소 로깅
              const elementInfo = await page.evaluate(() => {
                const info = {
                  textareas: document.querySelectorAll('textarea').length,
                  inputs: document.querySelectorAll('input[type="text"]').length,
                  editables: document.querySelectorAll('[contenteditable="true"]').length,
                  iframes: document.querySelectorAll('iframe').length,
                  divs_with_role_textbox: document.querySelectorAll('div[role="textbox"]').length,
                  all_textareas: Array.from(document.querySelectorAll('textarea')).map(el => ({
                    class: el.className,
                    id: el.id,
                    placeholder: el.placeholder,
                    ariaLabel: el.getAttribute('aria-label')
                  })),
                  all_inputs: Array.from(document.querySelectorAll('input[type="text"]')).map(el => ({
                    class: el.className,
                    id: el.id,
                    placeholder: el.placeholder,
                    ariaLabel: el.getAttribute('aria-label')
                  }))
                };
                return info;
              });
              console.log(`[${taskId}] 📋 페이지 요소 정보:`, JSON.stringify(elementInfo, null, 2));
            } catch (saveError) {
              console.log(`[${taskId}] ⚠️ 페이지 HTML 저장 오류: ${saveError.message}`);
            }
            
            break;
          }
        }
      }

      if (writeReviewClicked) {
        // ✅ 리뷰 모달 열린 후, .Af21Ie 요소 (작업 계정) 파싱
        console.log(`[${taskId}] 🔍 작업 계정 파싱 중...`);
        await logger.info(taskId, '🔍 작업 계정 파싱 중...');
        
        // 모달이 완전히 로드될 때까지 대기
        await page.waitForTimeout(3000);
        
        let workAccountValue = null;
        let retries = 0;
        const maxRetries = 5;
        
        while (!workAccountValue && retries < maxRetries) {
          try {
            workAccountValue = await page.evaluate(() => {
              // iframe 포함해서 모든 document 검사
              function findInFrames(selector) {
                const search = (doc) => {
                  const el = doc.querySelector(selector);
                  if (el) return el;
                  const iframes = Array.from(doc.querySelectorAll('iframe'));
                  for (const iframe of iframes) {
                    try {
                      const childDoc = iframe.contentDocument || iframe.contentWindow?.document;
                      if (!childDoc) continue;
                      const found = search(childDoc);
                      if (found) return found;
                    } catch (e) {
                      continue;
                    }
                  }
                  return null;
                };
                return search(document);
              }
              
              const el = findInFrames('.Af21Ie');
              return el?.textContent?.trim() || null;
            });
            
            if (!workAccountValue) {
              console.log(`[${taskId}] ⏳ 작업 계정 대기중... (시도 ${retries + 1}/${maxRetries})`);
              await page.waitForTimeout(1000);
              retries++;
            }
          } catch (parseError) {
            console.log(`[${taskId}] ⚠️ 파싱 시도 오류: ${parseError.message}`);
            await page.waitForTimeout(1000);
            retries++;
          }
        }
        
        if (workAccountValue) {
          console.log(`[${taskId}] ✅ 작업 계정 파싱 성공: ${workAccountValue}`);
          await logger.info(taskId, `✅ 작업 계정 파싱 성공: ${workAccountValue}`);
          
          // localStorage에 저장
          await page.evaluate((account) => {
            try {
              localStorage.setItem('detectedWorkAccount', account);
              console.log('✅ localStorage에 저장됨:', account);
            } catch (e) {
              console.log('⚠️ localStorage 저장 실패:', e);
            }
          }, workAccountValue);
          
          // ✅ DB tasks.work_account 업데이트
          try {
            // taskId에서 DB id 추출 ("task_96" → 96)
            const dbId = parseInt(taskId.split('_')[1]);
            
            const { error: updateError } = await supabase
              .from('tasks')
              .update({ work_account: workAccountValue })
              .eq('id', dbId);
            
            if (updateError) {
              console.log(`[${taskId}] ⚠️ DB 업데이트 오류: ${updateError.message}`);
              await logger.warn(taskId, `⚠️ DB work_account 업데이트 실패: ${updateError.message}`);
            } else {
              console.log(`[${taskId}] 💾 DB work_account 업데이트 완료: ${workAccountValue}`);
              await logger.info(taskId, `💾 DB work_account 업데이트 완료: ${workAccountValue}`);
            }
          } catch (dbError) {
            console.log(`[${taskId}] ⚠️ DB 업데이트 중 에러: ${dbError.message}`);
            await logger.warn(taskId, `⚠️ DB 업데이트 중 에러: ${dbError.message}`);
          }
        } else {
          console.log(`[${taskId}] ⚠️ 작업 계정을 찾지 못함 (.Af21Ie) - ${maxRetries}회 재시도 후`);
          await logger.warn(taskId, '⚠️ 작업 계정을 찾지 못함 - 재시도 완료');
        }
      }
    } catch (e) {
      console.log(`[${taskId}] ⚠️ 리뷰 작성 버튼 오류: ${e.message}`);
      await logger.warn(taskId, `⚠️ 리뷰 작성 버튼 오류: ${e.message}`);
    }

    // 5. 텍스트 입력 및 별점 선택
    console.log(`[${taskId}] 📝 리뷰 텍스트 입력 중...`);
    await logger.updateStatus(taskId, { current_step: '리뷰 텍스트 및 별점 입력' });
    await logger.info(taskId, '📝 입력 필드 찾기...');
    
    try {
      await page.waitForTimeout(1000);
      
      const reviewText = notes ? notes.trim() : '좋은 경험 감사합니다!';
      let textInputSuccess = false;
      
      // server_origin.js 방식: frameLocator로 iframe 찾기
      try {
        console.log(`[${taskId}] 🔍 frameLocator로 textarea 탐색...`);
        const iframe = page.frameLocator('iframe[class*="goog-reviews-write-widget"]');
        
        // ✅ 중요: 먼저 label을 클릭해서 textarea를 활성화
        console.log(`[${taskId}] 🖱️ Label 클릭으로 포커스 활성화...`);
        try {
          const label = iframe.locator('label[for="c2"]');
          await label.click();
          await page.waitForTimeout(500);
          console.log(`[${taskId}] ✅ Label 클릭 완료`);
        } catch (labelErr) {
          console.log(`[${taskId}] ⚠️ Label 클릭 실패: ${labelErr.message}`);
        }
        
        // Label 클릭 후 textarea 탐색
        const textarea = iframe.locator('textarea[aria-label="리뷰 입력"]');
        const textareaCount = await textarea.count();
        console.log(`[${taskId}] iframe 내 textarea 발견: ${textareaCount}개`);
        
        if (textareaCount > 0) {
          // 1단계: textarea 클릭
          try {
            await textarea.first().click();
            await page.waitForTimeout(300);
            console.log(`[${taskId}] ✅ Textarea 클릭 완료`);
          } catch (clickErr) {
            console.log(`[${taskId}] ⚠️ Textarea 클릭 실패: ${clickErr.message}`);
          }
          
          // 2단계: 포커스 설정
          try {
            await textarea.first().focus();
            await page.waitForTimeout(300);
            console.log(`[${taskId}] ✅ Textarea 포커스 완료`);
          } catch (focusErr) {
            console.log(`[${taskId}] ⚠️ 포커스 설정 실패: ${focusErr.message}`);
          }
          
          // 3단계: fill() 방법으로 입력
          try {
            await textarea.first().fill(reviewText);
            await page.waitForTimeout(300);
            console.log(`[${taskId}] ✅ fill() 방법으로 텍스트 입력 완료`);
            textInputSuccess = true;
          } catch (e1) {
            console.log(`[${taskId}] ⚠️ fill() 실패, type() 시도...`);
            
            // 4단계: type() 방법으로 입력
            try {
              await textarea.first().type(reviewText, { delay: 5 });
              await page.waitForTimeout(300);
              console.log(`[${taskId}] ✅ type() 방법으로 텍스트 입력 완료`);
              textInputSuccess = true;
            } catch (e2) {
              console.log(`[${taskId}] ⚠️ type() 실패, JavaScript 시도...`);
              
              // 5단계: JavaScript로 직접 입력
              try {
                await page.evaluate((text) => {
                  const ta = document.querySelector('iframe[class*="goog-reviews-write-widget"]')
                    .contentDocument.querySelector('textarea[aria-label="리뷰 입력"]');
                  if (ta) {
                    ta.value = text;
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                    ta.dispatchEvent(new Event('blur', { bubbles: true }));
                    return true;
                  }
                  return false;
                }, reviewText);
                await page.waitForTimeout(300);
                console.log(`[${taskId}] ✅ JavaScript 방법으로 텍스트 입력 완료`);
                textInputSuccess = true;
              } catch (e3) {
                console.log(`[${taskId}] ❌ JavaScript 방법도 실패: ${e3.message}`);
              }
            }
          }
        }
      } catch (e1) {
        console.log(`[${taskId}] ⚠️ frameLocator 방법 실패: ${e1.message}`);
      }
      
      // Fallback: 다른 selector로 탐색
      if (!textInputSuccess) {
        try {
          console.log(`[${taskId}] 🔍 Fallback: 다른 selector로 탐색...`);
          const iframe = page.frameLocator('iframe[class*="goog-reviews-write-widget"]');
          
          // textarea 모두 찾기
          const allTextareas = iframe.locator('textarea');
          const textareaCount = await allTextareas.count();
          console.log(`[${taskId}] 모든 textarea 개수: ${textareaCount}`);
          
          if (textareaCount > 0) {
            await allTextareas.first().click();
            await page.waitForTimeout(200);
            await allTextareas.first().fill(reviewText);
            await page.waitForTimeout(300);
            console.log(`[${taskId}] ✅ Fallback textarea 입력 완료`);
            textInputSuccess = true;
          }
        } catch (e2) {
          console.log(`[${taskId}] ⚠️ Fallback도 실패: ${e2.message}`);
        }
      }
      
      if (textInputSuccess) {
        console.log(`[${taskId}] ✅ 리뷰 텍스트 입력 완료: "${reviewText}"`);
        await logger.info(taskId, `✅ 리뷰 텍스트 입력 완료: "${reviewText}"`);
        await page.waitForTimeout(500);
      } else {
        console.log(`[${taskId}] ❌ 리뷰 텍스트 입력 필드를 찾지 못함`);
        await logger.error(taskId, `❌ 입력 필드를 찾지 못함`);
      }
        
        // 별점 선택
        console.log(`[${taskId}] ⭐ 별점 선택 중...`);
        await logger.updateStatus(taskId, { current_step: '별점 선택' });
        try {
          const starClicked = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[class*="goog-reviews-write-widget"]');
            if (!iframe || !iframe.contentDocument) {
              console.log('[DEBUG] iframe not found');
              return { success: false, tried: ['iframe_not_found'] };
            }
            
            const doc = iframe.contentDocument;
            const tried = [];
            
            // Method 1: aria-label="별표 평점" + aria-label="5성급"
            const ratingGroup = doc.querySelector('div[aria-label="별표 평점"]');
            if (ratingGroup) {
              const fiveStar = ratingGroup.querySelector('div[aria-label="5성급"]');
              if (fiveStar) {
                tried.push('aria-label_rating_found');
                fiveStar.click();
                return { success: true, method: 'aria-label_rating' };
              }
            }
            tried.push('aria-label_rating_not_found');
            
            // Method 2: data-rating="5"
            const ratingByData = doc.querySelector('div[data-rating="5"]');
            if (ratingByData) {
              tried.push('data-rating_found');
              ratingByData.click();
              return { success: true, method: 'data-rating' };
            }
            tried.push('data-rating_not_found');
            
            // Method 3: button with aria-label containing "5"
            const buttons = doc.querySelectorAll('button[aria-label*="5"]');
            for (let btn of buttons) {
              if (btn.innerText.includes('5') || btn.getAttribute('aria-label').includes('5')) {
                tried.push('button_aria_5_found');
                btn.click();
                return { success: true, method: 'button_aria_5' };
              }
            }
            tried.push('button_aria_5_not_found');
            
            // Method 4: div with role="button" and aria-label containing "5"
            const roleButtons = doc.querySelectorAll('div[role="button"][aria-label*="5"]');
            for (let btn of roleButtons) {
              tried.push('role_button_5_found');
              btn.click();
              return { success: true, method: 'role_button_5' };
            }
            tried.push('role_button_5_not_found');
            
            // Method 5: Look for star rating container (any element with "star" or "rating" class)
            const allElements = doc.querySelectorAll('[class*="rating"], [class*="star"]');
            for (let elem of allElements) {
              if (elem.innerText && elem.innerText.includes('5')) {
                const clickable = elem.querySelector('button, [role="button"], div[onclick]');
                if (clickable) {
                  tried.push('star_container_found');
                  clickable.click();
                  return { success: true, method: 'star_container' };
                }
              }
            }
            tried.push('star_container_not_found');
            
            // Method 6: Try all divs with onclick or role="button"
            const clickables = doc.querySelectorAll('[role="button"], div[onclick], button');
            for (let elem of clickables) {
              if ((elem.getAttribute('aria-label') || elem.innerText || '').includes('5')) {
                tried.push('generic_clickable_5_found');
                elem.click();
                return { success: true, method: 'generic_clickable_5' };
              }
            }
            tried.push('generic_clickable_5_not_found');
            
            return { success: false, tried };
          });
          
          console.log(`[${taskId}] ⭐ 선택 시도 결과:`, starClicked);
          if (starClicked.debugInfo) {
            console.log(`[${taskId}] ⭐ 시도한 방법들:`, starClicked.debugInfo);
          }
          
          if (starClicked.success || starClicked.method) {
            console.log(`[${taskId}] ✅ 별점 선택 완료 (방법: ${starClicked.method})`);
            await logger.info(taskId, `✅ 별점 선택 완료 (${starClicked.method})`);
            await page.waitForTimeout(500);
            
            // 이미지 유무에 따른 completed_count 결정 로직
            let shouldIncrementCount = false;
            let countReason = '';
            
            // 매장의 이미지 정보 확인
            if (storeId) {
              const { data: storeData } = await supabase
                .from('stores')
                .select('image_urls')
                .eq('id', storeId)
                .single();
              
              if (storeData) {
                const hasImages = storeData.image_urls && Array.isArray(storeData.image_urls) && storeData.image_urls.length > 0;
                
                if (!hasImages) {
                  // 이미지 없음: 리뷰 완료만으로 카운트 증가
                  shouldIncrementCount = true;
                  countReason = '이미지 없음 - 리뷰만 완료하면 카운트';
                  console.log(`[${taskId}] ℹ️ 이 매장은 이미지 정보가 없어서 리뷰 완료로 카운트 증가`);
                } else {
                  // 이미지 있음: 현재 task의 image_status 확인
                  const { data: taskData } = await supabase
                    .from('tasks')
                    .select('image_status')
                    .eq('id', dbTaskId)
                    .single();
                  
                  if (taskData && (taskData.image_status === 'completed' || taskData.image_status === 'ready')) {
                    shouldIncrementCount = true;
                    countReason = '이미지 설정됨 - 리뷰/이미지 모두 완료되어 카운트';
                    console.log(`[${taskId}] ℹ️ 이미지도 완료됨 (${taskData.image_status}) - 카운트 증가`);
                  } else {
                    shouldIncrementCount = false;
                    countReason = `이미지 설정됨 - 이미지 상태가 ${taskData?.image_status || 'pending'}이라 아직 카운트 안함`;
                    console.log(`[${taskId}] ℹ️ 이미지가 아직 미완료 (${taskData?.image_status || 'pending'}) - 카운트 미증가`);
                  }
                }
              }
            }
            
            // 별점 선택 완료 = 자동화 완료, 조건에 따라 진행 상태 업데이트
            const updateData = {
              status: 'completed',
              review_status: 'completed',
              current_step: '리뷰 작성 준비 완료',
            };
            
            await logger.updateStatus(taskId, updateData);
            
            // ✅ completed_count 증가
            if (shouldIncrementCount) {
              await logger.info(taskId, `✅ 발행 진행: ${countReason}`);
              // DB에 completed_count 증가
              const { data: currentTask } = await supabase
                .from('tasks')
                .select('completed_count')
                .eq('id', dbTaskId)
                .single();
              
              const newCount = (currentTask?.completed_count || 0) + 1;
              await supabase
                .from('tasks')
                .update({ completed_count: newCount })
                .eq('id', dbTaskId);
              
              console.log(`[${taskId}] ✅ completed_count 증가: ${newCount}`);
              await logger.info(taskId, `📊 현재발행수: ${newCount}`);
            } else {
              await logger.info(taskId, `⏳ 발행 대기 중: ${countReason}`);
            }
            
            await logger.info(taskId, '📝 브라우저에서 리뷰를 작성하고 제출해주세요');
            await logger.info(taskId, '⏱️ 2분 후 브라우저 자동 종료 예정...');
            
            // 2분 후 자동 종료
            setTimeout(async () => {
              try {
                // ✅ 링크 추출: 매장 페이지 재방문
                console.log(`[${taskId}] 🔗 리뷰 공유 링크 추출 시작...`);
                await logger.info(taskId, '🔗 리뷰 공유 링크 추출 시작...');
                
                try {
                  // 매장 페이지로 이동
                  await page.goto(shortUrl, { waitUntil: 'networkidle', timeout: 30000 });
                  await page.waitForTimeout(2000);
                  
                  // 작업 계정 파싱
                  const workAccountForLink = await page.evaluate(() => {
                    function findInFrames(selector) {
                      const search = (doc) => {
                        const el = doc.querySelector(selector);
                        if (el) return el;
                        const iframes = Array.from(doc.querySelectorAll('iframe'));
                        for (const iframe of iframes) {
                          try {
                            const childDoc = iframe.contentDocument || iframe.contentWindow?.document;
                            if (!childDoc) continue;
                            const found = search(childDoc);
                            if (found) return found;
                          } catch (e) {
                            continue;
                          }
                        }
                        return null;
                      };
                      return search(document);
                    }
                    
                    const el = findInFrames('.Af21Ie');
                    return el?.textContent?.trim() || null;
                  });
                  
                  if (!workAccountForLink) {
                    console.log(`[${taskId}] ⚠️ 작업 계정 파싱 실패 (링크 추출 중)`)
                    await logger.warn(taskId, '⚠️ 작업 계정 파싱 실패 (링크 추출 중)');
                  } else {
                    console.log(`[${taskId}] ✅ 작업 계정 파싱: ${workAccountForLink}`);
                  }
                  
                  // "{workAccount}님의 리뷰 공유" 버튼 찾기
                  const shareButtonXPath = `//*[contains(text(), '님의 리뷰 공유')]`;
                  const shareButton = await page.locator(`//button | //div[@role='button']`).filter({ has: page.locator(`//*[contains(text(), '님의 리뷰 공유')]`) }).first();
                  
                  if (shareButton) {
                    await shareButton.click();
                    await page.waitForTimeout(1000);
                    
                    // input 필드에서 링크 추출 (여러 selector 시도)
                    const linkInputSelectors = [
                      'input[readonly][value*="maps.app.goo"]',
                      'input[readonly]',
                      'input[type="text"][readonly]',
                      'input[value*="maps"]'
                    ];
                    
                    let shareLink = null;
                    for (const selector of linkInputSelectors) {
                      const inputEl = await page.$(selector);
                      if (inputEl) {
                        shareLink = await inputEl.inputValue ? await inputEl.inputValue() : await page.getAttribute(selector, 'value');
                        if (shareLink && shareLink.includes('maps')) break;
                      }
                    }
                    
                    if (shareLink && shareLink.includes('maps')) {
                      console.log(`[${taskId}] ✅ 링크 추출 성공: ${shareLink}`);
                      await logger.info(taskId, `✅ 링크 추출 성공`);
                      
                      // DB 업데이트
                      const dbId = parseInt(taskId.split('_')[1]);
                      const { error: linkError } = await supabase
                        .from('tasks')
                        .update({ review_share_link: shareLink })
                        .eq('id', dbId);
                      
                      if (linkError) {
                        console.log(`[${taskId}] ⚠️ DB 링크 저장 오류: ${linkError.message}`);
                        await logger.warn(taskId, `⚠️ DB 링크 저장 오류: ${linkError.message}`);
                      } else {
                        console.log(`[${taskId}] 💾 DB 링크 업데이트 완료`);
                        await logger.info(taskId, '💾 DB 링크 업데이트 완료');
                      }
                    } else {
                      console.log(`[${taskId}] ⚠️ 링크 입력 필드를 찾지 못함`);
                      await logger.warn(taskId, '⚠️ 링크 입력 필드를 찾지 못함');
                    }
                  } else {
                    console.log(`[${taskId}] ⚠️ "님의 리뷰 공유" 버튼을 찾지 못함`);
                    await logger.warn(taskId, '⚠️ "님의 리뷰 공유" 버튼을 찾지 못함');
                  }
                } catch (linkExtractError) {
                  console.log(`[${taskId}] ⚠️ 링크 추출 오류: ${linkExtractError.message}`);
                  await logger.warn(taskId, `⚠️ 링크 추출 오류: ${linkExtractError.message}`);
                }
                
                // 브라우저 종료
                await browser.close();
                console.log(`[${taskId}] 🔒 브라우저 자동 종료됨 (프로필 저장됨)\n`);
                await logger.info(taskId, '🔒 브라우저 자동 종료됨 (프로필 저장됨)');
                await logger.updateStatus(taskId, { current_step: '브라우저 종료' });
              } catch (e) {
                console.log(`[${taskId}] ⚠️ 브라우저 종료 오류: ${e.message}\n`);
                await logger.warn(taskId, `⚠️ 브라우저 종료 오류: ${e.message}`);
              }
            }, 120000); // 2분
            
            return; // 완료 후 종료
          } else {
            console.log(`[${taskId}] ❌ 별점 선택 실패 - 모든 방법 시도함:`, starClicked.tried);
            await logger.error(taskId, `❌ 별점 선택 실패 - 시도한 방법: ${starClicked.tried.join(', ')}`);
          }
        } catch (e) {
          console.log(`[${taskId}] ⚠️ 별점 선택 처리 오류: ${e.message}`);
          await logger.warn(taskId, `⚠️ 별점 선택 처리 오류: ${e.message}`);
        }
    } catch (e) {
      console.log(`[${taskId}] ⚠️ 입력 필드 처리 오류: ${e.message}`);
      await logger.warn(taskId, `⚠️ 입력 필드 처리 오류: ${e.message}`);
    }

  } catch (error) {
    console.log(`[${taskId}] ❌ 백그라운드 작업 오류: ${error.message}\n`);
    await logger.error(taskId, `❌ 백그라운드 작업 오류: ${error.message}`);
    await logger.updateStatus(taskId, {
      status: 'failed',
      review_status: 'failed',
      current_step: `오류: ${error.message}`
    });
    try {
      await browser.close();
    } catch (e) {
      // 무시
    }
  }
}

// ✅ 링크 자동 추출 (Playwright 자동화)
app.post('/api/extract-review-link', authMiddleware, async (req, res) => {
  const { taskId } = req.body;
  
  if (!taskId) {
    return res.status(400).json({ error: 'taskId is required' });
  }
  
  const dbId = typeof taskId === 'string' && taskId.startsWith('task_') 
    ? parseInt(taskId.split('_')[1]) 
    : taskId;
  
  const taskIdStr = `task_${dbId}`;
  let browser;
  
  try {
    // Task & Store 조회
    const { data: task } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', dbId)
      .single();
    
    if (!task) return res.status(404).json({ error: 'Task not found' });
    
    const { data: store } = await supabase
      .from('stores')
      .select('address')
      .eq('id', task.store_id)
      .single();
    
    if (!store?.address) return res.status(404).json({ error: 'Store address not found' });
    
    const workAccount = task.work_account.trim();
    console.log(`🔗 [${taskIdStr}] 시작: ${workAccount} - ${store.address}`);
    
    // Playwright 시작 - 브라우저 보이기 (사용자가 로그인할 수 있도록)
    browser = await chromium.launch({ 
      headless: false,  // ✅ 브라우저 띄우기
      args: ['--start-maximized']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      // ✅ 쿠키/저장된 로그인정보 제거 - 깨끗한 상태로 시작
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    
    // ✅ 로그인 대기: 페이지를 열기 전에 "로그인을 해주세요" 메시지 표시
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📱 [${taskIdStr}] 🔐 ${workAccount} 계정으로 로그인을 완료하세요!`);
    console.log(`📍 매장: ${store.address}`);
    console.log(`📲 로그인 후에 "계속 진행"을 클릭해주세요.`);
    console.log(`${'='.repeat(60)}\n`);
    
    // 1. 매장 페이지 열기
    await page.goto(store.address, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // ✅ 사용자가 "계속 진행"을 클릭할 때까지 대기
    console.log(`⏳ [${taskIdStr}] 사용자 입력 대기 중...`);
    
    // Promise 생성 및 저장
    let resolveWait;
    const waitPromise = new Promise(resolve => {
      resolveWait = resolve;
    });
    processWaiters.set(taskIdStr, resolveWait);

    const result = await waitPromise;
    processWaiters.delete(taskIdStr);

    if (result === 'cancel') {
      await browser.close();
      console.error(`❌ [${taskIdStr}] 사용자가 취소함`);
      return res.status(400).json({ error: '사용자가 취소함' });
    }

    console.log(`✅ [${taskIdStr}] 계속 진행!`);
    
    // 2. 리뷰 섹션 활성화 후 HTML 저장
    const fsModule = require('fs');
    const pathModule = require('path');
    
    // 1. Reviews 버튼 클릭 (리뷰 탭 활성화)
    console.log(`[${taskIdStr}] 🔍 Reviews 버튼 찾기...`);
    try {
      const reviewsBtn = await page.getByRole('button', { name: 'Reviews' });
      const count = await reviewsBtn.count();
      if (count > 0) {
        console.log(`[${taskIdStr}] ✅ Reviews 버튼 발견, 클릭...`);
        await reviewsBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log(`[${taskIdStr}] ⚠️ Reviews 버튼 클릭 실패: ${e.message}`);
    }
    
    // 2. 추가 스크롤
    console.log(`[${taskIdStr}] ⏳ 리뷰 로딩 대기...`);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(2000);
    
    // 3. HTML 저장
    const frames = await page.frames();
    for (const frame of frames) {
      try {
        const htmlContent = await frame.content();
        const debugPath = pathModule.join(__dirname, `debug_${taskIdStr}.html`);
        fsModule.writeFileSync(debugPath, htmlContent, 'utf-8');
        console.log(`[${taskIdStr}] 📄 HTML 저장: ${debugPath}`);
        
        // 페이지 분석
        const result = await frame.evaluate(() => {
          const hasMama1 = document.body.textContent.includes('mama1');
          const shareButtons = document.querySelectorAll('button[aria-label*="Share"]').length;
          return { hasMama1, shareButtons };
        });
        
        console.log(`[${taskIdStr}] 📊 분석:`, result);
      } catch (e) {
        console.log(`[${taskIdStr}] ❌ 오류: ${e.message}`);
      }
    }
    
    throw new Error(`HTML 저장 완료. 파일 확인!`);
    
    // 3. Input에서 링크 추출
    console.log(`[${taskIdStr}] 🔗 링크 추출...`);
    
    let shareLink = null;
    
    for (const frame of frames) {
      try {
        const result = await frame.evaluate(() => {
          // input[readonly]에서 링크 추출
          const linkInput = document.querySelector('input[readonly]');
          if (linkInput) {
            const link = linkInput.value;
            console.log(`✅ 링크 발견: "${link?.substring(0, 50)}"`);
            return link;
          }
          
          console.log(`❌ input[readonly]을 찾지 못함`);
          return null;
        });
        
        if (result && result.includes('maps')) {
          shareLink = result;
          console.log(`[${taskIdStr}] ✅ 링크 추출: ${shareLink}`);
          break;
        }
      } catch (e) {
        console.log(`[${taskIdStr}] ⚠️ Frame 오류: ${e.message}`);
      }
    }
    
    if (!shareLink) {
      await browser.close();
      return res.status(400).json({ error: '링크를 찾지 못함' });
    }
    
    // 4. DB 저장
    const { error: updateError } = await supabase
      .from('tasks')
      .update({ review_share_link: shareLink })
      .eq('id', dbId);
    
    await browser.close();
    
    if (updateError) {
      return res.status(500).json({ error: 'DB update failed' });
    }
    
    console.log(`✅ [${taskIdStr}] 완료: ${shareLink}`);
    res.json({ success: true, review_share_link: shareLink });
    
  } catch (error) {
    if (browser) await browser.close();
    console.error(`❌ [${taskIdStr}] ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 계속 진행 버튼 클릭 처리
app.post('/api/continue/:taskId', authMiddleware, (req, res) => {
  const { taskId } = req.params;
  
  if (!processWaiters.has(taskId)) {
    return res.status(404).json({ error: `${taskId}를 찾을 수 없습니다.` });
  }
  
  const resolve = processWaiters.get(taskId);
  resolve('continue'); // Promise 완료
  
  console.log(`✅ [${taskId}] 계속 진행 신호 받음!`);
  res.json({ success: true, message: `${taskId} 프로세스 진행됨` });
});

// ✅ 취소 버튼 클릭 처리
app.post('/api/cancel/:taskId', authMiddleware, (req, res) => {
  const { taskId } = req.params;
  
  if (!processWaiters.has(taskId)) {
    return res.status(404).json({ error: `${taskId}를 찾을 수 없습니다.` });
  }
  
  const resolve = processWaiters.get(taskId);
  resolve('cancel'); // 취소 신호
  
  console.log(`❌ [${taskId}] 취소 신호 받음!`);
  res.json({ success: true, message: `${taskId} 프로세스 취소됨` });
});

// 수동 링크 저장
app.post('/api/tasks/:taskId/review-link', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin 권한이 필요합니다.' });
    }

    const { taskId } = req.params;
    const { review_share_link } = req.body;

    if (!review_share_link || !review_share_link.trim()) {
      return res.status(400).json({ error: '링크를 입력해주세요.' });
    }

    if (!review_share_link.includes('maps')) {
      return res.status(400).json({ error: '유효한 Google Maps 링크가 아닙니다.' });
    }

    const dbId = typeof taskId === 'string' && taskId.startsWith('task_')
      ? parseInt(taskId.split('_')[1])
      : taskId;

    // ✅ review_share_link 저장 + review_status를 'completed'로 변경
    const { data: updatedTask, error } = await supabase
      .from('tasks')
      .update({ 
        review_share_link: review_share_link.trim(),
        review_status: 'completed'  // ✅ 링크 저장 시 상태를 "완료"로 변경
      })
      .eq('id', dbId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'DB 업데이트 실패' });
    }

    console.log(`✅ [task_${dbId}] 수동 링크 저장 + 상태 변경: ${review_share_link}`);
    res.json({ success: true, review_share_link, updatedTask });
  } catch (error) {
    console.error('❌ 링크 저장 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Automation backend listening on port ${PORT}`);
});