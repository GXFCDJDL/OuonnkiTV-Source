const fs = require("fs");
const path = require("path");
const axios = require("axios");
const Table = require("cli-table3");
const appConfig = require("../config.js");

const CONFIG_PATH = path.join(__dirname, "..", "tv_source", "LunaTV", "LunaTV-processed.json");
const OUTPUT_PATH = path.join(__dirname, "..", "tv_source", "LunaTV", "LunaTV-check-result.json");

const CONFIG = {
  timeout: appConfig.check.timeout,
  concurrent: appConfig.check.concurrent,
  maxRetry: appConfig.check.maxRetry,
  retryDelay: appConfig.check.retryDelay,
  keyword: appConfig.check.keyword,
  adultKeyword: appConfig.check.adultKeyword,
  headers: appConfig.check.headers,
  useProxy: appConfig.proxy.url && appConfig.proxy.check,
  proxyUrl: appConfig.proxy.url,
};

function getProxiedUrl(apiUrl) {
  if (!CONFIG.useProxy) return apiUrl;
  return `${CONFIG.proxyUrl}/${apiUrl}`;
}

const SEARCH_STATUS = {
  SUCCESS: "success",
  NO_RESULTS: "no_results",
  MISMATCH: "mismatch",
  FAILED: "failed",
};

// 状态图标
const STATUS_ICONS = {
  [SEARCH_STATUS.SUCCESS]: "✓",
  [SEARCH_STATUS.NO_RESULTS]: "○",
  [SEARCH_STATUS.MISMATCH]: "○",
  [SEARCH_STATUS.FAILED]: "✗",
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 清行并移动光标到行首
function clearLine() {
  process.stdout.write("\r\x1b[K");
}

// 格式化时长
function formatDuration(ms) {
  if (ms === null) return "----";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// 截断URL
function truncateUrl(url, maxLen) {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 3) + "...";
}

async function checkSource(api, keyword) {
  for (let i = 1; i <= CONFIG.maxRetry; i++) {
    const startTime = Date.now();
    try {
      const res = await axios.get(`${api}?wd=${encodeURIComponent(keyword)}`, {
        timeout: CONFIG.timeout,
        headers: CONFIG.headers,
      });

      const duration = Date.now() - startTime;
      const list = res.data?.list || [];

      if (!list.length) {
        return { status: SEARCH_STATUS.NO_RESULTS, duration };
      }

      const isMatch = list.some((item) => JSON.stringify(item).includes(keyword));
      return {
        status: isMatch ? SEARCH_STATUS.SUCCESS : SEARCH_STATUS.MISMATCH,
        duration,
      };
    } catch {
      if (i < CONFIG.maxRetry) await delay(CONFIG.retryDelay);
    }
  }

  return { status: SEARCH_STATUS.FAILED, duration: null };
}

async function runWithLimit(tasks, limit, onProgress) {
  const results = new Array(tasks.length);
  let completed = 0;
  let index = 0;

  async function runNext() {
    const i = index++;
    if (i >= tasks.length) return;

    const r = await tasks[i]();
    results[i] = r;
    completed++;
    onProgress(i, r, completed, tasks.length);
    await runNext();
  }

  const workers = Array(Math.min(limit, tasks.length)).fill().map(runNext);
  await Promise.all(workers);
  return results;
}

(async () => {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("[Error] 配置文件不存在:", CONFIG_PATH);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const sources = Object.values(config.api_site || {}).map((s) => ({
    id: s.id,
    name: s.name,
    api: s.api,
    isAdult: s.isAdult || false,
  }));

  console.log(CONFIG.useProxy ? `[Proxy] 代理已开启: ${CONFIG.proxyUrl}\n` : `[Proxy] 代理已关闭\n`);
  console.log(`[Info] 共加载 ${sources.length} 个视频源，开始检测...\n`);

  const startTime = Date.now();
  const tasks = sources.map((s) => async () => {
    const proxiedApi = getProxiedUrl(s.api);
    const keyword = s.isAdult ? CONFIG.adultKeyword || CONFIG.keyword : CONFIG.keyword;
    const result = await checkSource(proxiedApi, keyword);
    return {
      id: s.id,
      name: s.name,
      api: s.api,
      isAdult: s.isAdult,
      searchStatus: result.status,
      searchDuration: result.duration,
      useProxy: CONFIG.useProxy,
    };
  });

  // 实时显示进度
  const results = await runWithLimit(tasks, CONFIG.concurrent, (i, r, completed, total) => {
    const percent = Math.round((completed / total) * 100);
    const bar = "█".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5));
    const icon = STATUS_ICONS[r.searchStatus] || "?";
    const durationStr = formatDuration(r.searchDuration);

    clearLine();
    process.stdout.write(`[${bar}] ${percent}% (${completed}/${total}) ${icon} ${sources[i].name} ${durationStr}`);
  });

  clearLine();

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const accessible = results.filter((r) => r.searchStatus !== SEARCH_STATUS.FAILED).length;
  const searchOk = results.filter((r) => r.searchStatus === SEARCH_STATUS.SUCCESS).length;

  // 使用 cli-table3 输出结果表格
  console.log("\n检测结果:\n");

  const table = new Table({
    head: ["序号", "名称", "状态", "耗时", "URL"],
    colWidths: [6, 16, 14, 8],
    style: {
      head: ["cyan"],
      border: ["gray"],
    },
  });

  results.forEach((r, i) => {
    const icon = STATUS_ICONS[r.searchStatus] || "?";
    const statusText = `${icon} ${r.searchStatus}`;
    const durationStr = formatDuration(r.searchDuration);

    table.push([i + 1, r.name, statusText, durationStr, r.api]);
  });

  console.log(table.toString());

  const formattedDate = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const result = {
    date: formattedDate,
    keyword: CONFIG.keyword,
    adultKeyword: CONFIG.adultKeyword,
    useProxy: CONFIG.useProxy,
    proxyUrl: CONFIG.proxyUrl,
    duration: `${duration}s`,
    stats: {
      total: sources.length,
      accessible: accessible,
      searchOk: searchOk,
    },
    results,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), "utf-8");

  console.log(`\n[Done] ${sources.length} sources | ${accessible} accessible | ${searchOk} search ok | ${duration}s`);
  console.log(`[Info] 检测结果已保存: ${OUTPUT_PATH}`);
})();
