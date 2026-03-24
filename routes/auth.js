const express = require('express');
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabaseClient');
const authMiddleware = require('../auth-middleware');

const router = express.Router();

// 로그인
router.post('/login', async (req, res) => {
  const { userId, password } = req.body;

  if (!userId || !password) {
    return res.status(400).json({ error: '아이디와 비번을 입력하세요.' });
  }

  try {
    // 사용자 조회
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (fetchError || !user) {
      return res.status(401).json({ error: '아이디 또는 비번이 잘못되었습니다.' });
    }

    // 비밀번호 검증
    const isPasswordValid = await bcryptjs.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: '아이디 또는 비번이 잘못되었습니다.' });
    }

    // JWT 토큰 생성
    const token = jwt.sign(
      { id: user.id, userId: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        userId: user.user_id,
        role: user.role,
        superiorName: user.superior_name,
      },
    });
  } catch (error) {
    console.error('로그인 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 회원가입 (관리자만 가능 - 현재 로그인된 사용자가 상위명이 됨)
router.post('/register', authMiddleware, async (req, res) => {
  const { userId, password, role } = req.body;
  const currentUserId = req.user.userId; // 현재 로그인된 사용자

  if (!userId || !password) {
    return res.status(400).json({ error: '아이디와 비번을 입력하세요.' });
  }

  try {
    // 이미 존재하는 아이디 체크
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('user_id', userId);

    if (existing && existing.length > 0) {
      return res.status(400).json({ error: '이미 존재하는 아이디입니다.' });
    }

    // 비밀번호 해시화
    const hashedPassword = await bcryptjs.hash(password, 10);

    // 사용자 생성 - 상위명을 현재 로그인된 사용자 아이디로 설정
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([
        {
          user_id: userId,
          password: hashedPassword,
          role: role || 'user',
          superior_name: currentUserId, // 현재 로그인된 사용자를 상위명으로 설정
          created_at: new Date().toISOString(),
        },
      ])
      .select();

    if (insertError) {
      console.error('사용자 생성 오류:', insertError);
      return res.status(400).json({ error: '사용자 생성에 실패했습니다.' });
    }

    res.json({ 
      message: '사용자가 생성되었습니다.', 
      user: {
        id: newUser[0].id,
        userId: newUser[0].user_id,
        role: newUser[0].role,
        superiorName: newUser[0].superior_name,
      }
    });
  } catch (error) {
    console.error('회원가입 오류:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
