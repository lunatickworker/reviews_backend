const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY;

console.log('🔧 Supabase Config:', {
  url: supabaseUrl ? '✅ 있음' : '❌ 없음',
  key: supabaseKey ? '✅ 있음' : '❌ 없음'
});

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase configuration in .env');
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log('✅ Supabase client initialized successfully');

module.exports = supabase;
