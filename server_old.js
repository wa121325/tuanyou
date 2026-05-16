// server.js - 社区团购后端主文件
// 运行：node server.js
// 依赖：npm install express mysql2 jsonwebtoken bcryptjs cors dayjs

const express    = require('express');
const mysql      = require('mysql2/promise');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const cors       = require('cors');
const dayjs      = require('dayjs');

const app = express();
app.use(cors());
app.use(express.json());

// ===== 数据库连接池 =====
const db = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || 'your_password',
  database: process.env.DB_NAME     || 'tuanyou',
  waitForConnections: true,
  connectionLimit: 10,
});

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';

// ===== 中间件：小程序用户鉴权 =====
async function authUser(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({code: 401, msg: '未登录'});
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({code: 401, msg: 'token已过期'});
  }
}

// ===== 中间件：管理员鉴权 =====
async function authAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({code: 401, msg: '未登录'});
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.isAdmin) return res.status(403).json({code: 403, msg: '无权限'});
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({code: 401, msg: 'token已过期'});
  }
}

const ok  = (res, data) => res.json({code: 0, data});
const err = (res, msg, code=400) => res.status(code).json({code, msg});

// ============================================================
// 小程序接口
// ============================================================

// --- 登录 ---
app.post('/api/user/login', async (req, res) => {
  const {code} = req.body;
  if (!code) return err(res, '缺少code');

  // 换取openid（需替换为你的appid和secret）
  const wxRes = await fetch(
    `https://api.weixin.qq.com/sns/jscode2session?appid=${process.env.WX_APPID}&secret=${process.env.WX_SECRET}&js_code=${code}&grant_type=authorization_code`
  ).then(r => r.json());

  if (!wxRes.openid) return err(res, '微信登录失败');

  const [rows] = await db.query('SELECT * FROM users WHERE openid=?', [wxRes.openid]);
  let user = rows[0];
  if (!user) {
    const [result] = await db.query('INSERT INTO users (openid) VALUES (?)', [wxRes.openid]);
    user = {id: result.insertId, openid: wxRes.openid};
  }

  const token = jwt.sign({uid: user.id, openid: user.openid}, JWT_SECRET, {expiresIn: '30d'});
  ok(res, {token, userInfo: user});
});

// --- 用户信息 ---
app.get('/api/user/info', authUser, async (req, res) => {
  const [rows] = await db.query('SELECT id,nickname,avatar_url,phone,points FROM users WHERE id=?', [req.user.uid]);
  ok(res, rows[0]);
});

// --- 首页数据 ---
app.get('/api/home/banners', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM banners WHERE status=1 ORDER BY sort_order');
  ok(res, rows);
});

// --- 分类列表 ---
app.get('/api/categories', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM categories WHERE status=1 ORDER BY sort_order');
  ok(res, rows);
});

// --- 商品列表 ---
app.get('/api/goods/list', async (req, res) => {
  const {categoryId, type, page=1, size=10} = req.query;
  let sql = 'SELECT * FROM goods WHERE status=1';
  const params = [];
  if (categoryId) { sql += ' AND category_id=?'; params.push(categoryId); }
  if (type === 'flash') { sql += ' AND is_flash=1'; }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(size), (Number(page)-1)*Number(size));
  const [rows] = await db.query(sql, params);
  ok(res, rows);
});

// --- 商品详情 ---
app.get('/api/goods/:id', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM goods WHERE id=? AND status=1', [req.params.id]);
  if (!rows[0]) return err(res, '商品不存在', 404);
  // 查进行中的拼团
  const [groups] = await db.query(
    'SELECT * FROM group_sessions WHERE goods_id=? AND status=0 AND expire_at>NOW() ORDER BY created_at DESC LIMIT 5',
    [req.params.id]
  );
  ok(res, {...rows[0], activeGroups: groups});
});

