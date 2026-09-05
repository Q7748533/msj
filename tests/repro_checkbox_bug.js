/**
 * 回归测试：勾选状态持久化（修复验证）· Node 零依赖版（供 CI 使用）
 *
 * 修复内容：勾选状态写入全局 Set（selectedOrderNos），renderTable 重渲染后自动恢复；
 * 表头全选框随当前页勾选状态联动；订单被删后 Set 自动清理；跨页勾选计入批量操作。
 *
 * 原理：从源 HTML 文件直接提取被测函数（renderTable/getFilteredOrders/sortOrders/
 * loadOrders/setupRealtime/toggleSelectAll/onRowCheckChange/getSelectedOrderNos/
 * esc/escJs），在 vm 沙箱中配合 DOM/数据库替身执行——测试真实源码，杜绝漂移。
 *
 * 运行：node tests/repro_checkbox_bug.js   （失败时退出码 1，CI 据此拦截）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ============ 1. 定位源文件（优先正式页面；功能未合并时回退测试页面） ============
const CANDIDATES = ['index.html', 'index_test.html'];
const FN_NAMES = ['renderTable', 'getFilteredOrders', 'sortOrders', 'loadOrders',
  'setupRealtime', 'toggleSelectAll', 'onRowCheckChange', 'getSelectedOrderNos', 'esc', 'escJs'];

function pickSource() {
  for (const f of CANDIDATES) {
    const p = path.join(__dirname, '..', f);
    if (fs.existsSync(p)) {
      const html = fs.readFileSync(p, 'utf8');
      if (html.includes('function renderTable') && html.includes('selectedOrderNos')) {
        console.log(`测试目标: ${f}`);
        return html;
      }
    }
  }
  console.error('❌ 未找到包含勾选持久化代码的 HTML 文件（index.html / index_test.html）');
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
// 前置声明被提取函数引用的全局变量（源文件中为 let/const，沙箱中用 var 等价初始化为初值）
const PRELUDE = `var orders = [], filterStatus = 'all', fleetFilter = 'all', searchTerm = '', currentPage = 1;
var isEditing = false;
var selectedOrderNos = new Set();
var PAGE_SIZE = 100;
var COLUMNS = ['订单号', '车队', '派单情况', '是否结算', '预订车型', '服务类型', '服务城市', '服务日期', '航班号', '上车点', '下车点', '车号', '司机', '司机电话', '服务标准', '举牌服务'];
var SEARCH_FIELDS = ['订单号', '车队', '司机', '车号', '司机电话', '上车点', '下车点', '服务类型'];`;
const EXTRACTED_CODE = [PRELUDE, ...FN_NAMES.map(n => extractFunction(HTML, n))].join('\n');

// ============ 2. 沙箱工厂：每个用例全新环境（DOM 替身 + mock 数据库） ============
const MOCK_DB = [
  { id: 1, 订单号: 'YD001', 车队: '一队', 派单情况: '未派', 是否结算: '否', 服务日期: '2026-09-05 08:00:00' },
  { id: 2, 订单号: 'YD002', 车队: '',     派单情况: '未派', 是否结算: '否', 服务日期: '2026-09-05 09:00:00' },
  { id: 3, 订单号: 'YD003', 车队: '二队', 派单情况: '已派', 是否结算: '是', 服务日期: '2026-09-05 10:00:00' }
];

function makeCtx() {
  const state = {
    checkboxes: [],       // 当前 DOM 中的行 checkbox（含 checked 状态）
    selectAllChecked: false, // 表头全选框渲染状态
    realtimeCbs: [],      // orders 表 realtime 回调
    db: MOCK_DB.map(o => ({ ...o })), // 可变数据库替身（用例可增删订单）
    renderCount: 0
  };

  // tableArea 容器：innerHTML 赋值 = 浏览器行为（销毁旧 DOM、解析新 HTML）
  // 解析行 checkbox 的 data-no 与 checked 属性、表头全选框的 checked 状态
  const tableArea = {
    scrollLeft: 0,
    set innerHTML(html) {
      state.checkboxes = [];
      state.renderCount++;
      const re = /<input type="checkbox" class="row-check" data-no="([^"]*)"([^>]*)>/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        state.checkboxes.push({ checked: m[2].includes('checked'), getAttribute: k => (k === 'data-no' ? m[1] : null) });
      }
      const h = html.match(/id="selectAll"([^>]*)>/);
      state.selectAllChecked = !!h && h[1].includes('checked');
    },
    get innerHTML() { return ''; },
    querySelector: () => null
  };

  const els = { tableArea };
  function el(id) {
    if (!els[id]) els[id] = { value: '', style: {}, innerHTML: '', textContent: '', scrollLeft: 0, checked: false, classList: { add() {}, remove() {}, contains: () => false } };
    return els[id];
  }

  const sandbox = {
    document: {
      getElementById: el,
      querySelectorAll: sel => {
        if (sel === '.row-check') return [...state.checkboxes];
        if (sel === '.row-check:checked') return state.checkboxes.filter(c => c.checked);
        return [];
      },
      querySelector: () => state.checkboxes[0] || null,
      createElement: () => {  // esc() 用：textContent 存原文，innerHTML 按浏览器规则转义
        let text = '';
        return {
          set textContent(v) { text = String(v); },
          get textContent() { return text; },
          get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
        };
      }
    },
    console: { error: () => {} },
    setTimeout: () => {},
    showToast: () => {}, hideToast: () => {},
    updateSummary: () => {}, checkDriverReady: () => {}, syncHScroll: () => {},
    loadFleets: () => {},
    getSupabase: () => ({
      channel: () => ({
        on: (evt, filter, cb) => {
          if (filter && filter.table === 'orders') state.realtimeCbs.push(cb);
          return { subscribe: () => {} };
        },
        subscribe: () => {}
      }),
      from: () => ({
        select: () => ({
          order: () => ({
            range: () => Promise.resolve({ data: state.db.map(o => ({ ...o })), error: null })
          })
        })
      })
    })
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
const sorted = a => [...a].sort();

// ============ 4. 测试用例 ============
const TESTS = [
  ['R1 基线：渲染 3 条订单 → 全选 → 返回全部订单号', async c => {
    await c.fn.loadOrders();
    assertEqual(c.state.checkboxes.length, 3, '应渲染出 3 个行 checkbox');
    c.fn.toggleSelectAll({ checked: true });
    assertEqual(sorted(c.fn.getSelectedOrderNos()), ['YD001', 'YD002', 'YD003'], '全选后应返回全部订单号');
  }],

  ['R2 修复验证：全选后 renderTable 重渲染 → 勾选全部保留 + 表头仍选中', async c => {
    await c.fn.loadOrders();
    c.fn.toggleSelectAll({ checked: true });
    assertEqual(c.fn.getSelectedOrderNos().length, 3, '前置：全选后应有 3 条勾选');
    c.fn.renderTable();
    assertEqual(sorted(c.fn.getSelectedOrderNos()), ['YD001', 'YD002', 'YD003'], '重渲染后勾选应全部保留');
    assert(c.state.checkboxes.every(cb => cb.checked), '重渲染后 DOM checkbox 应恢复选中');
    assert(c.state.selectAllChecked === true, '表头全选框应保持选中');
  }],

  ['R3 修复验证：手动勾选 2 行 → 重渲染 → 勾选保留 + 表头不选中', async c => {
    await c.fn.loadOrders();
    c.state.checkboxes[0].checked = true;  // 排序后行序 YD003/YD001/YD002
    c.state.checkboxes[2].checked = true;
    assertEqual(sorted(c.fn.getSelectedOrderNos ? c.fn.getSelectedOrderNos() : []), [], '前置占位（DOM勾选未入Set）');
    // 手动勾选路径：逐行触发 onRowCheckChange（同浏览器 onchange）
    c.fn.onRowCheckChange(c.state.checkboxes[0]);
    c.fn.onRowCheckChange(c.state.checkboxes[2]);
    assertEqual(sorted(c.fn.getSelectedOrderNos()), ['YD002', 'YD003'], '前置：手动勾选应有 2 条');
    c.fn.renderTable();
    assertEqual(sorted(c.fn.getSelectedOrderNos()), ['YD002', 'YD003'], '重渲染后手动勾选应保留');
    assert(c.state.checkboxes.filter(cb => cb.checked).length === 2, 'DOM 应恢复这 2 行选中');
    assert(c.state.selectAllChecked === false, '部分勾选时表头全选框应不选中');
  }],

  ['R4 修复验证：完整链路 realtime 变更 → loadOrders → 勾选保留', async c => {
    await c.fn.loadOrders();
    c.fn.setupRealtime();
    assertEqual(c.state.realtimeCbs.length, 1, '应注册 1 个 orders 表回调');
    c.fn.toggleSelectAll({ checked: true });
    assertEqual(c.fn.getSelectedOrderNos().length, 3, '前置：全选后应有 3 条勾选');
    await Promise.resolve(c.state.realtimeCbs[0]());  // 模拟 realtime 事件
    assertEqual(sorted(c.fn.getSelectedOrderNos()), ['YD001', 'YD002', 'YD003'], 'realtime 刷新后勾选应全部保留');
    assert(c.state.checkboxes.every(cb => cb.checked), 'DOM 应全部选中');
  }],

  ['R5 边界：isEditing=true（编辑单元格中）realtime 被跳过，勾选保留', async c => {
    await c.fn.loadOrders();
    c.fn.setupRealtime();
    c.fn.toggleSelectAll({ checked: true });
    c.fn.isEditing = true;
    await Promise.resolve(c.state.realtimeCbs[0]());
    assertEqual(c.fn.getSelectedOrderNos().length, 3, '编辑中勾选应保留');
    assertEqual(c.state.renderCount, 1, '编辑中不应触发重渲染');
    c.fn.isEditing = false;
  }],

  ['R6 新增联动：全选后取消一行 → 表头全选框自动取消', async c => {
    await c.fn.loadOrders();
    c.fn.toggleSelectAll({ checked: true });
    c.state.checkboxes[1].checked = false;  // 模拟取消第 2 行
    c.fn.onRowCheckChange(c.state.checkboxes[1]);
    assertEqual(c.el('selectAll').checked, false, '取消一行后表头全选框应取消选中');
    assertEqual(c.fn.getSelectedOrderNos().length, 2, 'Set 应剩 2 条');
  }],

  ['R7 新增清理：勾选的订单被删除 → Set 自动清理', async c => {
    await c.fn.loadOrders();
    c.fn.toggleSelectAll({ checked: true });
    assertEqual(c.fn.getSelectedOrderNos().length, 3, '前置：全选 3 条');
    c.state.db = c.state.db.filter(o => o['订单号'] !== 'YD002');  // 模拟 YD002 被删除
    await c.fn.loadOrders();
    assertEqual(sorted(c.fn.getSelectedOrderNos()), ['YD001', 'YD003'], '被删订单应从勾选中清理');
    assertEqual(c.state.checkboxes.length, 2, 'DOM 只剩 2 行');
  }],

  ['R8 新增跨页：翻页后勾选保留，表头状态随当前页正确显示', async c => {
    await c.fn.loadOrders();
    c.fn.PAGE_SIZE = 2;   // 3 条订单分 2 页（第 1 页 YD003/YD001，第 2 页 YD002）
    c.fn.currentPage = 1;
    c.fn.renderTable();
    assertEqual(c.state.checkboxes.length, 2, '第 1 页应渲染 2 行');
    c.fn.toggleSelectAll({ checked: true });
    assertEqual(sorted(c.fn.getSelectedOrderNos()), ['YD001', 'YD003'], '第 1 页全选应入选 2 条');
    c.fn.currentPage = 2;
    c.fn.renderTable();
    assertEqual(c.state.checkboxes.length, 1, '第 2 页应渲染 1 行');
    assert(c.state.checkboxes[0].checked === false, '第 2 页行未勾选');
    assert(c.state.selectAllChecked === false, '第 2 页未全选，表头应不选中');
    c.state.checkboxes[0].checked = true;  // 模拟勾选第 2 页唯一一行
    c.fn.onRowCheckChange(c.state.checkboxes[0]);
    assertEqual(sorted(c.fn.getSelectedOrderNos()), ['YD001', 'YD002', 'YD003'], '跨页勾选应累计 3 条');
    assertEqual(c.el('selectAll').checked, true, '第 2 页全选后表头应选中');
  }]
];

// ============ 5. 运行 ============
(async () => {
  console.log('回归测试：勾选状态持久化（修复验证）\n');
  let passed = 0, failed = 0;
  for (const [name, body] of TESTS) {
    try {
      await body(makeCtx());
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${e.message}`);
    }
  }
  console.log(`\n勾选持久化回归测试：${passed}/${TESTS.length} 通过${failed ? '，❌ ' + failed + ' 项失败' : '，✅ 全部通过'}`);
  process.exit(failed ? 1 : 0);
})();
