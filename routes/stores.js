const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();
const multer = require('multer');
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('⚠️ sharp 모듈을 불러올 수 없습니다. 이미지 리사이즈 기능은 비활성화됩니다. 설치하면 자동으로 활성화됩니다.');
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // allow larger original, we'll resize server-side if sharp available

// 매장 조회 (관리자: 모든 매장, 일반 사용자: 자신의 매장)
router.get('/', authMiddleware, async (req, res) => {
  try {
    let query = supabase
      .from('stores')
      .select('*, user:user_id(user_id, superior_name)')
      .order('created_at', { ascending: false });

    // 관리자가 아니면 자신의 매장만 조회
    if (req.user.role !== 'admin') {
      query = query.eq('user_id', req.user.id);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('매장 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 특정 매장 조회
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { data: store, error } = await supabase
      .from('stores')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    // 권한 검증: Admin이 아니면 자신의 매장만 조회 가능
    if (req.user.role !== 'admin') {
      if (store.user_id !== req.user.id) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }
    }

    res.json(store);
  } catch (error) {
    console.error('매장 조회 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 매장 생성 (현재 사용자)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { storeName, address, reviewMessage, imageUrls, dailyFrequency, totalCount, draftReviews } = req.body;

    if (!storeName) {
      return res.status(400).json({ error: '매장명을 입력하세요.' });
    }

    const dailyFreq = dailyFrequency || 1;
    const totalCnt = totalCount || 1;

    // ✓ 검증: 총 발행 횟수는 일발행 횟수 이상이어야 함
    if (totalCnt < dailyFreq) {
      return res.status(400).json({ error: `총 발행 횟수는 일발행 횟수(${dailyFreq}회) 이상이어야 합니다.` });
    }

    // imageUrls 배열 검증 및 정리
    const processedImageUrls = Array.isArray(imageUrls) 
      ? imageUrls.filter(url => typeof url === 'string' && url.trim().length > 0 && url.trim().startsWith('http'))
      : [];

    // 오늘 날짜 (YYYY-MM-DD 형식)
    const today = new Date().toISOString().split('T')[0];

    // 📌 새 매장 생성 (각 업로드를 개별적으로 저장)
    const { data, error } = await supabase
      .from('stores')
      .insert([
        {
          store_name: storeName,
          address: address || null,
          review_message: reviewMessage || null,
          draft_reviews: draftReviews || '',
          image_urls: processedImageUrls,
          daily_frequency: dailyFreq,
          total_count: totalCnt,  // 입력받은 값을 그대로 저장 (통합하지 않음)
          deployed_count: 0,
          user_id: req.user.id,
          created_at: new Date().toISOString(),
        },
      ])
      .select();

    if (error) throw error;

    res.json({ message: `매장 "${storeName}"이 등록되었습니다. (총 발행량: ${totalCnt})`, store: data[0] });
  } catch (error) {
    console.error('매장 생성 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

  // 이미지 업로드: POST /api/stores/:id/images (서버에서 리사이즈 후 업로드)
  router.post('/:id/images', authMiddleware, upload.array('images', 2), async (req, res) => {
    try {
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'google';

      // 권한 검증: Admin 아니면 자신의 매장만 가능
      const { data: store, error: fetchError } = await supabase
        .from('stores')
        .select('id, user_id, image_urls')
        .eq('id', req.params.id)
        .single();

      if (fetchError || !store) return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
      if (req.user.role !== 'admin' && store.user_id !== req.user.id) {
        return res.status(403).json({ error: '권한이 없습니다.' });
      }

      const files = req.files || [];
      if (files.length === 0) return res.status(400).json({ error: '업로드할 이미지가 없습니다.' });

      const uploadedUrls = [];

      for (const file of files) {
        try {
          let path;
          let contentType;
          let safeNameBase = `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

          if (sharp) {
            // 서버사이드 리사이즈/압축: JPEG 변환, 최대 너비 1920px, 반복 압축으로 2MB 이하 목표
            let quality = 80;
            let processed = await sharp(file.buffer)
              .rotate()
              .resize({ width: 1920, withoutEnlargement: true })
              .jpeg({ quality })
              .toBuffer();

            while (processed.length > 2 * 1024 * 1024 && quality >= 50) {
              quality -= 10;
              processed = await sharp(file.buffer)
                .rotate()
                .resize({ width: Math.round(1920 * (quality / 80)), withoutEnlargement: true })
                .jpeg({ quality })
                .toBuffer();
            }

            if (processed.length > 2 * 1024 * 1024) {
              console.warn('이미지 처리 후에도 2MB 초과:', file.originalname, processed.length);
              // 더 강하게 리사이즈하여 올리기 (작게)
              processed = await sharp(file.buffer)
                .rotate()
                .resize({ width: 1024, withoutEnlargement: true })
                .jpeg({ quality: 50 })
                .toBuffer();
            }

            const safeName = `${safeNameBase}.jpg`;
            const todayFolder = new Date().toISOString().split('T')[0];
            path = `stores/${todayFolder}/${safeName}`;

            const { data: uploadData, error: uploadError } = await supabase.storage
              .from(bucket)
              .upload(path, processed, { contentType: 'image/jpeg' });

            if (uploadError) {
              console.error('Storage upload error:', uploadError);
              continue;
            }

            const { data: publicData } = await supabase.storage.from(bucket).getPublicUrl(path);
            uploadedUrls.push(publicData?.publicUrl || null);
          } else {
            // sharp 미설치인 경우: 원본 업로드(단, 파일 크기 제한 검사)
            if (file.size > 2 * 1024 * 1024) {
              console.warn('sharp 미설치, 파일 크기가 2MB 초과하여 업로드를 건너뜁니다:', file.originalname, file.size);
              continue;
            }

            const safeName = `${safeNameBase}`;
            const todayFolder = new Date().toISOString().split('T')[0];
            path = `stores/${todayFolder}/${safeName}`;
            contentType = file.mimetype || 'application/octet-stream';

            const { data: uploadData, error: uploadError } = await supabase.storage
              .from(bucket)
              .upload(path, file.buffer, { contentType });

            if (uploadError) {
              console.error('Storage upload error:', uploadError);
              continue;
            }

            const { data: publicData } = await supabase.storage.from(bucket).getPublicUrl(path);
            uploadedUrls.push(publicData?.publicUrl || null);
          }
        } catch (innerErr) {
          console.error('이미지 처리/업로드 실패:', innerErr);
        }
      }

      // Update store record image_urls by appending new urls
      const existingUrls = (store.image_urls && Array.isArray(store.image_urls)) ? store.image_urls : [];
      const finalUrls = existingUrls.concat(uploadedUrls.filter(Boolean));

      const { data: updatedStore, error: updateError } = await supabase
        .from('stores')
        .update({ image_urls: finalUrls, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select();

      if (updateError) throw updateError;

      res.json({ message: '이미지 업로드 완료', urls: uploadedUrls, store: updatedStore[0] });
    } catch (error) {
      console.error('이미지 업로드 오류:', error);
      res.status(500).json({ error: '이미지 업로드 중 오류가 발생했습니다.' });
    }
  });

// 매장 수정 (자신의 매장만)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { storeName, address, reviewMessage, imageUrls, dailyFrequency, totalCount, draftReviews } = req.body;

    if (!storeName) {
      return res.status(400).json({ error: '매장명을 입력하세요.' });
    }

    const dailyFreq = dailyFrequency || 1;
    const totalCnt = totalCount || 1;

    // ✓ 검증: 총 발행 횟수는 일발행 횟수 이상이어야 함
    if (totalCnt < dailyFreq) {
      return res.status(400).json({ error: `총 발행 횟수는 일발행 횟수(${dailyFreq}회) 이상이어야 합니다.` });
    }

    // 매장 조회 및 권한 검증
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('id, user_id, store_name, created_at, total_count, deployed_count')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    // 🔐 권한 검증: Admin이 아니면 자신의 매장만 수정 가능
    if (req.user.role !== 'admin') {
      if (store.user_id !== req.user.id) {
        return res.status(403).json({ error: '이 매장을 수정할 권한이 없습니다.' });
      }
    }

    // imageUrls 배열 검증 및 정리
    const processedImageUrls = Array.isArray(imageUrls) 
      ? imageUrls.filter(url => typeof url === 'string' && url.trim().length > 0 && url.trim().startsWith('http'))
      : [];

    // 매장 등록일 (YYYY-MM-DD 형식)
    const storeDate = store.created_at.split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    const isToday = storeDate === today;

    // 매장 이름이 변경되었는지 확인
    if (storeName !== store.store_name) {
      // 새로운 이름으로 같은 날짜에 등록된 매장이 있는지 확인
      const { data: existingStores, error: checkError } = await supabase
        .from('stores')
        .select('id, total_count, created_at')
        .eq('store_name', storeName)
        .eq('user_id', req.user.id);

      if (checkError) throw checkError;

      if (existingStores && existingStores.length > 0) {
        // 같은 등록일에 등록된 매장들 필터링
        const targetStores = existingStores.filter(s => {
          const existingDate = s.created_at.split('T')[0];
          return existingDate === storeDate;
        });

        if (targetStores && targetStores.length > 0) {
          // 📌 같은 날짜에 같은 새 이름의 매장들이 있으면, 모두 통합
          const sumOfTargets = targetStores.reduce((sum, s) => sum + (s.total_count || 0), 0);
          const mergedTotalCount = sumOfTargets + totalCnt;

          // 모든 같은 날짜의 대상 매장들의 total_count를 통합값으로 업데이트
          for (const targetStore of targetStores) {
            await supabase
              .from('stores')
              .update({
                total_count: mergedTotalCount,
                updated_at: new Date().toISOString(),
              })
              .eq('id', targetStore.id);
          }

          // 현재 매장도 같은 merged값으로 업데이트 후 이름 변경
          const { data: updatedStore, error: updateError } = await supabase
            .from('stores')
            .update({
              store_name: storeName,
              total_count: mergedTotalCount,
              deployed_count: store.deployed_count || 0,
              updated_at: new Date().toISOString(),
            })
            .eq('id', req.params.id)
            .select();

          if (updateError) throw updateError;

          return res.json({ 
            message: `매장 이름이 변경되었습니다. (같은 날짜 매장들 통합: 총 발행량 ${mergedTotalCount})`, 
            store: updatedStore[0]
          });
        }
      }
    }

    // 📌 현재 매장의 total_count가 변경되었고, 오늘 등록된 같은 이름 매장들이 있으면 함께 업데이트
    if (isToday && totalCnt !== store.total_count) {
      const { data: sameNameStores, error: checkError } = await supabase
        .from('stores')
        .select('id, total_count, created_at')
        .eq('store_name', storeName)
        .eq('user_id', req.user.id)
        .neq('id', req.params.id);

      if (checkError) throw checkError;

      if (sameNameStores && sameNameStores.length > 0) {
        // 같은 날짜의 매장들 필터링
        const todayStores = sameNameStores.filter(s => {
          const existingDate = s.created_at.split('T')[0];
          return existingDate === today;
        });

        if (todayStores && todayStores.length > 0) {
          // 모든 같은 날짜 매장들의 합 + 새 total_count = 최종값
          const sumOfExisting = todayStores.reduce((sum, s) => sum + (s.total_count || 0), 0);
          const newFinalTotalCount = sumOfExisting + totalCnt;

          // 모든 같은 날짜 매장들의 total_count를 최종값으로 통일
          for (const sameStore of todayStores) {
            await supabase
              .from('stores')
              .update({
                total_count: newFinalTotalCount,
                updated_at: new Date().toISOString(),
              })
              .eq('id', sameStore.id);
          }

          // 현재 매장도 최종값으로 업데이트
          const { data: updatedStore, error: updateError } = await supabase
            .from('stores')
            .update({
              store_name: storeName,
              address: address || null,
              review_message: reviewMessage || null,
              draft_reviews: draftReviews || '',
              image_urls: processedImageUrls,
              daily_frequency: dailyFreq,
              total_count: newFinalTotalCount,
              deployed_count: store.deployed_count || 0,
              updated_at: new Date().toISOString(),
            })
            .eq('id', req.params.id)
            .select();

          if (updateError) throw updateError;

          return res.json({ 
            message: `매장이 수정되었습니다. (같은 날짜 매장들 통합: 총 발행량 ${newFinalTotalCount})`,
            store: updatedStore[0] 
          });
        }
      }
    }

    // 일반적인 수정 (같은 날짜 다른 매장 없음)
    const { data, error } = await supabase
      .from('stores')
      .update({
        store_name: storeName,
        address: address || null,
        review_message: reviewMessage || null,
        draft_reviews: draftReviews || '',
        image_urls: processedImageUrls,
        daily_frequency: dailyFreq,
        total_count: totalCnt,
        deployed_count: store.deployed_count || 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;

    res.json({ message: '매장이 수정되었습니다.', store: data[0] });
  } catch (error) {
    console.error('매장 수정 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 이미지 삭제: DELETE /api/stores/:id/images  body: { url }
router.delete('/:id/images', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'google';

    if (!url) return res.status(400).json({ error: '삭제할 이미지 URL을 제공하세요.' });

    // 매장 조회 및 권한 확인
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('id, user_id, image_urls')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    if (req.user.role !== 'admin' && store.user_id !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다.' });
    }

    // public url에서 path 추출 (bucket 뒤부분)
    // 공용 URL 예: https://<project>.supabase.co/storage/v1/object/public/<bucket>/stores/123/name.jpg
    const marker = `/storage/v1/object/public/${bucket}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) {
      // try alternative: if url contains bucket directly
      const alt = `/${bucket}/`;
      const idx2 = url.indexOf(alt);
      if (idx2 === -1) return res.status(400).json({ error: '이미지 경로를 파싱할 수 없습니다.' });
      const path = url.substring(idx2 + alt.length);
      // remove object
      const { error: removeErr } = await supabase.storage.from(bucket).remove([path]);
      if (removeErr) console.warn('Supabase remove warning:', removeErr);
    } else {
      const path = url.substring(idx + marker.length);
      const { error: removeErr } = await supabase.storage.from(bucket).remove([path]);
      if (removeErr) console.warn('Supabase remove warning:', removeErr);
    }

    // DB에서 URL 제거
    const newUrls = (store.image_urls || []).filter(u => u !== url);
    const { data: updatedStore, error: updateError } = await supabase
      .from('stores')
      .update({ image_urls: newUrls, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select();

    if (updateError) throw updateError;

    res.json({ message: '이미지 삭제 완료', store: updatedStore[0] });
  } catch (error) {
    console.error('이미지 삭제 오류:', error);
    res.status(500).json({ error: '이미지 삭제 중 오류가 발생했습니다.' });
  }
});

// 📌 매장의 배포 횟수 증가
router.patch('/:id/deploy', authMiddleware, async (req, res) => {
  try {
    // 매장 조회
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('id, user_id, deployed_count, total_count')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    // 🔐 권한 검증: Admin만 배포 가능
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '배포 권한이 없습니다.' });
    }

    // 배포 횟수가 총발행량을 초과하지 않도록 확인
    const currentDeployed = store.deployed_count || 0;
    const totalCount = store.total_count || 1;
    
    if (currentDeployed >= totalCount) {
      return res.status(400).json({ error: `이미 모든 발행이 완료되었습니다. (${currentDeployed}/${totalCount})` });
    }

    // deployed_count 1 증가
    const { data: updatedStore, error: updateError } = await supabase
      .from('stores')
      .update({
        deployed_count: currentDeployed + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select();

    if (updateError) throw updateError;

    res.json({ 
      message: `배포가 완료되었습니다. (${currentDeployed + 1}/${totalCount})`,
      store: updatedStore[0] 
    });
  } catch (error) {
    console.error('배포 횟수 업데이트 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 매장 삭제 (자신의 매장만)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    // 매장 조회 및 권한 검증
    const { data: store, error: fetchError } = await supabase
      .from('stores')
      .select('id, user_id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !store) {
      return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
    }

    // 🔐 권한 검증: Admin이 아니면 자신의 매장만 삭제 가능
    if (req.user.role !== 'admin') {
      if (store.user_id !== req.user.id) {
        return res.status(403).json({ error: '이 매장을 삭제할 권한이 없습니다.' });
      }
    }

    const { error } = await supabase
      .from('stores')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ message: '매장이 삭제되었습니다.' });
  } catch (error) {
    console.error('매장 삭제 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// AI 리뷰 생성 엔드포인트 (Ollama)
router.post('/generate-review', authMiddleware, async (req, res) => {
  try {
    const { guidance } = req.body;

    if (!guidance || guidance.trim().length === 0) {
      return res.status(400).json({ error: '리뷰 가이드를 입력하세요.' });
    }

    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const ollamaModel = process.env.OLLAMA_MODEL || 'neural-chat';

    // 프롬프트 구성 (한글 리뷰 생성용)
    const prompt = `다음 가이드를 바탕으로 구글맵 리뷰를 한글로 자연스럽게 작성해주세요. 150자 이내로, 존댓말로 작성하세요.
가이드: ${guidance.trim()}

리뷰: `;

    console.log(`🤖 Ollama 호출: ${ollamaUrl}/api/generate (모델: ${ollamaModel})`);

    // Ollama API 호출
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          top_k: 40,
          repeat_penalty: 1.1,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Ollama API 오류:', response.status, errorText);
      
      // 연결 오류인 경우
      if (response.status === 0 || !response.ok) {
        return res.status(503).json({
          error: 'AI 서비스 연결 실패',
          details: 'Ollama가 실행 중이지 않습니다. 터미널에서 "ollama run neural-chat" 실행하세요.',
        });
      }
      
      return res.status(500).json({
        error: 'AI 리뷰 생성 실패',
        details: errorText,
      });
    }

    const data = await response.json();
    
    if (!data.response) {
      return res.status(500).json({
        error: 'AI 응답 형식 오류',
        details: '모델에서 응답을 받지 못했습니다.',
      });
    }

    let reviewText = data.response.trim();

    // 프롬프트 제거 (응답에 프롬프트가 포함되어 있을 경우)
    if (reviewText.includes('리뷰:')) {
      const parts = reviewText.split('리뷰:');
      reviewText = parts[parts.length - 1].trim();
    }

    // 첫 번째 문장이나 150자 이내로 정리
    const lines = reviewText.split('\n').filter(l => l.trim().length > 0);
    const finalReview = lines.length > 0 
      ? lines[0].substring(0, 150).trim()
      : reviewText.substring(0, 150).trim();

    console.log(`✅ AI 리뷰 생성 완료: ${finalReview.substring(0, 50)}...`);

    res.json({
      review: finalReview,
      source: 'Ollama',
      model: ollamaModel,
    });
  } catch (error) {
    console.error('리뷰 생성 오류:', error);
    res.status(500).json({ 
      error: '리뷰 생성 중 오류가 발생했습니다.',
      details: error.message 
    });
  }
});

// 다중 AI 리뷰 생성 엔드포인트
router.post('/generate-reviews', authMiddleware, async (req, res) => {
  try {
    const { guidance, count } = req.body;

    console.log('🤖 AI 리뷰 생성 요청:', { guidance, count });

    if (!guidance || guidance.trim().length === 0) {
      console.error('❌ 리뷰 가이드 없음');
      return res.status(400).json({ error: '리뷰 가이드를 입력하세요.' });
    }

    const reviewCount = Math.min(Math.max(1, parseInt(count) || 1), 100);
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const ollamaModel = process.env.OLLAMA_MODEL || 'neural-chat';

    console.log(`🔧 설정: URL=${ollamaUrl}, 모델=${ollamaModel}, 생성 개수=${reviewCount}`);

    const generatedReviews = [];

    // 순차적으로 리뷰 생성
    for (let i = 0; i < reviewCount; i++) {
      const prompt = `다음 가이드를 바탕으로 구글맵 리뷰를 한글로 자연스럽게 작성해주세요. 100자 이내로, 존댓말로 작성하세요.
가이드: ${guidance.trim()}

리뷰: `;

      try {
        console.log(`📤 Ollama 요청 시작 (${i + 1}/${reviewCount}): ${ollamaUrl}/api/generate`);
        
        // AbortController로 타임아웃 설정 (120초)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          console.error(`⏰ 타임아웃 (${i + 1}/${reviewCount}): 120초 초과`);
          controller.abort();
        }, 120000);

        const response = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaModel,
            prompt: prompt,
            stream: false,
            options: {
              temperature: 0.7,
              top_p: 0.9,
              top_k: 40,
              repeat_penalty: 1.1,
            },
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        console.log(`📨 Ollama 응답 받음 (${i + 1}/${reviewCount}): ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`❌ Ollama API 오류 (${i + 1}/${reviewCount}):`, response.status, errorText);
          continue; // 실패한 리뷰는 건너뛰고 계속 진행
          
        }

        const data = await response.json();
        console.log(`📦 JSON 파싱 성공 (${i + 1}/${reviewCount}), 응답 길이:`, data.response?.length);
        
        if (!data.response) {
          console.warn(`⚠️ 응답이 없음 (${i + 1}/${reviewCount}), 건너뛰기`);
          continue; // 응답이 없으면 건너뛰기
        }

        let reviewText = data.response.trim();
        console.log(`✂️ 원본 (${i + 1}/${reviewCount}):`, reviewText.substring(0, 50));

        // 프롬프트 제거
        if (reviewText.includes('리뷰:')) {
          const parts = reviewText.split('리뷰:');
          reviewText = parts[parts.length - 1].trim();
          console.log(`✂️ 정제 후 (${i + 1}/${reviewCount}):`, reviewText.substring(0, 50));
        }

        // 100자 이내로 제한
        const lines = reviewText.split('\n').filter(l => l.trim().length > 0);
        const finalReview = lines.length > 0 
          ? lines[0].substring(0, 100).trim()
          : reviewText.substring(0, 100).trim();

        if (finalReview.length > 0) {
          generatedReviews.push({
            id: Date.now() + i,
            text: finalReview,
            length: finalReview.length,
          });
          console.log(`✅ 리뷰 저장 (${i + 1}/${reviewCount}): ${finalReview.substring(0, 30)}...`);
        } else {
          console.warn(`⚠️ 최종 리뷰가 빈 문자열 (${i + 1}/${reviewCount}), 건너뛰기`);
        }
      } catch (innerError) {
        console.error(`리뷰 생성 실패 (${i + 1}/${reviewCount}):`, innerError);
        continue;
      }
    }

    if (generatedReviews.length === 0) {
      return res.status(500).json({
        error: 'AI 리뷰 생성 실패',
        details: '생성된 리뷰가 없습니다.',
      });
    }

    console.log(`✅ ${generatedReviews.length}개의 AI 리뷰 생성 완료`);

    res.json({
      reviews: generatedReviews,
      count: generatedReviews.length,
      source: 'Ollama',
      model: ollamaModel,
    });
  } catch (error) {
    console.error('다중 리뷰 생성 오류:', error);
    res.status(500).json({ 
      error: '리뷰 생성 중 오류가 발생했습니다.',
      details: error.message 
    });
  }
});

module.exports = router;