// --- 拼团中商品 ---
app.get('/api/goods/group', async (req, res) => {
  const {page=1, size=10} = req.query;
  const [rows] = await db.query(
    `SELECT g.*, COUNT(gs.id) as active_groups
     FROM goods g
     LEFT JOIN group_sessions gs ON gs.goods_id=g.id AND gs.status=0 AND gs.expire_at>NOW()
     WHERE g.status=1
     GROUP BY g.id
     ORDER BY active_groups DESC
     LIMIT ? OFFSET ?`,
    [Number(size), (Number(page)-1)*Number(size)]
  );
  ok(res, rows);
});

// --- 开团 ---
app.post('/api/groups/start', authUser, async (req, res) => {
  const {goodsId} = req.body;
  const [goods] = await db.query('SELECT * FROM goods WHERE id=? AND status=1 AND stock>0', [goodsId]);
  if (!goods[0]) return err(res, '商品不存在或已售罄');

  const expireAt = dayjs().add(goods[0].group_hours, 'hour').format('YYYY-MM-DD HH:mm:ss');
  const [result] = await db.query(
    'INSERT INTO group_sessions (goods_id, leader_id, group_size, join_count, expire_at) VALUES (?,?,?,1,?)',
    [goodsId, req.user.uid, goods[0].group_size, expireAt]
  );
  ok(res, {groupSessionId: result.insertId, expireAt});
});

// --- 参团/创建订单 ---
app.post('/api/orders/create', authUser, async (req, res) => {
  const {goodsId, groupSessionId, qty=1, stationId} = req.body;
  const [goods] = await db.query('SELECT * FROM goods WHERE id=? AND status=1', [goodsId]);
  if (!goods[0]) return err(res, '商品不存在');
  if (goods[0].stock < qty) return err(res, '库存不足');

  const orderNo = `SQ${Date.now()}${req.user.uid}`;
  const totalAmount = (goods[0].group_price * qty).toFixed(2);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT INTO orders (order_no,user_id,group_session_id,station_id,goods_id,goods_name,goods_spec,goods_cover,unit_price,qty,total_amount,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)',
      [orderNo, req.user.uid, groupSessionId||null, stationId||null, goodsId, goods[0].name, goods[0].spec, goods[0].cover, goods[0].group_price, qty, totalAmount]);
    await conn.query('UPDATE goods SET stock=stock-? WHERE id=?', [qty, goodsId]);
    if (groupSessionId) {
      await conn.query('UPDATE group_sessions SET join_count=join_count+1 WHERE id=?', [groupSessionId]);
    }
    await conn.commit();
    ok(res, {orderNo, totalAmount});
  } catch(e) {
    await conn.rollback();
    err(res, '创建订单失败');
  } finally {
    conn.release();
  }
});

// --- 订单列表 ---
app.get('/api/orders', authUser, async (req, res) => {
  const {status, page=1, size=10} = req.query;
  let sql = 'SELECT * FROM orders WHERE user_id=?';
  const params = [req.user.uid];
  if (status !== undefined && status !== '') { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(size), (Number(page)-1)*Number(size));
  const [rows] = await db.query(sql, params);
  ok(res, rows);
});

// --- 确认收货 ---
app.post('/api/orders/:id/receive', authUser, async (req, res) => {
  await db.query('UPDATE orders SET status=3 WHERE id=? AND user_id=? AND status=2', [req.params.id, req.user.uid]);
  ok(res, null);
});

