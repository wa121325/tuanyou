// server.js - 社区团购后端（Supabase版）
// 部署到 Render.com 免费套餐
// 依赖：npm install express @supabase/supabase-js jsonwebtoken cors dayjs

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const jwt  = require('jsonwebtoken');
const cors = require('cors');
const dayjs = require('dayjs');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase 客户端（用 service_role key，绕过RLS，后端专用）
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET || 'change_me_32chars_minimum';

const ok  = (res, data)          => res.json({ code: 0, data });
const err = (res, msg, code=400) => res.status(code).json({ code, msg });

async function authUser(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return err(res, '未登录', 401);
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { err(res, 'token已过期', 401); }
}

async function authAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return err(res, '未登录', 401);
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (!p.isAdmin) return err(res, '无权限', 403);
    req.admin = p; next();
  } catch { err(res, 'token已过期', 401); }
}

// ============================================================
// 小程序接口
// ============================================================

// 微信登录
app.post('/api/user/login', async (req, res) => {
  const { code } = req.body;
  if (!code) return err(res, '缺少code');

  const wxUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${process.env.WX_APPID}&secret=${process.env.WX_SECRET}&js_code=${code}&grant_type=authorization_code`;
  const wxRes = await fetch(wxUrl).then(r => r.json());
  if (!wxRes.openid) return err(res, '微信登录失败');

  let { data: user } = await supabase.from('users').select('*').eq('openid', wxRes.openid).single();
  if (!user) {
    const { data: newUser } = await supabase.from('users').insert({ openid: wxRes.openid }).select().single();
    user = newUser;
  }

  const token = jwt.sign({ uid: user.id, openid: user.openid }, JWT_SECRET, { expiresIn: '30d' });
  ok(res, { token, userInfo: user });
});

// 用户信息
app.get('/api/user/info', authUser, async (req, res) => {
  const { data } = await supabase.from('users').select('id,nickname,avatar_url,phone,points').eq('id', req.user.uid).single();
  ok(res, data);
});

app.get('/api/user/stats', authUser, async (req, res) => {
  const { count: orderCount } = await supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', req.user.uid);
  const { data: userInfo } = await supabase.from('users').select('points').eq('id', req.user.uid).single();
  ok(res, { orderCount: orderCount||0, couponAmount: 0, points: userInfo?.points||0, referralCount: 0 });
});

// Banner
app.get('/api/home/banners', async (req, res) => {
  const { data } = await supabase.from('banners').select('*').eq('status', 1).order('sort_order');
  ok(res, data||[]);
});

// 分类
app.get('/api/categories', async (req, res) => {
  const { data } = await supabase.from('categories').select('*').eq('status', 1).order('sort_order');
  ok(res, data||[]);
});

// 商品列表
app.get('/api/goods/list', async (req, res) => {
  const { categoryId, type, page=1, size=10 } = req.query;
  let query = supabase.from('goods').select('*').eq('status', 1);
  if (categoryId) query = query.eq('category_id', categoryId);
  if (type === 'flash') query = query.eq('is_flash', 1);
  query = query.order('created_at', { ascending: false }).range((page-1)*size, page*size-1);
  const { data } = await query;
  ok(res, data||[]);
});

// 秒杀商品
app.get('/api/goods/flash', async (req, res) => {
  const { data } = await supabase.from('goods').select('*').eq('status', 1).eq('is_flash', 1).limit(8);
  ok(res, data||[]);
});

// 拼团商品（首页）
app.get('/api/goods/group', async (req, res) => {
  const { page=1, size=10 } = req.query;
  const { data } = await supabase.from('goods').select('*').eq('status', 1).eq('is_recommend', 1)
    .range((page-1)*size, page*size-1);
  ok(res, data||[]);
});

// 商品详情
app.get('/api/goods/:id', async (req, res) => {
  const { data: goods } = await supabase.from('goods').select('*').eq('id', req.params.id).single();
  if (!goods) return err(res, '商品不存在', 404);
  const { data: groups } = await supabase.from('group_sessions').select('*')
    .eq('goods_id', req.params.id).eq('status', 0).gt('expire_at', new Date().toISOString()).limit(5);
  ok(res, { ...goods, activeGroups: groups||[] });
});

// 开团
app.post('/api/groups/start', authUser, async (req, res) => {
  const { goodsId, stationId } = req.body;
  const { data: goods } = await supabase.from('goods').select('*').eq('id', goodsId).single();
  if (!goods || goods.status !== 1) return err(res, '商品不存在');
  if (goods.stock <= 0) return err(res, '库存不足');

  const expireAt = dayjs().add(goods.group_hours, 'hour').toISOString();
  const { data } = await supabase.from('group_sessions').insert({
    goods_id: goodsId, leader_id: req.user.uid, station_id: stationId||null,
    group_size: goods.group_size, join_count: 1, status: 0, expire_at: expireAt
  }).select().single();
  ok(res, data);
});

// 创建订单（参团）
app.post('/api/orders/create', authUser, async (req, res) => {
  const { goodsId, groupSessionId, qty=1, stationId } = req.body;
  const { data: goods } = await supabase.from('goods').select('*').eq('id', goodsId).single();
  if (!goods) return err(res, '商品不存在');
  if (goods.stock < qty) return err(res, '库存不足');

  const orderNo = `SQ${Date.now()}${req.user.uid}`;
  const totalAmount = (goods.group_price * qty).toFixed(2);

  const { data: order, error } = await supabase.from('orders').insert({
    order_no: orderNo, user_id: req.user.uid,
    group_session_id: groupSessionId||null, station_id: stationId||null,
    goods_id: goodsId, goods_name: goods.name, goods_spec: goods.spec||'',
    goods_cover: goods.cover||'', unit_price: goods.group_price,
    qty, total_amount: totalAmount, status: 0
  }).select().single();

  if (error) return err(res, '创建订单失败: ' + error.message);

  // 减库存
  await supabase.from('goods').update({
    stock: goods.stock - qty,
    sold_count: (goods.sold_count||0) + qty
  }).eq('id', goodsId);

  // 更新拼团人数
  if (groupSessionId) {
    const { data: gs } = await supabase.from('group_sessions').select('join_count').eq('id', groupSessionId).single();
    await supabase.from('group_sessions').update({ join_count: (gs?.join_count||1) + 1 }).eq('id', groupSessionId);
  }

  ok(res, { orderNo, totalAmount, orderId: order.id });
});

// 订单列表
app.get('/api/orders', authUser, async (req, res) => {
  const { status, page=1, size=10 } = req.query;
  let query = supabase.from('orders').select('*').eq('user_id', req.user.uid);
  if (status !== undefined && status !== '') query = query.eq('status', Number(status));
  query = query.order('created_at', { ascending: false }).range((page-1)*size, page*size-1);
  const { data } = await query;
  ok(res, data||[]);
});

// 确认收货
app.post('/api/orders/:id/receive', authUser, async (req, res) => {
  await supabase.from('orders').update({ status: 3 })
    .eq('id', req.params.id).eq('user_id', req.user.uid).eq('status', 2);
  ok(res, null);
});

// 取消订单
app.post('/api/orders/:id/cancel', authUser, async (req, res) => {
  const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).eq('user_id', req.user.uid).single();
  if (!order || order.status !== 0) return err(res, '无法取消');
  await supabase.from('orders').update({ status: 4 }).eq('id', req.params.id);
  const { data: g } = await supabase.from('goods').select('stock').eq('id', order.goods_id).single();
  if (g) await supabase.from('goods').update({ stock: g.stock + order.qty }).eq('id', order.goods_id);
  ok(res, null);
});

// 购物车
app.get('/api/cart/list', authUser, async (req, res) => {
  const { data } = await supabase.from('cart_items')
    .select('*, goods(name,cover,group_price,original_price,spec,stock)')
    .eq('user_id', req.user.uid);
  ok(res, data||[]);
});

app.post('/api/cart/add', authUser, async (req, res) => {
  const { goodsId, qty=1 } = req.body;
  const { data: existing } = await supabase.from('cart_items').select('*').eq('user_id', req.user.uid).eq('goods_id', goodsId).single();
  if (existing) {
    await supabase.from('cart_items').update({ qty: existing.qty + qty }).eq('id', existing.id);
  } else {
    await supabase.from('cart_items').insert({ user_id: req.user.uid, goods_id: goodsId, qty });
  }
  ok(res, null);
});

app.post('/api/cart/update', authUser, async (req, res) => {
  const { goodsId, qty } = req.body;
  if (qty <= 0) {
    await supabase.from('cart_items').delete().eq('user_id', req.user.uid).eq('goods_id', goodsId);
  } else {
    await supabase.from('cart_items').update({ qty }).eq('user_id', req.user.uid).eq('goods_id', goodsId);
  }
  ok(res, null);
});

app.get('/api/cart/count', authUser, async (req, res) => {
  const { count } = await supabase.from('cart_items').select('*', { count: 'exact', head: true }).eq('user_id', req.user.uid);
  ok(res, { count: count||0 });
});

// 站点列表
app.get('/api/stations', async (req, res) => {
  const { data } = await supabase.from('stations').select('*').eq('status', 1);
  ok(res, data||[]);
});

// ============================================================
// 后台管理接口
// ============================================================

// 管理员登录（用Supabase Auth邮箱密码）
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return err(res, '邮箱或密码错误');
  const token = jwt.sign({ adminId: data.user.id, isAdmin: true }, JWT_SECRET, { expiresIn: '7d' });
  ok(res, { token });
});

// 数据看板
app.get('/api/admin/stats/today', authAdmin, async (req, res) => {
  const today = dayjs().format('YYYY-MM-DD');
  const { data: orders } = await supabase.from('orders').select('total_amount').gte('created_at', today).neq('status', 4);
  const revenue = (orders||[]).reduce((s, o) => s + parseFloat(o.total_amount), 0).toFixed(2);
  const { count: newUsers }    = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', today);
  const { count: groupSuccess } = await supabase.from('group_sessions').select('*', { count: 'exact', head: true }).gte('created_at', today).eq('status', 1);
  ok(res, { revenue, orderCount: (orders||[]).length, newUsers: newUsers||0, groupSuccess: groupSuccess||0 });
});

// 商品管理
app.get('/api/admin/goods', authAdmin, async (req, res) => {
  const { page=1, size=20, categoryId, status, keyword } = req.query;
  let query = supabase.from('goods').select('*, categories(name)');
  if (categoryId) query = query.eq('category_id', categoryId);
  if (status !== undefined && status !== '') query = query.eq('status', Number(status));
  if (keyword) query = query.ilike('name', `%${keyword}%`);
  query = query.order('created_at', { ascending: false }).range((page-1)*size, page*size-1);
  const { data } = await query;
  ok(res, data||[]);
});

app.post('/api/admin/goods', authAdmin, async (req, res) => {
  const { data, error } = await supabase.from('goods').insert(req.body).select().single();
  if (error) return err(res, error.message);
  ok(res, data);
});

app.put('/api/admin/goods/:id', authAdmin, async (req, res) => {
  const { data, error } = await supabase.from('goods').update({ ...req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return err(res, error.message);
  ok(res, data);
});

app.patch('/api/admin/goods/:id/status', authAdmin, async (req, res) => {
  await supabase.from('goods').update({ status: req.body.status }).eq('id', req.params.id);
  ok(res, null);
});

// 订单管理
app.get('/api/admin/orders', authAdmin, async (req, res) => {
  const { status, page=1, size=20 } = req.query;
  let query = supabase.from('orders').select('*, users(nickname, phone)');
  if (status !== undefined && status !== '') query = query.eq('status', Number(status));
  query = query.order('created_at', { ascending: false }).range((page-1)*size, page*size-1);
  const { data } = await query;
  ok(res, data||[]);
});

// 拼团管理
app.get('/api/admin/groups', authAdmin, async (req, res) => {
  const { status, page=1, size=20 } = req.query;
  let query = supabase.from('group_sessions').select('*, goods(name, group_price), users(nickname)');
  if (status !== undefined && status !== '') query = query.eq('status', Number(status));
  query = query.order('created_at', { ascending: false }).range((page-1)*size, page*size-1);
  const { data } = await query;
  ok(res, data||[]);
});

// 用户管理
app.get('/api/admin/users', authAdmin, async (req, res) => {
  const { page=1, size=20 } = req.query;
  const { data } = await supabase.from('users').select('*').order('created_at', { ascending: false }).range((page-1)*size, page*size-1);
  ok(res, data||[]);
});

// 站点管理
app.get('/api/admin/stations', authAdmin, async (req, res) => {
  const { data } = await supabase.from('stations').select('*').order('id');
  ok(res, data||[]);
});

app.post('/api/admin/stations', authAdmin, async (req, res) => {
  const { data } = await supabase.from('stations').insert(req.body).select().single();
  ok(res, data);
});

// ============================================================
// 定时检查拼团超时（每60秒）
// ============================================================
setInterval(async () => {
  const { data: expired } = await supabase.from('group_sessions')
    .select('*').eq('status', 0).lt('expire_at', new Date().toISOString());

  for (const g of (expired||[])) {
    if (g.join_count >= g.group_size) {
      // 人数足够 → 成团，订单进入配送中
      await supabase.from('group_sessions').update({ status: 1 }).eq('id', g.id);
      await supabase.from('orders').update({ status: 2 }).eq('group_session_id', g.id).eq('status', 1);
    } else {
      // 人数不足 → 未成团，取消订单恢复库存
      await supabase.from('group_sessions').update({ status: 2 }).eq('id', g.id);
      const { data: failedOrders } = await supabase.from('orders').select('goods_id, qty').eq('group_session_id', g.id);
      await supabase.from('orders').update({ status: 4 }).eq('group_session_id', g.id);
      for (const o of (failedOrders||[])) {
        const { data: goods } = await supabase.from('goods').select('stock').eq('id', o.goods_id).single();
        if (goods) await supabase.from('goods').update({ stock: goods.stock + o.qty }).eq('id', o.goods_id);
      }
    }
  }
}, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 团优后端启动 http://localhost:${PORT}`));
