/**
 * 车队添加/删除 · 密码验证流程 + esc/escJs 转义 + 源码语法完整性 + 身份入口权限单元测试（Node 零依赖，供 CI 使用）
 *
 * 原理：从源 HTML 文件直接提取被测函数（verifyPassword/confirmPwd/cancelPwd/
 * addFleet/deleteFleet/esc/escJs/checkLogin/doLogin/enterApp/applyRoleView/
 * isFleet/canEditField），在 vm 沙箱中配合 DOM/数据库替身执行——测试
 * 的是真实源码，杜绝"复制函数导致测试与实现脱节"的漂移问题。
 *
 * 运行：node tests/run_fleet_tests.js   （失败时退出码 1，CI 据此拦截）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ============ 1. 定位源文件（优先正式页面；车队功能未合并时回退测试页面） ============
const CANDIDATES = ['index.html', 'index_test.html'];
const FN_NAMES = ['verifyPassword', 'confirmPwd', 'cancelPwd', 'addFleet', 'deleteFleet', 'esc', 'escJs',
  'isFleet', 'canEditField', 'checkLogin', 'resolveFleetByPwd', 'doLogin', 'enterApp', 'applyRoleView',
  'openBatchFleet', 'closeBatchFleet', 'doBatchAssign'];

function pickSource() {
  for (const f of CANDIDATES) {
    const p = path.join(__dirname, '..', f);
    if (fs.existsSync(p)) {
      const html = fs.readFileSync(p, 'utf8');
      if (html.includes('function addFleet')) {
        console.log(`测试目标: ${f}`);
        return html;
      }
    }
  }
  console.error('❌ 未找到包含车队函数的 HTML 文件（index.html / index_test.html）');
  process.exit(1);
}

// 花括号配平提取函数体（模板字符串 ${} 的花括号天然配平，不影响计数）
function extractFunction(html, name) {
  const idx = html.indexOf(`function ${name}(`);
  if (idx === -1) throw new Error(`源码中找不到函数: ${name}`);
  let depth = 0, start = -1;
  for (let i = idx; i < html.length; i++) {
    if (html[i] === '{') { if (start === -1) start = i; depth++; }
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(idx, i + 1); }
  }
  throw new Error(`函数 ${name} 花括号未闭合（提取失败）`);
}

const HTML = pickSource();
// 前置声明被提取函数引用到的全局变量（源文件中为 let 声明，沙箱中用 var 等价初始化为初值）
const PRELUDE = `var pwdCallback = null, userRole = null, userFleet = '', loginRole = null, fleetFilter = 'all', currentPage = 1;
var fleetPws = {};
var fleets = ['一队', '二队', '三队'];
var EDITABLE_FIELDS = ['车号', '司机', '司机电话'];`;
const EXTRACTED_CODE = [PRELUDE, ...FN_NAMES.map(n => extractFunction(HTML, n))].join('\n');

// ============ 2. 沙箱工厂：每个用例全新环境（DOM 替身 + mock 数据库 + 拦截器） ============
function makeCtx() {
  const state = {
    alerts: [], confirms: [], successes: [],
    confirmReturn: true,
    inserts: [], deletes: [], updates: [],
    loadFleetsCalls: { n: 0 },
    selectedNos: []
  };
  const elements = {};
  function el(id) {
    if (!elements[id]) {
      const set = new Set();
      elements[id] = {
        value: '', style: {}, innerHTML: '',
        classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) },
        focus() {}
      };
    }
    return elements[id];
  }
  const sandbox = {
    document: {
      getElementById: el,
      body: el('body'), // 供 applyRoleView 切换 fleet-view 类
      // 供 esc() 使用：textContent 存原文，innerHTML 读取时按浏览器规则转义（& < >，不含引号）
      createElement: () => {
        let text = '';
        return {
          set textContent(v) { text = String(v); },
          get textContent() { return text; },
          get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
        };
      }
    },
    // sessionStorage 替身（供 enterApp/restoreSession 读写会话）
    sessionStorage: (() => {
      const s = {};
      return {
        getItem: k => (k in s ? s[k] : null),
        setItem: (k, v) => { s[k] = String(v); },
        removeItem: k => { delete s[k]; }
      };
    })(),
    setTimeout: () => {},  // 跳过 verifyPassword 的自动聚焦
    alert: m => state.alerts.push(m),
    confirm: m => { state.confirms.push(m); return state.confirmReturn; },
    orders: [],
    fleets: ['一队', '二队', '三队'],
    renderTable: () => {},          // applyRoleView 末尾刷新表格（沙箱内空操作）
    updateUserBadge: () => {},      // applyRoleView 末尾刷新身份徽章（沙箱内空操作）
    loadOrders: () => {},           // doBatchAssign 成功后刷新订单（沙箱内空操作）
    getSelectedOrderNos: () => state.selectedNos, // 勾选的订单号（用例可设置）
    // mock fleets 表：记录 insert/delete 调用参数
    getSupabase: () => ({
      from: table => {
        if (table !== 'fleets') throw new Error('本测试只应访问 fleets 表，实际: ' + table);
        return {
          insert: rows => ({ then: cb => { state.inserts.push(rows); cb({ error: null }); } }),
          delete: () => ({ eq: (col, val) => ({ then: cb => { state.deletes.push({ col, val }); cb({ error: null }); } }) })
        };
      }
    }),
    loadFleets: () => { state.loadFleetsCalls.n++; },
    showSuccess: m => state.successes.push(m)
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED_CODE, sandbox);
  return { fn: sandbox, el, state };
}

// ============ 3. 断言工具 ============
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
const enterPwd = (c, pwd) => { c.el('pwdInput').value = pwd; c.fn.confirmPwd(); };
const cancelPwdUI = c => c.fn.cancelPwd();
const isPwdOpen = c => c.el('pwdOverlay').classList.contains('show');

// ============ 4. 测试用例（14 项） ============
const TESTS = [
  // ---- A组：密码验证核心 ----
  ['A1 正确密码888 → 回调true并关闭弹窗', c => {
    let result = null;
    c.fn.verifyPassword(ok => { result = ok; });
    assert(isPwdOpen(c), '密码弹窗应打开');
    enterPwd(c, '888');
    assertEqual(result, true, '正确密码应回调 true');
    assert(!isPwdOpen(c), '验证成功后弹窗应关闭');
  }],
  ['A2 错误密码 → 不回调，显示错误，弹窗保持', c => {
    let called = false;
    c.fn.verifyPassword(() => { called = true; });
    enterPwd(c, '000');
    assert(!called, '错误密码不应触发回调');
    assert(isPwdOpen(c), '错误密码后弹窗应保持打开');
    assert(c.el('pwdError').style.display === 'block', '应显示错误提示');
    assert(c.el('pwdInput').value === '', '错误后输入框应清空');
  }],
  ['A3 错误后重新输入正确 → 回调true（错误恢复）', c => {
    let result = null;
    c.fn.verifyPassword(ok => { result = ok; });
    enterPwd(c, '000');
    enterPwd(c, '888');
    assertEqual(result, true, '错误后重新输入正确密码应回调 true');
    assert(!isPwdOpen(c), '弹窗应关闭');
  }],
  ['A4 取消 → 回调false并清理callback', c => {
    let result = null;
    c.fn.verifyPassword(ok => { result = ok; });
    cancelPwdUI(c);
    assertEqual(result, false, '取消应回调 false');
    assert(!isPwdOpen(c), '取消后弹窗应关闭');
    assertEqual(c.fn.pwdCallback, null, '取消后 pwdCallback 应清空');
  }],
  ['A5 打开弹窗清空残留输入/错误提示', c => {
    c.el('pwdInput').value = '999';
    c.el('pwdError').style.display = 'block';
    c.fn.verifyPassword(() => {});
    assert(c.el('pwdInput').value === '', '打开弹窗应清空上次输入');
    assert(c.el('pwdError').style.display === 'none', '打开弹窗应隐藏错误提示');
    cancelPwdUI(c);
  }],

  // ---- B组：addFleet 添加车队 ----
  ['B1 添加-空名称 → alert拦截，不弹密码', c => {
    c.el('newFleetName').value = '   ';
    c.fn.addFleet();
    assert(c.state.alerts.includes('请输入车队名称'), '空名称应 alert 提示');
    assert(!isPwdOpen(c), '空名称不应弹密码框');
    assertEqual(c.state.inserts.length, 0, '空名称不应插入');
  }],
  ['B2 添加-重名 → alert拦截，不弹密码', c => {
    c.el('newFleetName').value = '一队';
    c.fn.addFleet();
    assert(c.state.alerts.some(m => m.includes('已存在')), '重名应 alert 提示');
    assert(!isPwdOpen(c), '重名不应弹密码框');
    assertEqual(c.state.inserts.length, 0, '重名不应插入');
  }],
  ['B3 添加-有效名称+密码正确 → 插入(含车队密码)+刷新+提示', c => {
    c.el('newFleetName').value = '四队';
    c.el('newFleetPwd').value = '444';
    c.fn.addFleet();
    assert(isPwdOpen(c), '有效名称应弹密码框');
    enterPwd(c, '888');
    assertEqual(c.state.inserts, [{ 名称: '四队', 密码: '444' }], '正确密码后应插入新车队（含登录密码）');
    assertEqual(c.state.loadFleetsCalls.n, 1, '应刷新车队列表');
    assert(c.state.successes.some(m => m.includes('四队') && m.includes('已添加')), '应显示成功提示');
    assert(c.el('newFleetName').value === '', '成功后输入框应清空');
  }],
  ['B4 添加-密码取消 → 不插入', c => {
    c.el('newFleetName').value = '四队';
    c.fn.addFleet();
    cancelPwdUI(c);
    assertEqual(c.state.inserts.length, 0, '密码取消不应插入');
    assertEqual(c.state.loadFleetsCalls.n, 0, '不应刷新车队列表');
  }],
  ['B5 添加-密码输错后取消 → 不插入', c => {
    c.el('newFleetName').value = '四队';
    c.fn.addFleet();
    enterPwd(c, '000');
    cancelPwdUI(c);
    assertEqual(c.state.inserts.length, 0, '错误后取消不应插入');
  }],
  ['B6 添加-密码与其他车队重复 → alert拦截，不弹密码', c => {
    c.fn.fleetPws = { '一队': '111' };
    c.el('newFleetName').value = '四队';
    c.el('newFleetPwd').value = '111';
    c.fn.addFleet();
    assert(c.state.alerts.some(m => m.includes('已被其他车队使用')), '密码重复应 alert 提示');
    assert(!isPwdOpen(c), '密码重复不应弹密码框');
    assertEqual(c.state.inserts.length, 0, '密码重复不应插入');
  }],

  // ---- C组：deleteFleet 删除车队 ----
  ['C1 删除-车队有订单 → alert阻止，不进密码流程', c => {
    c.fn.orders.push({ 订单号: 'YD001', 车队: '一队' }, { 订单号: 'YD002', 车队: '一队' });
    c.fn.deleteFleet('一队');
    assert(c.state.alerts.some(m => m.includes('2 条订单')), '有订单时应 alert 阻止并显示订单数');
    assertEqual(c.state.confirms.length, 0, '有订单时不应弹 confirm');
    assert(!isPwdOpen(c), '有订单时不应弹密码框');
    assertEqual(c.state.deletes.length, 0, '有订单时不应删除');
  }],
  ['C2 删除-confirm取消 → 不弹密码，不删除', c => {
    c.state.confirmReturn = false;
    c.fn.deleteFleet('一队');
    assertEqual(c.state.confirms.length, 1, '应弹出 confirm 确认');
    assert(!isPwdOpen(c), 'confirm 取消不应弹密码框');
    assertEqual(c.state.deletes.length, 0, 'confirm 取消不应删除');
  }],
  ['C3 删除-密码正确 → 按名称删除+刷新+提示', c => {
    c.fn.deleteFleet('一队');
    assert(isPwdOpen(c), 'confirm 确定后应弹密码框');
    enterPwd(c, '888');
    assertEqual(c.state.deletes, [{ col: '名称', val: '一队' }], '正确密码后应按名称删除');
    assertEqual(c.state.loadFleetsCalls.n, 1, '应刷新车队列表');
    assert(c.state.successes.some(m => m.includes('一队') && m.includes('已删除')), '应显示成功提示');
  }],
  ['C4 删除-密码取消 → 不删除', c => {
    c.fn.deleteFleet('一队');
    cancelPwdUI(c);
    assertEqual(c.state.deletes.length, 0, '密码取消不应删除');
    assertEqual(c.state.loadFleetsCalls.n, 0, '不应刷新车队列表');
  }],

  // ---- D组：esc / escJs 转义（防内联 JS 注入回归） ----
  ['D1 esc 转义 HTML 特殊字符（含双引号）', c => {
    assertEqual(c.fn.esc('A"B<C>&D'), 'A&quot;B&lt;C&gt;&amp;D', 'esc 应转义 " < > &');
    assert(!c.fn.esc('A"B').includes('"'), 'esc 输出不应含裸双引号');
  }],
  ['D2 escJs 转义单引号和反斜杠（JS 字符串安全）', c => {
    assertEqual(c.fn.escJs("A'B\\C"), "A\\'B\\\\C", "escJs 应将 ' → \\' 、\\ → \\\\（JS字面量安全）");
    assertEqual(c.fn.escJs('A"B'), 'A&quot;B', 'escJs 应保留 esc 的 &quot; 转义');
  }],
  ['D3 escJs 完整链路往返：HTML解码→JS求值还原原文', c => {
    // 模拟浏览器行为：onclick 属性值先经 HTML 解码，再作为 JS 执行
    const htmlDecode = s => s
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const original = "王's\"车\\队&A<B>把'day";
    const attr = c.fn.escJs(original);            // 写入 onclick='...' 的内容
    const jsSource = `'${htmlDecode(attr)}'`;     // HTML 解码后的 JS 字符串字面量
    const evaluated = eval(`(function(){ return ${jsSource}; })()`);
    assertEqual(evaluated, original, '经 HTML 解码 + JS 求值应无损还原原文');
  }],

  // ---- E组：源码语法完整性（防 SyntaxError 上线） ----
  ['E1 两页面内联<script>整块语法合法（vm编译不执行）', () => {
    const files = CANDIDATES.filter(f => fs.existsSync(path.join(__dirname, '..', f)));
    assert(files.length > 0, '未找到任何源HTML文件');
    let blocks = 0;
    for (const f of files) {
      const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        blocks++;
        try { new vm.Script(m[1], { filename: f }); }  // 只编译不执行：模板字符串/转义/括号等语法错误在此暴露
        catch (e) { throw new Error(`${f} 内联脚本语法错误: ${e.message}`); }
      }
    }
    assert(blocks >= 1, '未匹配到任何裸<script>块，正则可能需要更新');
  }],

  // ---- F组：身份入口（阶段2 车队登录 + 权限隔离） ----
  ['F1 checkLogin 调度密码888 → 通过', c => {
    assertEqual(c.fn.checkLogin('admin', '888'), true, '调度密码 888 应通过');
  }],
  ['F2 checkLogin 调度密码错误/空 → 拒绝', c => {
    assertEqual(c.fn.checkLogin('admin', '000'), false, '调度密码错误应拒绝');
    assertEqual(c.fn.checkLogin('admin', ''), false, '调度密码为空应拒绝');
  }],
  ['F3 checkLogin 车队密码正确 → 通过（密码唯一反查车队）', c => {
    c.fn.fleetPws = { '一队': '111', '二队': '222', '三队': '' };
    assertEqual(c.fn.checkLogin('fleet', '111'), true, '密码 111 应对应一队并通过');
    assertEqual(c.fn.checkLogin('fleet', '222'), true, '密码 222 应对应二队并通过');
  }],
  ['F4 checkLogin 车队密码不匹配/空/未知角色 → 拒绝', c => {
    c.fn.fleetPws = { '一队': '111', '三队': '' };
    assertEqual(c.fn.checkLogin('fleet', '999'), false, '密码不匹配任何车队应拒绝');
    assertEqual(c.fn.checkLogin('fleet', ''), false, '空密码应拒绝');
    assertEqual(c.fn.checkLogin('guest', '111'), false, '未知角色应拒绝');
  }],
  ['F5 resolveFleetByPwd 密码反查车队名（唯一密码）', c => {
    c.fn.fleetPws = { '一队': '111', '二队': '222', '三队': '333' };
    assertEqual(c.fn.resolveFleetByPwd('111'), '一队', '111 应反查为一队');
    assertEqual(c.fn.resolveFleetByPwd('333'), '三队', '333 应反查为三队');
    assertEqual(c.fn.resolveFleetByPwd('999'), '', '未匹配密码应返回空字符串');
    assertEqual(c.fn.resolveFleetByPwd(''), '', '空密码应返回空字符串');
  }],
  ['F6 doLogin 车队密码正确 → 锁定本车队视图+解除数据模糊', c => {
    c.fn.fleetPws = { '一队': '111' };
    c.fn.loginRole = 'fleet';
    c.el('loginPwd').value = '111';
    c.el('body').classList.add('pre-login'); // 模拟未登录时的数据模糊状态
    c.fn.doLogin();
    assertEqual(c.fn.userRole, 'fleet', '登录后 userRole 应为 fleet');
    assertEqual(c.fn.userFleet, '一队', '登录后 userFleet 应为 一队');
    assertEqual(c.fn.fleetFilter, '一队', '车队筛选应锁定为本车队');
    assert(c.el('fleetFilter').disabled === true, '车队筛选下拉应禁用');
    assert(c.el('body').classList.contains('fleet-view'), 'body 应加 fleet-view 类（隐藏调度功能）');
    assert(!c.el('body').classList.contains('pre-login'), '登录成功应解除 pre-login 数据模糊');
    assert(!c.el('loginOverlay').classList.contains('show'), '登录层应关闭');
    assert(c.el('loginError').style.display === 'none', '不应显示错误提示');
  }],
  ['F7 doLogin 车队密码错误 → 保持登录层，提示错误', c => {
    c.fn.fleetPws = { '一队': '111' };
    c.fn.loginRole = 'fleet';
    c.el('loginPwd').value = '000';
    c.fn.doLogin();
    assertEqual(c.fn.userRole, null, '密码错误不应进入');
    assert(c.el('loginError').style.display === 'block', '应显示错误提示');
    assert(c.el('loginPwd').value === '', '错误后密码框应清空');
  }],
  ['F8 canEditField 车队视图 → 仅 车号/司机/司机电话 可编辑', c => {
    c.fn.userRole = 'fleet';
    assertEqual(c.fn.canEditField('车号'), true, '车队可编辑 车号');
    assertEqual(c.fn.canEditField('司机'), true, '车队可编辑 司机');
    assertEqual(c.fn.canEditField('司机电话'), true, '车队可编辑 司机电话');
    assertEqual(c.fn.canEditField('派单情况'), false, '车队不可改 派单情况');
    assertEqual(c.fn.canEditField('是否结算'), false, '车队不可改 是否结算');
  }],
  ['F9 canEditField 调度视图 → 任意字段可编辑', c => {
    c.fn.userRole = 'admin';
    assertEqual(c.fn.canEditField('派单情况'), true, '调度可改 派单情况');
    assertEqual(c.fn.canEditField('是否结算'), true, '调度可改 是否结算');
    assertEqual(c.fn.canEditField('司机'), true, '调度可改 司机');
  }],
  ['F10 车队视图调用 addFleet → 被权限守卫拦截', c => {
    c.fn.userRole = 'fleet';
    c.el('newFleetName').value = '四队';
    c.fn.addFleet();
    assertEqual(c.state.inserts.length, 0, '车队视图不应能添加车队');
    assert(!isPwdOpen(c), '车队视图不应弹操作密码框');
    assertEqual(c.state.loadFleetsCalls.n, 0, '不应刷新车队列表');
  }],

  // ---- G组：批量分配车队（阶段2，仅调度） ----
  ['G1 未勾选订单 → alert拦截，不弹选择窗', c => {
    c.state.selectedNos = [];
    c.fn.openBatchFleet();
    assert(c.state.alerts.some(m => m.includes('勾选')), '未勾选应 alert 提示');
    assert(!c.el('batchFleetOverlay').classList.contains('show'), '不应弹批量分配窗');
  }],
  ['G2 无车队可用 → alert拦截', c => {
    c.state.selectedNos = ['YD001'];
    c.fn.fleets = [];
    c.fn.openBatchFleet();
    assert(c.state.alerts.some(m => m.includes('车队管理')), '无车队应提示先去车队管理添加');
    assert(!c.el('batchFleetOverlay').classList.contains('show'), '不应弹批量分配窗');
  }],
  ['G3 勾选+有车队 → 弹窗展示数量和车队选项+取消分配', c => {
    c.state.selectedNos = ['YD001', 'YD002'];
    c.fn.openBatchFleet();
    assert(c.el('batchFleetOverlay').classList.contains('show'), '应弹批量分配窗');
    assert(c.el('batchFleetInfo').textContent.includes('2'), '信息栏应显示勾选数量');
    const html = c.el('batchFleetOptions').innerHTML;
    assert(html.includes('一队') && html.includes('三队'), '选项应含所有车队');
    assert(html.includes('取消分配'), '应有取消分配选项');
  }],
  ['G4 doBatchAssign 成功 → 批量更新车队字段+成功提示+刷新', c => {
    c.state.selectedNos = ['YD001', 'WD004'];
    c.fn.getSupabase = () => ({
      from: t => {
        if (t !== 'orders') throw new Error('本用例只应访问 orders 表: ' + t);
        return {
          update: patch => ({
            in: (col, vals) => ({ then: cb => {
              c.state.updates.push({ patch, col, vals });
              cb({ error: null });
            }})
          })
        };
      }
    });
    c.fn.doBatchAssign('二队');
    assertEqual(c.state.updates.length, 1, '应调用一次批量更新');
    assertEqual(c.state.updates[0].patch, { 车队: '二队' }, '应更新车队字段');
    assertEqual(c.state.updates[0].col, '订单号', '应按订单号过滤');
    assertEqual(c.state.updates[0].vals, ['YD001', 'WD004'], '应只更新勾选的订单');
    assert(!c.el('batchFleetOverlay').classList.contains('show'), '完成后应关闭弹窗');
    assert(c.state.successes.some(m => m.includes('2 条') && m.includes('二队')), '应显示成功提示');
  }],
  ['G5 车队视图 → openBatchFleet/doBatchAssign 均被守卫拦截', c => {
    c.fn.userRole = 'fleet';
    c.state.selectedNos = ['YD001'];
    c.fn.openBatchFleet();
    assert(!c.el('batchFleetOverlay').classList.contains('show'), '车队视图不应弹批量分配窗');
    c.fn.getSupabase = () => { throw new Error('车队视图不应触达数据库'); };
    c.fn.doBatchAssign('二队');
    assertEqual(c.state.updates.length, 0, '车队视图不应执行批量更新');
  }]
];

// ============ 5. 运行 ============
let passed = 0, failed = 0;
for (const [name, body] of TESTS) {
  try {
    body(makeCtx());
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
console.log(`\n车队密码流程测试：${passed}/${TESTS.length} 通过${failed ? '，❌ ' + failed + ' 项失败' : '，✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