// --- 购物车 ---
app.get('/api/cart/list', authUser, async (req, res) => {
  const [rows] = await db.query(
    'SELECT c.*, g.name, g.cover, g.group_price, g.original_price, g.spec, g.stock FROM cart_items c JOIN goods g ON g.id=c.goods_id WHERE c.user_id=?',
    [req.user.uid]
  );
  ok(res, rows);
});
app.post('/api/cart/add', authUser, async (req, res) => {
  const {goodsId, qty=1} = req.body;
  await db.query('INSERT INTO cart_items (user_id,goods_id,qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=qty+?',
    [req.user.uid, goodsId, qty, qty]);
  ok(res, null);
});
app.post('/api/cart/update', authUser, async (req, res) => {
  const {goodsId, qty} = req.body;
  if (qty <= 0) {
    await db.query('DELETE FROM cart_items WHERE user_id=? AND goods_id=?', [req.user.uid, goodsId]);
  } else {
    await db.query('UPDATE cart_items SET qty=? WHERE user_id=? AND goods_id=?', [qty, req.user.uid, goodsId]);
  }
  ok(res, null);
});
app.get('/api/cart/count', authUser, async (req, res) => {
  const [rows] = await db.query('SELECT SUM(qty) as count FROM cart_items WHERE user_id=?', [req.user.uid]);
  ok(res, {count: rows[0].count || 0});
});

// --- 自提站点 ---
app.get('/api/stations', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM stations WHERE status=1');
  ok(res, rows);
});

// ============================================================
// 后台管理接口
// ============================================================

// --- 管理员登录 ---
app.post('/api/admin/login', async (req, res) => {
  const {username, password} = req.body;
  const [rows] = await db.query('SELECT * FROM admins WHERE username=?', [username]);
  if (!rows[0]) return err(res, '用户名或密码错误');
  const valid = await bcrypt.compare(password, rows[0].password);
  if (!valid) return err(res, '用户名或密码错误');
  await db.query('UPDATE admins SET last_login=NOW() WHERE id=?', [rows[0].id]);
  const token = jwt.sign({adminId: rows[0].id, isAdmin: true, role: rows[0].role}, JWT_SECRET, {expiresIn: '7d'});
  ok(res, {token});
});

// --- 数据看板 ---
app.get('/api/admin/stats/today', authAdmin, async (req, res) => {
  const today = dayjs().format('YYYY-MM-DD');
  const [[orders]]  = await db.query("SELECT COUNT(*) as count, IFNULL(SUM(total_amount),0) as revenue FROM orders WHERE DATE(created_at)=? AND status!=4", [today]);
  const [[groups]]  = await db.query("SELECT COUNT(*) as success FROM group_sessions WHERE DATE(created_at)=? AND status=1", [today]);
  const [[users]]   = await db.query("SELECT COUNT(*) as count FROM users WHERE DATE(created_at)=?", [today]);
  ok(res, {
    revenue:    Number(orders.revenue).toFixed(2),
    orderCount: orders.count,
    groupSuccess: groups.success,
    newUsers:   users.count,
  });
});

// --- 商品管理 ---
app.get('/api/admin/goods', authAdmin, async (req, res) => {
  const {page=1, size=20, categoryId, status, keyword} = req.query;
  let sql = 'SELECT g.*,c.name as category_name FROM goods g LEFT JOIN categories c ON c.id=g.category_id WHERE 1=1';
  const params = [];
  if (categoryId) { sql += ' AND g.category_id=?'; params.push(categoryId); }
  if (status !== undefined && status !== '') { sql += ' AND g.status=?'; params.push(status); }
  if (keyword) { sql += ' AND g.name LIKE ?'; params.push(`%${keyword}%`); }
  sql += ' ORDER BY g.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(size), (Number(page)-1)*Number(size));
  const [rows] = await db.query(sql, params);
  ok(res, rows);
});

app.post('/api/admin/goods', authAdmin, async (req, res) => {
  const {name, categoryId, spec, originalPrice, groupPrice, stock, stockWarn, groupSize, groupHours, tags, detail, isFlash, isRecommend} = req.body;
  const [result] = await db.query(
    'INSERT INTO goods (name,category_id,spec,original_price,group_price,stock,stock_warn,group_size,group_hours,tags,detail,is_flash,is_recommend,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)',
    [name, categoryId, spec, originalPrice, groupPrice, stock, stockWarn||20, groupSize||3, groupHours||24, tags||'', detail||'', isFlash?1:0, isRecommend?1:0]
  );
  ok(res, {id: result.insertId});
});

