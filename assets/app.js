(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const results = $('results');
  const count = $('result-count');
  const search = $('search');
  const source = $('source');
  const resultsTitle = $('results-title');
  const pagination = $('search-pagination');
  const numberFormat = new Intl.NumberFormat('zh-CN');
  const pageSize = 30;
  const dayRequests = new Map();
  let dateCounts = new Map();
  let dates = [];
  let currentDate = '';
  let currentPapers = null;
  let dailyLoadFailed = false;
  let requestNumber = 0;
  let archivePapers = null;
  let loadingArchive = false;
  let archiveLoadFailed = false;
  let searchPage = 1;
  let view = 'day';
  let scopeYear = 0;
  let scopeMonth = 0;

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }

  function dateLabel(value) {
    const [year, month, day] = value.split('-');
    return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
  }

  function setMessage(text, isError = false) {
    const message = document.createElement('div');
    message.className = `message${isError ? ' error' : ''}`;
    message.textContent = text;
    results.replaceChildren(message);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderHeatmap() {
    if (!scopeYear || !scopeMonth) return;
    const today = new Date().toISOString().slice(0, 10);
    const yearPrefix = String(scopeYear);
    const monthPrefix = `${yearPrefix}-${String(scopeMonth).padStart(2, '0')}`;
    const yearly = new Map();
    const monthly = new Map();
    for (const [day, value] of dateCounts) {
      if (day > today) continue;
      const year = day.slice(0, 4);
      const month = day.slice(0, 7);
      yearly.set(year, (yearly.get(year) || 0) + value);
      monthly.set(month, (monthly.get(month) || 0) + value);
    }
    for (const granularity of ['year', 'month', 'day']) {
      $('view-' + granularity).setAttribute('aria-pressed', String(view === granularity));
    }
    $('heatmap-weekdays').hidden = view !== 'day';
    const grid = $('heatmap-grid');
    grid.className = `heatmap-grid ${view}-grid`;
    let cells = [];
    if (view === 'year') {
      cells = [...yearly.keys()].sort().map((year) => ({ key: year, label: `${year} 年`, count: yearly.get(year), active: year === yearPrefix }));
      $('heatmap-period').textContent = '所有归档年份';
      $('heatmap-context').textContent = '各年份论文发布总量';
      $('heatmap-hint').textContent = '选择年份查看各月';
    } else if (view === 'month') {
      cells = Array.from({ length: 12 }, (_, i) => {
        const key = `${yearPrefix}-${String(i + 1).padStart(2, '0')}`;
        return { key, label: `${i + 1} 月`, count: monthly.get(key) || 0, future: key > today.slice(0, 7), active: key === monthPrefix };
      });
      $('heatmap-period').textContent = `${scopeYear} 年 · ${numberFormat.format(yearly.get(yearPrefix) || 0)} 篇`;
      $('heatmap-context').textContent = '当前年份各月份论文发布量';
      $('heatmap-hint').textContent = '选择月份查看每日';
    } else {
      const daysInMonth = new Date(Date.UTC(scopeYear, scopeMonth, 0)).getUTCDate();
      cells = Array.from({ length: daysInMonth }, (_, i) => {
        const key = `${monthPrefix}-${String(i + 1).padStart(2, '0')}`;
        return { key, label: String(i + 1), count: dateCounts.get(key) || 0, future: key > today, active: key === currentDate };
      });
      $('heatmap-period').textContent = `${scopeYear} 年 ${scopeMonth} 月 · ${numberFormat.format(monthly.get(monthPrefix) || 0)} 篇`;
      $('heatmap-context').textContent = '当前月份每日论文发布量';
      $('heatmap-hint').textContent = '选择日期查看当天论文';
    }
    const max = Math.max(0, ...cells.filter((cell) => !cell.future).map((cell) => cell.count));
    const nodes = [];
    if (view === 'day') {
      const weekday = new Date(Date.UTC(scopeYear, scopeMonth - 1, 1)).getUTCDay();
      const leading = (weekday + 6) % 7;
      for (let i = 0; i < leading; i++) {
        const spacer = element('span', 'heat-spacer');
        spacer.setAttribute('aria-hidden', 'true');
        nodes.push(spacer);
      }
    }
    for (const cell of cells) {
      const level = cell.count && max ? Math.max(1, Math.ceil(cell.count / max * 4)) : 0;
      const button = element('button', `heat-cell level-${level}${cell.active ? ' active' : ''}${cell.future ? ' future' : ''}`);
      button.type = 'button';
      button.disabled = !!cell.future;
      button.dataset.value = cell.key;
      button.setAttribute('aria-label', cell.future ? `${cell.label}，未来日期` : `${cell.label}，${numberFormat.format(cell.count)} 篇论文`);
      button.setAttribute('aria-pressed', String(!!cell.active));
      button.append(element('span', 'heat-label', cell.label), element('strong', 'heat-count', cell.future ? '' : numberFormat.format(cell.count)));
      button.addEventListener('click', () => {
        if (view === 'year') {
          scopeYear = Number(cell.key);
          if (scopeYear === Number(today.slice(0, 4))) scopeMonth = Math.min(scopeMonth, Number(today.slice(5, 7)));
          view = 'month';
          renderHeatmap();
        } else if (view === 'month') {
          scopeMonth = Number(cell.key.slice(5, 7));
          view = 'day';
          renderHeatmap();
        } else {
          selectDate(cell.key);
        }
      });
      nodes.push(button);
    }
    grid.replaceChildren(...nodes);
  }

  async function fetchPapers(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const papers = await response.json();
    if (!Array.isArray(papers)) throw new Error('Invalid data');
    return papers;
  }

  function loadDay(day) {
    if (!dayRequests.has(day)) {
      const request = fetchPapers(`data/days/${day}.json`).catch((error) => {
        dayRequests.delete(day);
        throw error;
      });
      dayRequests.set(day, request);
    }
    return dayRequests.get(day);
  }

  function normalizeSearchText(text) {
    return text.normalize('NFC').toLowerCase();
  }

  async function loadArchive() {
    loadingArchive = true;
    try {
      const papers = await fetchPapers('data/search.json');
      archivePapers = papers.map((paper) => ({
        ...paper,
        searchText: normalizeSearchText(`${paper.title} ${(paper.authors || []).join(' ')}`),
      }));
    } catch (error) {
      archiveLoadFailed = true;
      console.error('Unable to load search index:', error);
    } finally {
      loadingArchive = false;
    }
    if (search.value.trim()) renderPapers();
  }

  function paperCard(paper, index, fromSearch) {
    const article = element('article', 'paper');
    const ordinal = element('div', 'paper-number', String(index + 1).padStart(2, '0'));
    ordinal.setAttribute('aria-hidden', 'true');
    const content = element('div', 'paper-content');
    const meta = element('div', 'paper-top');
    meta.append(element('span', `badge${paper.source === 'Preprints.org' ? ' preprints' : ''}`, paper.source), element('span', 'paper-date', paper.date));
    const heading = element('h4', 'paper-title');
    try {
      const url = new URL(paper.url);
      if (url.protocol !== 'https:') throw new Error('Invalid link');
      const link = element('a', '', paper.title);
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const external = element('span', 'external', '↗');
      external.setAttribute('aria-hidden', 'true');
      link.append(external);
      heading.append(link);
    } catch (_) {
      heading.textContent = paper.title;
    }
    const authors = element('p', 'authors', (paper.authors || []).join(', ') || '作者信息未提供');
    const details = element('details');
    const emptyAbstract = '来源未提供摘要。';
    const abstract = element('p', 'abstract', fromSearch ? '' : (paper.abstract || emptyAbstract));
    details.append(element('summary', '', '查看摘要'), abstract);
    if (fromSearch) {
      let loading = false;
      async function showAbstract() {
        if (!details.open || loading) return;
        loading = true;
        abstract.textContent = '正在加载摘要…';
        try {
          const dailyPapers = await loadDay(paper.date);
          const record = dailyPapers.find((item) => item.id === paper.id);
          if (!record) throw new Error('Paper missing from daily data');
          abstract.textContent = record.abstract || emptyAbstract;
          details.removeEventListener('toggle', showAbstract);
        } catch (error) {
          abstract.textContent = '摘要加载失败，请收起后重新展开。';
          console.error('Unable to load abstract:', error);
        } finally {
          loading = false;
        }
      }
      details.addEventListener('toggle', showAbstract);
    }
    content.append(meta, heading, authors, details);
    article.append(ordinal, content);
    return article;
  }

  function renderPapers() {
    if (!currentDate) return;
    const term = normalizeSearchText(search.value.trim());
    const fromSearch = Boolean(term);
    resultsTitle.textContent = fromSearch ? '全部历史检索' : dateLabel(currentDate);
    $('result-scope').textContent = fromSearch ? 'SEARCH RESULTS' : 'SELECTED DATE';
    pagination.hidden = true;

    const papers = fromSearch ? archivePapers : currentPapers;
    if (!papers) {
      count.textContent = '—';
      if (fromSearch) {
        if (archiveLoadFailed) {
          setMessage('历史索引加载失败，请重新输入关键词后重试。', true);
        } else {
          setMessage('正在加载历史索引…');
          if (!loadingArchive) loadArchive();
        }
      } else if (dailyLoadFailed) {
        setMessage('当日数据加载失败，请刷新页面后重试。', true);
      } else {
        setMessage('正在加载当日论文…');
      }
      return;
    }

    const selectedSource = source.value;
    const matches = papers.filter((paper) =>
      (selectedSource === 'all' || paper.source === selectedSource) &&
      (!fromSearch || paper.searchText.includes(term))
    );
    count.textContent = numberFormat.format(matches.length);
    if (!matches.length) {
      if (fromSearch) setMessage('历史归档中没有符合条件的论文。试试其他关键词或来源。');
      else if (!papers.length) setMessage('这一天暂无收录论文。试试选择其他日期。');
      else setMessage('这一天没有所选来源的论文。');
      return;
    }

    const pageCount = fromSearch ? Math.ceil(matches.length / pageSize) : 1;
    const first = fromSearch ? (searchPage - 1) * pageSize : 0;
    const visible = fromSearch ? matches.slice(first, first + pageSize) : matches;
    results.replaceChildren(...visible.map((paper, index) => paperCard(paper, first + index, fromSearch)));
    if (pageCount === 1) return;
    $('search-page').textContent = `第 ${numberFormat.format(searchPage)} / ${numberFormat.format(pageCount)} 页`;
    $('search-prev').disabled = searchPage === 1;
    $('search-next').disabled = searchPage === pageCount;
    pagination.hidden = false;
  }

  async function selectDate(day, updateUrl = true) {
    if (!validDate(day)) return;
    currentDate = day;
    scopeYear = Number(day.slice(0, 4));
    scopeMonth = Number(day.slice(5, 7));
    renderHeatmap();
    if (updateUrl) {
      search.value = '';
      const url = new URL(window.location.href);
      url.searchParams.set('date', day);
      window.history.pushState({}, '', url);
    }
    const thisRequest = ++requestNumber;
    const hasPapers = dateCounts.has(day);
    dailyLoadFailed = false;
    currentPapers = hasPapers ? null : [];
    renderPapers();
    if (!hasPapers) return;
    try {
      const papers = await loadDay(day);
      if (thisRequest !== requestNumber) return;
      currentPapers = papers;
    } catch (error) {
      if (thisRequest !== requestNumber) return;
      dailyLoadFailed = true;
      console.error('Unable to load daily data:', error);
    }
    if (!search.value.trim()) renderPapers();
  }

  async function init() {
    try {
      const response = await fetch('data/index.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const index = await response.json();
      if (!Array.isArray(index.days)) throw new Error('Invalid date index');
      const today = new Date().toISOString().slice(0, 10);
      dates = index.days.map((day) => day.date).filter((day) => validDate(day) && day <= today).sort().reverse();
      dateCounts = new Map(index.days.map((day) => [day.date, day.count]));
      $('total-count').textContent = numberFormat.format(index.total);
      if (!dates.length) {
        resultsTitle.textContent = '暂无归档';
        count.textContent = '0';
        setMessage('尚无论文数据。运行采集脚本后即可浏览。');
        return;
      }
      $('date-span').textContent = `${dates[dates.length - 1].slice(0, 4)} — ${dates[0].slice(0, 4)}`;
      const requested = new URL(window.location.href).searchParams.get('date');
      await selectDate(requested && validDate(requested) && requested <= today ? requested : dates[0], false);
    } catch (error) {
      resultsTitle.textContent = '加载失败';
      setMessage('日期索引加载失败，请确认通过 HTTP 服务访问并刷新页面。', true);
      console.error('Unable to load date index:', error);
    }
  }

  for (const granularity of ['year', 'month', 'day']) {
    $('view-' + granularity).addEventListener('click', () => { view = granularity; renderHeatmap(); });
  }
  search.addEventListener('input', () => {
    searchPage = 1;
    archiveLoadFailed = false;
    renderPapers();
  });
  source.addEventListener('change', () => {
    searchPage = 1;
    renderPapers();
  });
  function changeSearchPage(offset) {
    searchPage += offset;
    renderPapers();
    resultsTitle.focus();
  }
  $('search-prev').addEventListener('click', () => changeSearchPage(-1));
  $('search-next').addEventListener('click', () => changeSearchPage(1));
  window.addEventListener('popstate', () => {
    const requested = new URL(window.location.href).searchParams.get('date');
    const today = new Date().toISOString().slice(0, 10);
    search.value = '';
    if (dates.length) selectDate(requested && validDate(requested) && requested <= today ? requested : dates[0], false);
  });
  init();
})();
