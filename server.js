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

// 리뷰 배포 API (admin만 요청 가능) - 권한 체계 추가
app.post('/api/automate-map', authMiddleware, async (req, res) => {
  // admin 권한 확인
  if (req.user.role !== 'admin' && req.user.role !== 'devadmin') {
    return res.status(403).json({ error: 'admin 권한이 필요합니다.' });
  }

  const { shortUrl, notes } = req.body;
  if (!shortUrl) return res.status(400).json({ error: 'shortUrl is required' });

  let browser;
  try {
    // 1. 장소명 추출 (임시)
    let placeName = '로딩 중...';
    
    // 2. tasks 테이블에 새 작업 추가
    const { data: taskData, error: taskError } = await supabase
      .from('tasks')
      .insert([
        {
          place_name: placeName,
          status: 'in_progress',
          review_status: 'pending',
          image_status: 'pending',
          current_step: '시작',
          notes: notes ? notes.trim() : '',
          user_id: req.user.id,
          created_at: new Date().toISOString(),
        }
      ])
      .select();

    if (taskError) {
      console.error('❌ 작업 생성 오류:', taskError);
      return res.status(500).json({ error: '작업 생성에 실패했습니다.' });
    }

    const dbTaskId = taskData[0].id;
    const taskId = `task_${dbTaskId}`;
    
    // task_id 컬럼도 업데이트
    await supabase
      .from('tasks')
      .update({ task_id: taskId })
      .eq('id', dbTaskId);

    console.log(`📋 새 작업 생성됨: ID=${dbTaskId}, taskId=${taskId}`);
    console.log(`📝 Notes: "${notes ? notes.trim() : '(없음)'}"`);
    await logger.info(taskId, `작업 시작: shortUrl=${shortUrl}`, { user: req.user.id });
    if (notes) {
      await logger.info(taskId, `📝 메모: ${notes}`);
    }

    // 랜덤 계정 선택
    const account = getRandomAccount();
    await logger.info(taskId, `사용 계정: ${account.email}`);

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

    // 백그라운드 처리 시작 (작업 ID 기록)
    backgroundTask(page, shortUrl, notes, account.email, browser, profilePath, req.user.id, taskId);

    res.json({
      placeName: '로딩 중...',
      message: '✅ 자동화 시작됨. 브라우저에서 리뷰를 작성해주세요. (2분 후 자동 종료)',
      usedAccount: account.email,
      taskId: taskId,
      dbTaskId: dbTaskId
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
            await page.waitForTimeout(1500);
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
      
      const iframe = page.frameLocator('iframe[class*="goog-reviews-write-widget"]');
      const textarea = iframe.locator('textarea[aria-label="리뷰 입력"]');
      const textareaCount = await textarea.count();
      
      if (textareaCount > 0) {
        // 텍스트 입력 (notes 있으면 사용, 없으면 기본값)
        const reviewText = notes ? notes.trim() : '좋은 경험 감사합니다!';
        try {
          await textarea.first().focus();
          await textarea.first().fill(reviewText);
          console.log(`[${taskId}] ✅ 리뷰 텍스트 입력 완료: "${reviewText}"`);
          await logger.info(taskId, `✅ 리뷰 텍스트 입력 완료: "${reviewText}"`);
          await page.waitForTimeout(300);
        } catch (e1) {
          try {
            await textarea.first().type(reviewText, { delay: 50 });
            console.log(`[${taskId}] ✅ 리뷰 텍스트 입력 완료: "${reviewText}"`);
            await logger.info(taskId, `✅ 리뷰 텍스트 입력 완료: "${reviewText}"`);
          } catch (e2) {
            console.log(`[${taskId}] ⚠️ 텍스트 입력 실패`);
            await logger.warn(taskId, '⚠️ 텍스트 입력 실패');
          }
        }
        
        // 별점 선택
        console.log(`[${taskId}] ⭐ 별점 선택 중...`);
        await logger.updateStatus(taskId, { current_step: '별점 선택' });
        try {
          const starClicked = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[class*="goog-reviews-write-widget"]');
            if (iframe && iframe.contentDocument) {
              // 별표 5성급 클릭
              const ratingGroup = iframe.contentDocument.querySelector('div[aria-label="별표 평점"]');
              if (ratingGroup) {
                const fiveStar = ratingGroup.querySelector('div[aria-label="5성급"]');
                if (fiveStar) {
                  fiveStar.click();
                  return true;
                }
              }
              const firstFiveStar = iframe.contentDocument.querySelector('div[data-rating="5"]');
              if (firstFiveStar) {
                firstFiveStar.click();
                return true;
              }
            }
            return false;
          });
          
          if (starClicked) {
            console.log(`[${taskId}] ✅ 별점 선택 완료`);
            await logger.info(taskId, '✅ 별점 선택 완료');
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
          }
        } catch (e) {
          console.log(`[${taskId}] ⚠️ 별점 선택 실패`);
          await logger.warn(taskId, '⚠️ 별점 선택 실패');
        }
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