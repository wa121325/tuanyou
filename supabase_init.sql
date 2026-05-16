-- ============================================================
-- 社区团购 Supabase 初始化 SQL
-- 在 SQL Editor 中全选粘贴，点 Run 执行
-- ============================================================

-- 用户表
CREATE TABLE users (
  id          BIGSERIAL PRIMARY KEY,
  openid      TEXT NOT NULL UNIQUE,
  nickname    TEXT DEFAULT '',
  avatar_url  TEXT DEFAULT '',
  phone       TEXT DEFAULT '',
  station_id  BIGINT DEFAULT NULL,
  points      INT DEFAULT 0,
  referrer_id BIGINT DEFAULT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 自提站点
CREATE TABLE stations (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL,
  manager    TEXT DEFAULT '',
  phone      TEXT DEFAULT '',
  status     SMALLINT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 商品分类
CREATE TABLE categories (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  emoji      TEXT DEFAULT '',
  sort_order INT DEFAULT 0,
  status     SMALLINT DEFAULT 1
);

-- 商品表
CREATE TABLE goods (
  id             BIGSERIAL PRIMARY KEY,
  category_id    BIGINT NOT NULL,
  name           TEXT NOT NULL,
  cover          TEXT DEFAULT '',
  spec           TEXT DEFAULT '',
  original_price NUMERIC(10,2) NOT NULL,
  group_price    NUMERIC(10,2) NOT NULL,
  stock          INT DEFAULT 0,
  stock_warn     INT DEFAULT 20,
  sold_count     INT DEFAULT 0,
  group_size     SMALLINT DEFAULT 3,
  group_hours    INT DEFAULT 24,
  tags           TEXT DEFAULT '',
  detail         TEXT DEFAULT '',
  is_flash       SMALLINT DEFAULT 0,
  is_recommend   SMALLINT DEFAULT 1,
  status         SMALLINT DEFAULT 1,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 拼团会话
CREATE TABLE group_sessions (
  id          BIGSERIAL PRIMARY KEY,
  goods_id    BIGINT NOT NULL,
  leader_id   BIGINT NOT NULL,
  station_id  BIGINT DEFAULT NULL,
  group_size  SMALLINT NOT NULL,
  join_count  SMALLINT DEFAULT 1,
  status      SMALLINT DEFAULT 0,  -- 0进行中 1已成团 2未成团
  expire_at   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 订单表
CREATE TABLE orders (
  id                BIGSERIAL PRIMARY KEY,
  order_no          TEXT NOT NULL UNIQUE,
  user_id           BIGINT NOT NULL,
  group_session_id  BIGINT DEFAULT NULL,
  station_id        BIGINT DEFAULT NULL,
  goods_id          BIGINT NOT NULL,
  goods_name        TEXT NOT NULL,
  goods_spec        TEXT DEFAULT '',
  goods_cover       TEXT DEFAULT '',
  unit_price        NUMERIC(10,2) NOT NULL,
  qty               INT DEFAULT 1,
  total_amount      NUMERIC(10,2) NOT NULL,
  status            SMALLINT DEFAULT 0, -- 0待付款 1拼团中 2配送中 3已完成 4已取消
  pay_time          TIMESTAMPTZ DEFAULT NULL,
  wx_transaction_id TEXT DEFAULT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- 购物车
CREATE TABLE cart_items (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  goods_id   BIGINT NOT NULL,
  qty        INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, goods_id)
);

-- 优惠券模板
CREATE TABLE coupons (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  type       SMALLINT DEFAULT 1,  -- 1满减 2折扣
  discount   NUMERIC(10,2) NOT NULL,
  min_amount NUMERIC(10,2) DEFAULT 0,
  total      INT DEFAULT 0,
  issued     INT DEFAULT 0,
  expire_at  TIMESTAMPTZ DEFAULT NULL,
  status     SMALLINT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户优惠券
CREATE TABLE user_coupons (
  id        BIGSERIAL PRIMARY KEY,
  user_id   BIGINT NOT NULL,
  coupon_id BIGINT NOT NULL,
  status    SMALLINT DEFAULT 0,  -- 0未使用 1已使用
  used_at   TIMESTAMPTZ DEFAULT NULL,
  order_id  BIGINT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Banner
CREATE TABLE banners (
  id          BIGSERIAL PRIMARY KEY,
  image_url   TEXT NOT NULL,
  title       TEXT DEFAULT '',
  target_type TEXT DEFAULT 'goods',
  target_id   BIGINT DEFAULT NULL,
  sort_order  INT DEFAULT 0,
  status      SMALLINT DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 初始数据
-- ============================================================

INSERT INTO categories (name, emoji, sort_order) VALUES
('蔬菜水果', '🥦', 1),
('肉禽蛋品', '🥩', 2),
('海鲜水产', '🐟', 3),
('粮油调味', '🍚', 4),
('乳制品',   '🥛', 5),
('日用百货', '🧴', 6);

INSERT INTO stations (name, address, manager, phone, status) VALUES
('幸福里小区站', '朝阳区幸福里小区1号楼门口', '王站长', '13800000001', 1),
('阳光里社区站', '朝阳区阳光里2区物业门口',   '李站长', '13900000022', 1),
('绿苑里站',     '朝阳区绿苑里3号楼大厅',     '赵站长', '13700000077', 0);

INSERT INTO goods (category_id, name, spec, original_price, group_price, stock, group_size, group_hours, tags, detail, is_recommend, status) VALUES
(1, '有机西兰花', '500g/份', 18.00,  8.90,  500, 3, 24, '当日采摘,有机认证,产地直发', '产地云南，有机认证，当日采摘保证新鲜。', 1, 1),
(1, '赣南脐橙',   '5斤装',  45.00, 23.90,  200, 2, 48, '果园直发,顺丰冷链',         '赣南脐橙果园直发，顺丰冷链配送到家。', 1, 1),
(2, '澳洲牛排',   '200g/块',79.00, 39.00,  100, 5, 24, '进口,冷链配送',             '澳洲谷饲牛排，冷链配送，新鲜到家。',   1, 1),
(1, '云南高原蓝莓','125g×4盒',56.00,29.00,  80,  2, 24, '产地直发,高原种植',         '云南高原蓝莓，基地直发，当日采摘。',   1, 1);

INSERT INTO banners (image_url, title, target_type, target_id, sort_order, status) VALUES
('', '新鲜有机蔬菜 限时5折', 'goods', 1, 1, 1),
('', '澳洲牛排节 大促来袭', 'category', 2, 2, 1);

-- ============================================================
-- 关闭 RLS（开发阶段，上线前要改）
-- ============================================================
ALTER TABLE users          DISABLE ROW LEVEL SECURITY;
ALTER TABLE stations       DISABLE ROW LEVEL SECURITY;
ALTER TABLE categories     DISABLE ROW LEVEL SECURITY;
ALTER TABLE goods          DISABLE ROW LEVEL SECURITY;
ALTER TABLE group_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders         DISABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items     DISABLE ROW LEVEL SECURITY;
ALTER TABLE coupons        DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_coupons   DISABLE ROW LEVEL SECURITY;
ALTER TABLE banners        DISABLE ROW LEVEL SECURITY;
