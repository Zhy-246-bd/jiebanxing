-- ============================================================
-- 结伴行 · Supabase 建表脚本（张海燕 11-16）
-- 用法：Supabase 控制台 → 左侧 SQL Editor → New query →
--       全文粘贴 → Run。看到 "Success" 即完成，无需其他操作。
--
-- 设计说明（答辩可讲）：
--   · 三张表对应原 WorkBuddy 云数据库的 rooms / room_members / room_events
--   · RLS 对 anon 键开放读写——安全性靠"6 位邀请码不可猜 + 7 天过期"兜底，
--     这是课程原型的明确取舍，不是生产级权限方案
--   · plan 用 jsonb 存三方案快照；meet_start/meet_end 用 text 存 ISO 串，
--     规避前端本地化时区换算问题
-- ============================================================

-- 1) 房间表 --------------------------------------------------
create table if not exists rooms (
  id          bigint generated always as identity primary key,
  code        text unique not null,                -- 6 位邀请码（去掉易混字符）
  city_code   text,
  city_name   text,
  dest        text,
  meet_start  text,                                -- ISO 串，如 2026-11-23T09:30
  meet_end    text,
  owner_token text,                                -- 发起人设备令牌
  status      text not null default 'open',        -- open | ready（乐观锁用）
  plan        jsonb,                               -- 三方案快照，发起人算完写入
  plan_at     timestamptz,
  expire_at   timestamptz not null default now() + interval '7 days',
  created_at  timestamptz not null default now()
);

-- 2) 成员表 --------------------------------------------------
create table if not exists room_members (
  id           bigint generated always as identity primary key,
  room_code    text not null,
  member_token text not null,                      -- 设备令牌，同一设备重复提交即更新
  name         text,
  origin       text,                               -- 出发地名（显示用）
  origin_lng   double precision,                   -- 精确坐标（11-16 新增）
  origin_lat   double precision,
  mode         text default 'transit',
  budget       numeric default 0,
  win_start    text,
  win_end      text,
  joined_at    timestamptz not null default now(),
  updated_at   timestamptz,
  removed_at   timestamptz                         -- 软删：移除成员只打时间戳
);

-- 3) 事件流水表 ----------------------------------------------
create table if not exists room_events (
  id         bigint generated always as identity primary key,
  room_code  text,
  kind       text,                                 -- create | join | generate ...
  actor      text,
  detail     text,
  created_at timestamptz not null default now()
);

-- 4) RLS：对 anon 键开放读写（课程原型的安全取舍）------------
alter table rooms        enable row level security;
alter table room_members enable row level security;
alter table room_events  enable row level security;

drop policy if exists "anon_all_rooms"        on rooms;
drop policy if exists "anon_all_members"      on room_members;
drop policy if exists "anon_all_events"       on room_events;

create policy "anon_all_rooms"   on rooms        for all to anon using (true) with check (true);
create policy "anon_all_members" on room_members for all to anon using (true) with check (true);
create policy "anon_all_events"  on room_events  for all to anon using (true) with check (true);