app.patch('/api/admin/goods/:id/status', authAdmin, async (req, res) => {
  const {status} = req.body;
  await db.query('UPDATE goods SET status=? WHERE id=?', [status, req.params.id]);
  ok(res, null);
});

app.put('/api/admin/goods/:id', authAdmin, async (req, res) => {
  const {name, categoryId, spec, originalPrice, groupPrice, stock, tags, detail, isFlash, isRecommend} = req.body;
  await db.query(
    'UPDATE goods SET name=?,category_id=?,spec=?,original_price=?,group_price=?,stock=?,tags=?,detail=?,is_flash=?,is_recommend=? WHERE id=?',
    [name, categoryId, spec, originalPrice, groupPrice, stock, tags, detail, isFlash?1:0, isRecommend?1:0, req.params.id]
  );
  ok(res, null);
});

// --- 订单管理 ---
app.get('/api/admin/orders', authAdmin, async (req, res) => {
  const {status, page=1, size=20, keyword} = req.query;
  let sql = 'SELECT o.*,u.nickname,u.phone FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE 1=1';
  const params = [];
  if (status !== undefined && status !== '') { sql += ' AND o.status=?'; params.push(status); }
  if (keyword) { sql += ' AND (o.order_no LIKE ? OR u.phone LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(size), (Number(page)-1)*Number(size));
  const [rows] = await db.query(sql, params);
  ok(res, rows);
});

// --- 拼团管理 ---
app.get('/api/admin/groups', authAdmin, async (req, res) => {
  const {status, page=1, size=20} = req.query;
  let sql = 'SELECT gs.*,g.name as goods_name,g.group_price,u.nickname as leader_name FROM group_sessions gs LEFT JOIN goods g ON g.id=gs.goods_id LEFT JOIN users u ON u.id=gs.leader_id WHERE 1=1';
  const params = [];
  if (status !== undefined && status !== '') { sql += ' AND gs.status=?'; params.push(status); }
  sql += ' ORDER BY gs.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(size), (Number(page)-1)*Number(size));
  const [rows] = await db.query(sql, params);
  ok(res, rows);
});

// --- 用户管理 ---
app.get('/api/admin/users', authAdmin, async (req, res) => {
  const {page=1, size=20} = req.query;
  const [rows] = await db.query('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [Number(size), (Number(page)-1)*Number(size)]);
  ok(res, rows);
});

// --- 定时任务：检查超时未成团的拼团（每分钟执行一次）---
setInterval(async () => {
  try {
    // 找到已超时但还是进行中的拼团
    const [expired] = await db.query(
      'SELECT * FROM group_sessions WHERE status=0 AND expire_at<=NOW()'
    );
    for (const g of expired) {
      if (g.join_count >= g.group_size) {
        // 人数足够 → 成团，订单变为配送中
        await db.query('UPDATE group_sessions SET status=1 WHERE id=?', [g.id]);
        await db.query('UPDATE orders SET status=2 WHERE group_session_id=? AND status=1', [g.id]);
      } else {
        // 人数不足 → 未成团，订单退款
        await db.query('UPDATE group_sessions SET status=2 WHERE id=?', [g.id]);
        await db.query('UPDATE orders SET status=5 WHERE group_session_id=? AND status=1', [g.id]);
        // 恢复库存
        const [orders] = await db.query('SELECT * FROM orders WHERE group_session_id=?', [g.id]);
        for (const o of orders) {
          await db.query('UPDATE goods SET stock=stock+? WHERE id=?', [o.qty, o.goods_id]);
        }
      }
    }
  } catch(e) {
    console.error('定时检查拼团失败:', e.message);
  }
}, 60 * 1000);

// 启动
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 服务启动 http://localhost:${PORT}`));
