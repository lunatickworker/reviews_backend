const express = require('express');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');
const { GoogleGenAI } = require('@google/genai');

const router = express.Router();
const multer = require('multer');
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('⚠️ sharp 모듈을 불러올 수 없습니다. 이미지 리사이즈 기능은 비활성화됩니다. 설치하면 자동으로 활성화됩니다.');
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // allow larger original, we'll resize server-side if sharp available

const aiStudioApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
const aiStudioEndpoint = process.env.GOOGLE_AI_STUDIO_ENDPOINT;
const aiStudioTimeout = parseInt(process.env.GOOGLE_AI_STUDIO_TIMEOUT || '120000', 10);

function getAiStudioModelFromEndpoint() {
  return 'gemini-2.5-flash-lite';
}

async function callGoogleAIStudio(prompt, timeoutMs = null) {
  if (!aiStudioApiKey) {
    throw new Error('Google AI Studio 설정이 누락되었습니다. .env에서 GOOGLE_AI_STUDIO_API_KEY를 확인하세요.');
  }

  const ai = new GoogleGenAI({
    apiKey: aiStudioApiKey,
  });

  const model = getAiStudioModelFromEndpoint();

  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: prompt,
        },
      ],
    },
  ];

  const response = await ai.models.generateContent({
    model,
    contents,
  });

  const candidate = response.candidates[0].content.parts[0].text;

  if (!candidate || typeof candidate !== 'string') {
    throw new Error('Google AI Studio 응답 형식 오류');
  }

  return candidate.trim();
}

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

    console.log('📝 POST / 매장 생성 요청:');
    console.log('   - storeName:', storeName);
    console.log('   - address:', address);
    console.log('   - reviewMessage:', reviewMessage);
    console.log('   - dailyFrequency:', dailyFrequency);
    console.log('   - totalCount:', totalCount);
    console.log('   - draftReviews:', draftReviews);
    console.log('   - imageUrls:', imageUrls);

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

    // 같은 이름 + 같은 날짜의 매장들 조회
    const { data: existingStores, error: checkError } = await supabase
      .from('stores')
      .select('id, total_count, created_at, user_id')
      .eq('store_name', storeName)
      .eq('user_id', req.user.id);

    if (checkError) throw checkError;

    console.log(`🔍 같은 매장명 "${storeName}" 조회 결과 (사용자: ${req.user.id}):`);
    console.log(`   - 전체 개수: ${existingStores?.length || 0}개`);
    if (existingStores && existingStores.length > 0) {
      console.log(`   - 데이터:`, existingStores.map(s => ({ id: s.id, total_count: s.total_count, user_id: s.user_id })));
    }

    // 오늘 등록된 같은 이름의 매장들 필터링
    const todayStores = (existingStores || []).filter(store => {
      const storeDate = store.created_at.split('T')[0];
      return storeDate === today;
    });

    console.log(`   - 오늘 등록된 개수: ${todayStores.length}개`);
    if (todayStores.length > 0) {
      console.log(`   - 오늘 데이터:`, todayStores.map(s => ({ id: s.id, total_count: s.total_count })));
    }

    let finalTotalCount = totalCnt;

    if (todayStores && todayStores.length > 0) {
      // ✅ 각 매장에 순환번호 부여 (1착, 2착, 3착...)
      // 기존 매장들의 total_count를 1부터 순서대로 업데이트
      for (let i = 0; i < todayStores.length; i++) {
        const sequenceNumber = i + 1; // 1, 2, 3, ...
        console.log(`   - 기존 업데이트: 매장ID ${todayStores[i].id} → total_count: ${sequenceNumber}`);
        
        await supabase
          .from('stores')
          .update({
            total_count: sequenceNumber,
            updated_at: new Date().toISOString(),
          })
          .eq('id', todayStores[i].id);
      }
      
      // 새 매장은 다음 번호 (길이 + 1)
      finalTotalCount = todayStores.length + 1;
      console.log(`📊 새 매장 순번: ${finalTotalCount}`);
    }

    // 📌 새 매장 생성 (deployed_count: 0)
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
          total_count: finalTotalCount,
          deployed_count: 0,
          user_id: req.user.id,
          created_at: new Date().toISOString(),
        },
      ])
      .select();

    if (error) throw error;

    console.log('✅ 매장 생성 성공:');
    console.log('   - ID:', data[0]?.id);
    console.log('   - store_name:', data[0]?.store_name);
    console.log('   - draft_reviews:', data[0]?.draft_reviews);

    const message = todayStores.length > 0
      ? `매장 "${storeName}"이 추가되었습니다. (같은 날짜 매장들 통합: 총 발행량 ${finalTotalCount})`
      : `매장 "${storeName}"이 등록되었습니다. (총 발행량: ${finalTotalCount})`;

    console.log('📤 응답:', { message, store: data[0] });
    res.json({ message, store: data[0] });
  } catch (error) {
    console.error('❌ 매장 생성 오류:', error);
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

    console.log('✏️ PUT /:id 매장 수정 요청:');
    console.log('   - id:', req.params.id);
    console.log('   - storeName:', storeName);
    console.log('   - address:', address);
    console.log('   - reviewMessage:', reviewMessage);
    console.log('   - dailyFrequency:', dailyFrequency);
    console.log('   - totalCount:', totalCount);
    console.log('   - draftReviews:', draftReviews);

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
          // ✅ 각 매장에 순환번호 부여
          for (let i = 0; i < targetStores.length; i++) {
            const sequenceNumber = i + 1;
            await supabase
              .from('stores')
              .update({
                total_count: sequenceNumber,
                updated_at: new Date().toISOString(),
              })
              .eq('id', targetStores[i].id);
          }

          // 현재 매장은 다음 번호
          const currentStoreNumber = targetStores.length + 1;

          // 현재 매장도 같은 번호로 업데이트 후 이름 변경
          const { data: updatedStore, error: updateError } = await supabase
            .from('stores')
            .update({
              store_name: storeName,
              total_count: currentStoreNumber,
              deployed_count: store.deployed_count || 0,
              updated_at: new Date().toISOString(),
            })
            .eq('id', req.params.id)
            .select();

          if (updateError) throw updateError;

          return res.json({ 
            message: `매장 이름이 변경되었습니다. (같은 날짜 매장들 순번 정렬됨)`, 
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
          // ✅ 각 매장에 순환번호 부여
          for (let i = 0; i < todayStores.length; i++) {
            const sequenceNumber = i + 1;
            await supabase
              .from('stores')
              .update({
                total_count: sequenceNumber,
                updated_at: new Date().toISOString(),
              })
              .eq('id', todayStores[i].id);
          }

          // 현재 매장은 다음 번호
          const currentStoreNumber = todayStores.length + 1;

          // 현재 매장도 새 번호로 업데이트
          const { data: updatedStore, error: updateError } = await supabase
            .from('stores')
            .update({
              store_name: storeName,
              address: address || null,
              review_message: reviewMessage || null,
              draft_reviews: draftReviews || '',
              image_urls: processedImageUrls,
              daily_frequency: dailyFreq,
              total_count: currentStoreNumber,
              deployed_count: store.deployed_count || 0,
              updated_at: new Date().toISOString(),
            })
            .eq('id', req.params.id)
            .select();

          if (updateError) throw updateError;

          return res.json({ 
            message: `매장이 수정되었습니다. (같은 날짜 매장들 순번 정렬됨)`,
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

    console.log('✅ 매장 수정 성공:');
    console.log('   - ID:', data[0]?.id);
    console.log('   - store_name:', data[0]?.store_name);
    console.log('   - draft_reviews:', data[0]?.draft_reviews);

    // 📊 총발행수 변경 감지 로그
    if (totalCnt !== store.total_count) {
      console.log(`📝 매장 ID ${req.params.id} 총발행수 수정: ${store.total_count} → ${totalCnt}`);
    }

    res.json({ 
      message: totalCnt !== store.total_count 
        ? `매장이 수정되었습니다. (총발행수: ${store.total_count} → ${totalCnt})` 
        : '매장이 수정되었습니다.',
      store: data[0] 
    });
  } catch (error) {
    console.error('❌ 매장 수정 오류:', error);
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

// AI 리뷰 생성 엔드포인트 (Google AI Studio)
router.post('/generate-review', authMiddleware, async (req, res) => {
  try {
    const { guidance } = req.body;

    if (!guidance || guidance.trim().length === 0) {
      return res.status(400).json({ error: '리뷰 가이드를 입력하세요.' });
    }

    const aiModel = getAiStudioModelFromEndpoint();
    console.log(`🔍 Google AI Studio 호출: ${aiStudioEndpoint} (모델: ${aiModel})`);

    const prompt = `당신은 한국어로만 사용자 리뷰를 작성하는 전문가입니다. 한글로 작성해주세요.
아래 지시를 반드시 지키세요.

가이드: ${guidance.trim()}

요구사항:
- 반드시 한국어로만 작성
- 150자 이내
- 존댓말로 부드럽게 작성
- 여성스러운 말투로 작성
- 이모지 사용 금지
- 사용자 리뷰 내용만 작성
- 질문이나 안내 문장은 작성하지 않음

출력은 오직 한 개의 한국어 리뷰 문장으로 구성되어야 합니다.

리뷰(한국어):`;

    const responseText = await callGoogleAIStudio(prompt);
    console.log(`🤖 AI 응답 원본: "${responseText.substring(0, 150)}"`);

    let reviewText = responseText;
    if (reviewText.includes('Google Maps Review')) {
      reviewText = reviewText.split('Google Maps Review')[1].trim();
    }
    if (reviewText.includes(':')) {
      reviewText = reviewText.split(':').slice(1).join(':').trim();
    }

    const lines = reviewText.split('\n').filter(l => l.trim().length > 0);
    let finalReview = lines.length > 0 ? lines[0] : reviewText;
    finalReview = finalReview.substring(0, 150).trim();

    if (!finalReview) {
      console.error('❌ 최종 리뷰가 비어있습니다!');
      return res.status(500).json({
        error: 'AI 응답 처리 오류',
        details: '생성된 리뷰가 비어있습니다.',
        debug: { original: responseText }
      });
    }

    console.log(`✅ 최종 리뷰: "${finalReview}"`);

    return res.json({
      review: finalReview,
      source: 'Google AI Studio',
      model: aiModel,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({
        error: 'AI 서비스 응답 지연',
        details: `Google AI Studio 응답이 ${Math.floor(aiStudioTimeout / 1000)}초 이상 소요되었습니다.`,
      });
    }

    console.error('리뷰 생성 오류:', error);
    res.status(500).json({
      error: '리뷰 생성 중 오류가 발생했습니다.',
      details: error.message,
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
    const aiModel = getAiStudioModelFromEndpoint();

    console.log(`🔧 설정: endpoint=${aiStudioEndpoint}, 모델=${aiModel}, 생성 개수=${reviewCount}`);

    const generatedReviews = [];

    for (let i = 0; i < reviewCount; i++) {
      const prompt = `당신은 한국어로만 구글 지도 리뷰를 작성하는 전문가입니다. 절대 영어를 사용하지 마세요.
아래 지시를 반드시 지키세요.

가이드: ${guidance.trim()}

요구사항:
- 반드시 한국어로만 작성
- 100자 이내
- 존댓말로 작성
- 이모지 사용 금지
- 리뷰 내용만 작성
- 질문이나 안내 문장은 작성하지 않음

출력은 오직 한 개의 한국어 리뷰 문장으로 구성되어야 합니다.

리뷰(한국어):`;

      try {
        console.log(`📤 AI 요청 시작 (${i + 1}/${reviewCount})`);
        const responseText = await callGoogleAIStudio(prompt);

        let reviewText = responseText;
        if (reviewText.includes('리뷰:')) {
          reviewText = reviewText.split('리뷰:').slice(1).join('리뷰:').trim();
        }

        const lines = reviewText.split('\n').filter(l => l.trim().length > 0);
        const finalReview = (lines.length > 0 ? lines[0] : reviewText).substring(0, 100).trim();

        if (finalReview.length > 0) {
          generatedReviews.push({
            id: Date.now() + i,
            text: finalReview,
            length: finalReview.length,
          });
          console.log(`✅ 리뷰 생성 (${i + 1}/${reviewCount}): ${finalReview}`);
        } else {
          console.warn(`⚠️ 최종 리뷰가 빈 문자열 (${i + 1}/${reviewCount}), 건너뛰기`);
        }
      } catch (innerError) {
        console.error(`리뷰 생성 실패 (${i + 1}/${reviewCount}):`, innerError.message || innerError);
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
      source: 'Google AI Studio',
      model: aiModel,
    });
  } catch (error) {
    console.error('다중 리뷰 생성 오류:', error);
    res.status(500).json({
      error: '리뷰 생성 중 오류가 발생했습니다.',
      details: error.message,
    });
  }
});

module.exports = router;

