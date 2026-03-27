// backend/server.js
const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

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

app.post('/api/automate-map', async (req, res) => {
  const { shortUrl } = req.body;
  if (!shortUrl) return res.status(400).json({ error: 'shortUrl is required' });

  let browser;
  try {
    // 랜덤 계정 선택
    const account = getRandomAccount();
    console.log(`📧 사용 계정: ${account.email}`);

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

    console.log('🔍 프로필 경로:', profilePath);
    if (isFirstLogin) {
      console.log('⚠️ 첫 로그인 - 120초 내에 수동 로그인 필요');
    } else {
      console.log('✅ 저장된 프로필 사용 중...');
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
        console.log(`PAGE LOG: ${msg.text()}`);
      }
    });

    page.on('pageerror', err => {
      if (!err.toString().includes('chrome-extension') && !err.toString().includes('Origin not allowed')) {
        console.error(`PAGE ERROR: ${err}`);
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
      console.log('🔐 첫 로그인 - 수동 로그인 필요');
      console.log('📍 https://accounts.google.com/signin 에서 로그인해주세요');
      console.log('⏳ 120초 동안 기다리는 중...\n');

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
            console.log('✅ 로그인 감지!');
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
        return res.status(400).json({ error: '로그인 시간 초과 (120초)' });
      }
    } else {
      console.log('✅ 저장된 세션으로 자동 로그인됨');
    }

    // 백그라운드 처리 시작
    backgroundTask(page, shortUrl, account.email, browser, profilePath);

    res.json({
      placeName: '로딩 중...',
      message: '✅ 자동화 시작됨. 브라우저에서 리뷰를 작성해주세요. (2분 후 자동 종료)',
      usedAccount: account.email
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('❌ 에러:', error);
    res.status(500).json({ error: error.message });
  }
});

// 백그라운드에서 자동화 작업 처리
async function backgroundTask(page, shortUrl, email, browser, tempDir) {
  try {
    // 1. 단축 URL 열기 (waitUntil 타임아웃 완화)
    console.log('🔗 URL 접속:', shortUrl);
    await page.goto(shortUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {
      console.warn('⚠️ URL 로드 완료되지 않았지만 계속 진행');
    });

    // 로그인 페이지로 리다이렉트된 경우 감지
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
      console.warn('⚠️ 로그인이 필요합니다. 60초 동안 기다리는 중...');
      
      const startTime = Date.now();
      const timeout = 60000;
      let loggedIn = false;

      while (Date.now() - startTime < timeout) {
        try {
          const url = page.url();
          if (!url.includes('accounts.google.com') && !url.includes('signin')) {
            loggedIn = true;
            console.log('✅ 로그인 감지! Maps로 이동 중...');
            await page.waitForTimeout(2000);
            break;
          }
        } catch (e) {
          // 무시
        }
        await page.waitForTimeout(1000);
      }

      if (!loggedIn) {
        console.error('❌ 로그인 시간 초과');
        return;
      }
    }

    // 2. 최종 URL 파싱
    const finalUrl = page.url();
    const urlObj = new URL(finalUrl);
    const paths = urlObj.pathname.split('/').filter(Boolean);
    const placeNameEncoded = paths[2] || '';
    const placeName = decodeURIComponent(placeNameEncoded.replace(/\+/g, ' '));
    console.log('🏠 장소명:', placeName);

    // 3. 리뷰 탭 클릭
    console.log('💬 리뷰 탭 찾기...');
    await page.waitForTimeout(2000);
    
    try {
      // 다양한 셀렉터로 리뷰 탭 찾기
      const selectors = [
        'button[aria-label*="Reviews"]',
        'button[aria-label*="리뷰"]',
        'button[jsaction*="reviews"]',
        'button[jsaction*="pane.review"]',
        'div[role="button"][aria-label*="Reviews"]',
        'div[role="button"][aria-label*="리뷰"]',
      ];

      let clickedReview = false;
      
      for (const selector of selectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            console.log(`✅ 리뷰 탭 발견 (${selector})`);
            await element.click();
            clickedReview = true;
            await page.waitForTimeout(1500);
            break;
          }
        } catch (e) {
          // 무시하고 다음 셀렉터 시도
        }
      }

      // 만약 버튼을 못 찾으면 텍스트로 찾기
      if (!clickedReview) {
        console.log('🔍 텍스트로 "Reviews" 또는 "리뷰" 찾기...');
        const allButtons = await page.$$('button');
        for (const btn of allButtons) {
          const text = await btn.textContent();
          if (text && (text.includes('Reviews') || text.includes('리뷰'))) {
            console.log('✅ 텍스트로 리뷰 탭 발견');
            await btn.click();
            clickedReview = true;
            await page.waitForTimeout(1500);
            break;
          }
        }
      }

      if (clickedReview) {
        console.log('✅ 리뷰 탭 클릭 성공');
      } else {
        console.warn('⚠️ 리뷰 탭을 찾지 못함 (계속 진행)');
      }
    } catch (e) {
      console.warn('⚠️ 리뷰 탭 클릭 오류:', e.message);
    }

    // 4. "리뷰 작성" 버튼 클릭
    console.log('📝 리뷰 작성 버튼 찾기...');
    try {
      await page.waitForTimeout(1000);
      
      // 다양한 셀렉터로 "Write a review" 버튼 찾기
      const writeReviewSelectors = [
        'button[jsname="fk8dgd"]',
        'button[aria-label*="Write a review"]',
        'button[aria-label*="리뷰 작성"]',
        'div[role="button"][aria-label*="Write a review"]',
        'div[role="button"][aria-label*="리뷰 작성"]',
      ];

      let clickedWriteReview = false;

      for (const selector of writeReviewSelectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            console.log(`✅ 리뷰 작성 버튼 발견 (${selector})`);
            await element.click();
            clickedWriteReview = true;
            await page.waitForTimeout(1500);
            break;
          }
        } catch (e) {
          // 무시하고 다음 셀렉터 시도
        }
      }

      // 텍스트로 찾기
      if (!clickedWriteReview) {
        console.log('🔍 텍스트로 "Write a review" 또는 "리뷰 작성" 찾기...');
        const allButtons = await page.$$('button, div[role="button"]');
        for (const btn of allButtons) {
          const text = await btn.textContent();
          if (text && (text.includes('Write a review') || text.includes('리뷰 작성'))) {
            console.log('✅ 텍스트로 리뷰 작성 버튼 발견');
            await btn.click();
            clickedWriteReview = true;
            await page.waitForTimeout(1500);
            break;
          }
        }
      }

      if (clickedWriteReview) {
        console.log('✅ 리뷰 작성 버튼 클릭 성공');
      } else {
        console.warn('⚠️ 리뷰 작성 버튼을 찾지 못함');
      }
    } catch (e) {
      console.warn('⚠️ 리뷰 작성 버튼 오류:', e.message);
    }

    // 5. 입력 필드에 포커스 (iframe 내부에 있음)
    console.log('✏️ 입력 필드 찾기...');
    try {
      await page.waitForTimeout(1000);
      
      // iframe 내부의 textarea를 찾기 (goog-reviews-write-widget iframe)
      const iframe = page.frameLocator('iframe[class*="goog-reviews-write-widget"]');
      const textarea = iframe.locator('textarea[aria-label="리뷰 입력"]');
      
      // textarea 존재 확인
      const textareaCount = await textarea.count();
      console.log(`✅ iframe 내 textarea 발견 (개수: ${textareaCount})`);
      
      if (textareaCount > 0) {
        // 1단계: label을 통한 포커스 (iframe 내부에서도 적용)
        console.log('🖱️ Label 클릭으로 포커스 활성화...');
        try {
          const label = iframe.locator('label[for="c2"]');
          await label.click();
          console.log('✅ Label 클릭 완료');
          await page.waitForTimeout(500);
        } catch (labelErr) {
          console.warn('⚠️ Label 클릭 실패, textarea 직접 클릭 시도...');
          // Fallback: textarea 직접 클릭
          try {
            await textarea.first().click();
            console.log('✅ Textarea 직접 클릭 완료');
            await page.waitForTimeout(500);
          } catch (clickErr) {
            console.warn('⚠️ Textarea 클릭 실패:', clickErr.message);
          }
        }
        
        // 2단계: 포커스 설정
        try {
          await textarea.first().focus();
          console.log('✅ Textarea 포커스 설정 완료');
          await page.waitForTimeout(300);
        } catch (focusErr) {
          console.warn('⚠️ 포커스 설정 실패:', focusErr.message);
        }
        
        // 3단계: 텍스트 입력
        try {
          await textarea.first().fill('리뷰를 시작합니다.');
          console.log('📝 fill() 방법으로 텍스트 입력 완료');
        } catch (e1) {
          try {
            await textarea.first().type('리뷰를 시작합니다.', { delay: 50 });
            console.log('📝 type() 방법으로 텍스트 입력 완료');
          } catch (e2) {
            // JavaScript로 직접 설정 (iframe 내부 컨텍스트)
            await page.evaluate(() => {
              const ta = document.querySelector('iframe[class*="goog-reviews-write-widget"]').contentDocument.querySelector('textarea[aria-label="리뷰 입력"]');
              if (ta) {
                ta.value = '리뷰를 시작합니다.';
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
              }
            });
            console.log('📝 JavaScript 방법으로 텍스트 입력 완료');
          }
        }
        
        // 4단계: 5성급 별점 클릭 (iframe 내부 - "별표 평점" 그룹)
        console.log('⭐ 별점 클릭...');
        try {
          const starClicked = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[class*="goog-reviews-write-widget"]');
            if (iframe && iframe.contentDocument) {
              // 방법 1: "별표 평점" radiogroup에서 5성급 찾기
              const ratingGroup = iframe.contentDocument.querySelector('div[aria-label="별표 평점"]');
              if (ratingGroup) {
                const fiveStar = ratingGroup.querySelector('div[aria-label="5성급"]');
                if (fiveStar) {
                  fiveStar.click();
                  console.log('✅ 별표 평점 5성급 클릭 완료');
                  return true;
                }
              }
              
              console.log('⚠️ 별표 평점 그룹을 찾지 못함, 첫 번째 5성급 찾기...');
              // Fallback: 첫 번째 5성급 (별표 평점이 맨 위)
              const firstFiveStar = iframe.contentDocument.querySelector('div[data-rating="5"]');
              if (firstFiveStar) {
                firstFiveStar.click();
                console.log('✅ 첫 번째 5성급 클릭 완료');
                return true;
              }
            }
            return false;
          });
          
          if (starClicked) {
            console.log('✅ 별점 선택 완료');
            await page.waitForTimeout(500);
          } else {
            console.warn('⚠️ 별점을 찾지 못함');
          }
        } catch (starErr) {
          console.warn('⚠️ 별점 클릭 실패:', starErr.message);
        }
        
        // 5단계: "음식" 항목의 5성급 클릭
        console.log('⭐ 음식 항목 별점 클릭...');
        try {
          const foodStarClicked = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[class*="goog-reviews-write-widget"]');
            if (iframe && iframe.contentDocument) {
              // "음식" h3 찾기
              const foodHeading = Array.from(
                iframe.contentDocument.querySelectorAll('h3.z61Im')
              ).find(h3 => h3.textContent.includes('음식'));
              
              if (foodHeading) {
                console.log('✅ 음식 h3 발견');
                
                // "음식" 다음 형제 요소에서 5성급 찾기
                let sibling = foodHeading.nextElementSibling;
                while (sibling && sibling.tagName !== 'H3') {
                  const fiveStar = sibling.querySelector('div[data-rating="5"]');
                  if (fiveStar) {
                    fiveStar.click();
                    console.log('✅ 음식 항목의 5성급 클릭 완료');
                    return true;
                  }
                  sibling = sibling.nextElementSibling;
                }
              }
              
              console.log('⚠️ 음식 h3를 찾지 못함');
              return false;
            }
            return false;
          });
          
          if (foodStarClicked) {
            console.log('✅ 음식 별점 선택 완료');
            await page.waitForTimeout(500);
          }
        } catch (foodErr) {
          console.warn('⚠️ 음식 별점 클릭 실패:', foodErr.message);
        }
        
        console.log('✅ 입력 필드 포커스 설정 및 텍스트 입력 완료\n');
      } else {
        console.warn('⚠️ iframe 내 textarea를 찾지 못함');
      }
    } catch (e) {
      console.warn('⚠️ 입력 필드 처리 오류:', e.message);
    }

    // 2분 후 자동 종료 (프로필은 유지)
    console.log('⏱️ 2분 후 브라우저 자동 종료 예정...');
    setTimeout(async () => {
      try {
        await browser.close();
        console.log('✅ 브라우저 자동 종료됨 (프로필 저장됨)');
      } catch (e) {
        console.warn('⚠️ 브라우저 종료 오류:', e.message);
      }
    }, 3600000); // 2분

  } catch (error) {
    console.error('❌ 백그라운드 작업 오류:', error);
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