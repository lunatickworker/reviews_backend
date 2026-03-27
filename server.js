// backend/server.js
const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// 라우트 import
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const storeRoutes = require('./routes/stores');
const taskRoutes = require('./routes/tasks');
const reviewRoutes = require('./routes/reviews');
const scheduleRoutes = require('./routes/schedules');
const authMiddleware = require('./auth-middleware');
const logger = require('./logger');
const supabase = require('./supabaseClient');
const { initScheduler } = require('./scheduler');

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

// .env에서 Google 계정 로드
const googleAccounts = JSON.parse(process.env.GOOGLE_ACCOUNTS || '[]');

if (googleAccounts.length === 0) {
  console.warn('⚠️ Warning: GOOGLE_ACCOUNTS not configured in .env');
}

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
app.use('/api/schedules', scheduleRoutes);

// 백그라운드 스케줄러 초기화
initScheduler();
console.log('✅ 자동 배포 스케줄러 활성화됨');

// 랜덤 계정 선택
function getRandomAccount() {
  if (googleAccounts.length === 0) {
    throw new Error('No Google accounts configured');
  }
  const randomIndex = Math.floor(Math.random() * googleAccounts.length);
  return googleAccounts[randomIndex];
}

// 계정별 프로필 디렉토리
function getProfilePath(email) {
  const emailHash = Buffer.from(email).toString('base64').replace(/\//g, '_');
  return path.join(userDataDir, `profile_${emailHash}`);
}

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
    const workAccount = account.email.split('@')[0];
    
    await supabase
      .from('tasks')
      .update({ work_account: workAccount })
      .eq('id', dbTaskId);

    await logger.info(taskId, `사용 계정: ${account.email}`);

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
    backgroundTask(page, shortUrl, notes, account.email, browser, profilePath, userId, taskId);

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

  const { shortUrl, notes, storeId, totalCount = 1 } = req.body;
  if (!shortUrl) return res.status(400).json({ error: 'shortUrl is required' });

  let browser;
  try {
    // 1. store 정보 조회 (storeId가 있으면)
    let placeName = '로딩 중...';
    if (storeId) {
      const { data: storeData } = await supabase
        .from('stores')
        .select('store_name')
        .eq('id', storeId)
        .single();
      
      if (storeData && storeData.store_name) {
        placeName = storeData.store_name;
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

    // 랜덤 계정 선택
    const account = getRandomAccount();
    const workAccount = account.email.split('@')[0]; // 이메일에서 @ 앞부분 추출
    await logger.info(taskId, `사용 계정: ${account.email}`);
    
    // 첫 번째 task에만 work_account 업데이트
    await supabase
      .from('tasks')
      .update({ work_account: workAccount })
      .eq('id', dbTaskId);

    // 계정별 저장된 프로필 디렉토리 (첫 로그인만 수동, 이후는 자동)
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

    await logger.info(taskId, `프로필 경로: ${profilePath}`);
    if (isFirstLogin) {
      await logger.warn(taskId, '첫 로그인 - 120초 내에 수동 로그인 필요');
    } else {
      await logger.info(taskId, '저장된 프로필 사용 중...');
    }

    // Chrome 실행 (계정별 저장된 프로필 사용)
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

    // 첫 로그인인 경우만 수동 로그인 필요
    if (isFirstLogin) {
      await logger.info(taskId, '🔐 첫 로그인 - 수동 로그인 필요');
      await logger.info(taskId, '📍 https://accounts.google.com/signin 에서 로그인해주세요');
      await logger.info(taskId, '⏳ 120초 동안 기다리는 중...');

      // Google 로그인 페이지로 이동
      await page.goto('https://accounts.google.com/signin', { waitUntil: 'load', timeout: 10000 });

      // 사용자가 수동으로 로그인할 때까지 120초 대기
      let loggedIn = false;
      const startTime = Date.now();
      const timeout = 120000; // 120초

      while (Date.now() - startTime < timeout) {
        try {
          const url = page.url();
          // 계정 페이지 또는 로그인 완료 확인
          if (!url.includes('accounts.google.com') || url.includes('myaccount')) {
            loggedIn = true;
            await logger.info(taskId, '✅ 로그인 감지!');
            await page.waitForTimeout(2000);
            break;
          }
        } catch (e) {
          // 무시
        }
        await page.waitForTimeout(1000);
      }

      if (!loggedIn) {
        await browser.close();
        await logger.error(taskId, '로그인 시간 초과 (120초)');
        await logger.updateStatus(taskId, { status: 'failed', review_status: 'failed' });
        return res.status(400).json({ error: '로그인 시간 초과 (120초)' });
      }
    } else {
      await logger.info(taskId, '✅ 저장된 세션으로 자동 로그인됨');
    }

    // work_account가 제대로 저장되었는지 확인
    const { data: updatedTask } = await supabase
      .from('tasks')
      .select('work_account')
      .eq('id', dbTaskId)
      .single();

    const savedWorkAccount = updatedTask?.work_account || workAccount;
    console.log(`[${taskId}] ✅ work_account 저장됨: ${savedWorkAccount}`);

    // 백그라운드 처리 시작 (작업 ID 기록)
    backgroundTask(page, shortUrl, notes, account.email, browser, profilePath, req.user.id, taskId);

    res.json({
      placeName: '로딩 중...',
      message: `✅ 자동화 시작됨 (${totalCount}개 작업 생성). 브라우저에서 리뷰를 작성해주세요. (2분 후 자동 종료)`,
      usedAccount: account.email,
      workAccount: savedWorkAccount,
      taskId: taskId,
      dbTaskId: dbTaskId,
      totalCount: totalCount,
      createdTasks: totalCount
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('❌ 에러:', error);
    res.status(500).json({ error: error.message });
  }
});

// 백그라운드에서 자동화 작업 처리
async function backgroundTask(page, shortUrl, notes, email, browser, tempDir, userId, taskId) {
  try {
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

      if (!writeReviewClicked) {
        console.log(`[${taskId}] ⚠️ 리뷰 작성 버튼을 찾지 못함`);
        await logger.warn(taskId, '⚠️ 리뷰 작성 버튼을 찾지 못함');
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
            
            // 별점 선택 완료 = 자동화 완료
            await logger.updateStatus(taskId, {
              status: 'completed',
              review_status: 'completed',
              current_step: '리뷰 작성 준비 완료'
            });
            await logger.info(taskId, '📝 브라우저에서 리뷰를 작성하고 제출해주세요');
            await logger.info(taskId, '⏱️ 2분 후 브라우저 자동 종료 예정...');
            
            // 2분 후 자동 종료
            setTimeout(async () => {
              try {
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Automation backend listening on port ${PORT}`);
  console.log(`📧 Available accounts: ${googleAccounts.length}`);
});